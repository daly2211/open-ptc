/**
 * SandboxOrchestrator — Manages the lifecycle of code_executor sandbox sessions.
 *
 * Responsibilities:
 * - Execute sandbox code and race against tool-call interrupts
 * - Handle chaining (LLM → sandbox → LLM → sandbox → …)
 * - Resume a sandbox after the client fulfils a runtime tool call
 * - Cleanup sessions & resolvers
 */

import { ToolBridge } from "@/bridge/tool-bridge.ts";
import { CodeExecutionEngine } from "@/execution/sandbox-executor.ts";
import { LlmClient } from "./llm-client.ts";
import { sessions, callToSession } from "./session-store.ts";
import { log } from "./proxy-logger.ts";
import type { ProxyTool, ToolCallEvent } from "./types.ts";

const MAX_CHAIN_DEPTH = 10;
const TOOL_CALL_BATCH_WINDOW_MS = parseInt(Deno.env.get("TOOL_CALL_BATCH_WINDOW_MS") || "10");

// --- Parameter types ---

export interface ExecuteSandboxParams {
    codeCall: any;
    runtimeTools: ProxyTool[];
    llmResult: any;
    originalInput: any[];
    pendingExecutors: any[];
    executorOutputs: any[];
    tools: any[];
    chainDepth?: number;
    requestParams?: Record<string, unknown>;
    chainOutputs?: any[];
    reqHeaders: Headers;
}

export interface ResumeAfterToolResultParams {
    toolResults: Array<{ call_id: string; output?: string; error?: string }>;
    cleanInput: any[];
    model?: string;
    tools?: any[];
    requestParams?: Record<string, unknown>;
    reqHeaders: Headers;
}

// --- Orchestrator ---

export class SandboxOrchestrator {
    private toolCallWaiters = new Map<string, () => void>();
    private toolCallQueues = new Map<string, ToolCallEvent[]>();
    private executionPromises = new Map<string, Promise<{ success: boolean; output: string }>>();

    constructor(
        private toolBridge: ToolBridge,
        private codeExecutor: CodeExecutionEngine,
        private llmClient: LlmClient,
    ) {
        // Wire up the tool-bridge callback so that sandbox tool calls get resolved
        this.toolBridge.configureApiMode((callId: string, toolName: string, args: unknown, sessionId: string) => {
            const queue = this.toolCallQueues.get(sessionId) || [];
            queue.push({ callId, toolName, args });
            this.toolCallQueues.set(sessionId, queue);

            const waiter = this.toolCallWaiters.get(sessionId);
            if (waiter) {
                this.toolCallWaiters.delete(sessionId);
                waiter();
            }
        });
    }

    // --- Execute a sandbox session ---

    async execute(params: ExecuteSandboxParams): Promise<any> {
        const {
            codeCall,
            runtimeTools,
            llmResult,
            originalInput,
            pendingExecutors,
            executorOutputs,
            tools,
            chainDepth = 0,
            requestParams = {},
            chainOutputs = [],
            reqHeaders,
        } = params;

        const sessionId = codeCall.call_id;

        // Guard against runaway chains
        if (chainDepth >= MAX_CHAIN_DEPTH) {
            log.warn("Max chain depth reached (" + MAX_CHAIN_DEPTH + "), returning last LLM response");
            const response = { ...llmResult, output: [...chainOutputs, ...(llmResult.output || [])], status: llmResult.status || "completed" };
            log.trace("-> client (max depth):", response);
            return response;
        }

        const { code } = JSON.parse(codeCall.arguments);

        // Set up session & tool bridge
        const session = sessions.create(sessionId, runtimeTools);
        session.pendingExecutors = pendingExecutors;
        session.executorOutputs = executorOutputs;
        session.chainOutputs = [...chainOutputs, ...(llmResult.output || [])];
        this.toolBridge.registerApiTools(sessionId, runtimeTools);

        // Start sandbox execution
        const execPromise = this.codeExecutor.executeCodeForApiSession(code, sessionId, runtimeTools);
        this.executionPromises.set(sessionId, execPromise);

        // Race: sandbox completes vs. sandbox calls a runtime tool
        const raceResult = await this.raceExecution(sessionId, execPromise);

        // --- Tool-call interrupt ---
        if (raceResult.type === "tool_calls") {
            return this.buildToolCallResponse(raceResult.events, codeCall, llmResult, chainOutputs);
        }

        // --- Sandbox completed ---
        const sandboxOutput = raceResult.result.output;
        log.info("Sandbox completed, output length:", sandboxOutput?.length);
        log.trace("Sandbox output:", sandboxOutput?.slice(0, 200));

        const currentOutput = {
            type: "function_call_output",
            call_id: codeCall.call_id,
            output: sandboxOutput,
        };

        const allOutputs = [...executorOutputs, currentOutput];

        // Process remaining parallel executors
        const remainingExecutors = pendingExecutors.filter((e: any) => e.call_id !== codeCall.call_id);
        if (remainingExecutors.length > 0) {
            log.debug("More executors pending:", remainingExecutors.length);
            this.cleanup(sessionId);
            return this.execute({
                ...params,
                codeCall: remainingExecutors[0],
                pendingExecutors: remainingExecutors,
                executorOutputs: allOutputs,
            });
        }

        this.cleanup(sessionId);

        // All items from this step's LLM response (messages, reasoning, ce_calls)
        const intermediateItems = llmResult.output || [];

        // If the LLM also requested normal (non-code_executor) tool calls,
        // return them to the client alongside the sandbox results.
        const normalFunctionCalls = intermediateItems.filter(
            (o: any) => o.type === "function_call" && o.name !== "code_executor"
        );

        if (normalFunctionCalls.length > 0) {
            log.debug("Normal tools also requested:", normalFunctionCalls.map((o: any) => o.name).join(", "));
            const nonFunctionItems = intermediateItems.filter(
                (o: any) => o.type !== "function_call"
            );
            const codeExecutorCalls = intermediateItems.filter(
                (o: any) => o.type === "function_call" && o.name === "code_executor"
            );
            const response = {
                ...llmResult,
                output: [...chainOutputs, ...nonFunctionItems, ...codeExecutorCalls, ...allOutputs, ...normalFunctionCalls],
            };
            log.trace("-> client (mixed):", response);
            return response;
        }

        // Continue with LLM (feed sandbox results back)
        const llmResponseItems = llmResult.output || [];
        const llmInput = [...originalInput, ...llmResponseItems, ...allOutputs];

        const finalResult = await this.llmClient.chat(
            { input: llmInput, tools, model: llmResult.model, extraParams: requestParams },
            reqHeaders,
        );

        // Check for chaining (LLM wants another code_executor call)
        const newCodeCall = finalResult.output?.find(
            (o: any) => o.type === "function_call" && o.name === "code_executor"
        );

        if (newCodeCall && runtimeTools.length > 0) {
            log.info("Chaining: LLM returned another code_executor call");
            const allNewExecutorCalls = finalResult.output?.filter(
                (o: any) => o.type === "function_call" && o.name === "code_executor"
            ) || [];

            return this.execute({
                codeCall: newCodeCall,
                runtimeTools,
                llmResult: finalResult,
                originalInput: llmInput,
                pendingExecutors: allNewExecutorCalls,
                executorOutputs: [],
                tools,
                chainDepth: chainDepth + 1,
                requestParams,
                chainOutputs: [...chainOutputs, ...intermediateItems, ...allOutputs],
                reqHeaders,
            });
        }

        const response = {
            ...finalResult,
            output: [...chainOutputs, ...intermediateItems, ...allOutputs, ...(finalResult.output || [])],
        };
        log.trace("-> client (final):", response);
        return response;
    }

    // --- Resume after client fulfils a runtime tool call ---

    async resumeAfterToolResult(params: ResumeAfterToolResultParams): Promise<any> {
        const { toolResults, cleanInput, model, tools = [], requestParams = {}, reqHeaders } = params;

        if (!Array.isArray(toolResults) || toolResults.length === 0) {
            return { error: "No tool results provided", _status: 400 };
        }

        log.info("Handling tool results count:", toolResults.length);
        log.debug("Call ids:", toolResults.map(r => r.call_id?.slice(0, 12)).join(", "));

        const sessionIds = new Set<string>();
        for (const result of toolResults) {
            const sessionId = callToSession.get(result.call_id);
            if (!sessionId) {
                log.error("Unknown call_id:", result.call_id);
                return { error: `Unknown or expired call_id: ${result.call_id}`, _status: 400 };
            }
            sessionIds.add(sessionId);
        }

        if (sessionIds.size !== 1) {
            return { error: "All tool results in one request must belong to the same session", _status: 400 };
        }

        const sessionId = [...sessionIds][0];
        const session = sessions.get(sessionId);
        if (!session) {
            log.error("Session expired for:", sessionId);
            return { error: "Session expired", _status: 400 };
        }

        log.debug("Session:", sessionId?.slice(0, 12));

        // Resolve all pending tool calls in the sandbox for this session
        for (const result of toolResults) {
            const resolved = this.toolBridge.resolveApiToolCall(
                result.call_id,
                this.parseToolResultOutput(result.output),
                result.error
            );

            if (!resolved) {
                return { error: `Failed to resolve tool call: ${result.call_id}`, _status: 500 };
            }

            callToSession.delete(result.call_id);
        }

        const execPromise = this.executionPromises.get(sessionId);
        if (!execPromise) {
            return { error: "No active execution for session", _status: 500 };
        }

        // Race again: sandbox might complete or call another tool
        const raceResult = await this.raceExecution(sessionId, execPromise);

        // --- Another tool-call interrupt ---
        if (raceResult.type === "tool_calls") {
            const output = raceResult.events.map(({ callId, toolName, args }) => {
                callToSession.set(callId, sessionId);
                return {
                    type: "function_call",
                    id: `fc_${callId}`,
                    call_id: callId,
                    name: toolName,
                    arguments: JSON.stringify(args),
                    caller: { call_id: sessionId },
                };
            });

            log.info(
                "Sandbox blocked again, returning tool calls:",
                output.map((o: any) => o.name).join(", "),
            );

            return { output };
        }

        // --- Sandbox completed ---
        const sandboxOutput = raceResult.result.output;
        log.info("Sandbox completed (from resume)");
        log.trace("Sandbox output:", sandboxOutput?.slice(0, 100));

        const currentOutput = {
            type: "function_call_output",
            call_id: sessionId,
            output: sandboxOutput,
        };

        const allOutputs = [...(session.executorOutputs || []), currentOutput];

        // Process remaining parallel executors
        const remainingExecutors = (session.pendingExecutors || []).filter(
            (e: any) => e.call_id !== sessionId
        );

        if (remainingExecutors.length > 0) {
            log.debug("More executors pending (from resume):", remainingExecutors.length);
            const savedChainOutputs = session.chainOutputs || [];
            this.cleanup(sessionId);

            const nextExecutor = remainingExecutors[0];
            const llmResult = { output: [], model };
            return this.execute({
                codeCall: nextExecutor,
                runtimeTools: session.runtimeTools,
                llmResult,
                originalInput: cleanInput,
                pendingExecutors: remainingExecutors,
                executorOutputs: allOutputs,
                tools,
                chainDepth: 0,
                requestParams,
                chainOutputs: savedChainOutputs,
                reqHeaders,
            });
        }

        const savedRuntimeTools = session.runtimeTools;
        this.cleanup(sessionId);

        // Continue with LLM
        const llmInput = [...cleanInput, ...allOutputs];

        const finalResult = await this.llmClient.chat(
            { input: llmInput, tools, model, extraParams: requestParams },
            reqHeaders,
        );

        // Check for chaining
        const newCodeCall = finalResult.output?.find(
            (o: any) => o.type === "function_call" && o.name === "code_executor"
        );

        if (newCodeCall && savedRuntimeTools.length > 0) {
            log.info("Chaining from resume: LLM returned another code_executor call");
            const allNewExecutorCalls = finalResult.output?.filter(
                (o: any) => o.type === "function_call" && o.name === "code_executor"
            ) || [];

            return this.execute({
                codeCall: newCodeCall,
                runtimeTools: savedRuntimeTools,
                llmResult: finalResult,
                originalInput: llmInput,
                pendingExecutors: allNewExecutorCalls,
                executorOutputs: [],
                tools,
                chainDepth: 0,
                requestParams,
                chainOutputs: allOutputs,
                reqHeaders,
            });
        }

        // Include sandbox outputs + final LLM response for the client.
        const response = {
            ...finalResult,
            output: [...allOutputs, ...(finalResult.output || [])],
        };
        log.trace("-> client (final from resume):", response);
        return response;
    }

    // --- Private helpers ---

    private raceExecution(
        sessionId: string,
        execPromise: Promise<{ success: boolean; output: string }>,
    ): Promise<
        | { type: "completed"; result: { success: boolean; output: string } }
        | { type: "tool_calls"; events: ToolCallEvent[] }
    > {
        const toolCallPromise = this.waitForToolCallBatch(sessionId).then(events => ({
            type: "tool_calls" as const,
            events,
        }));

        return Promise.race([
            execPromise.then(r => ({ type: "completed" as const, result: r })),
            toolCallPromise,
        ]);
    }

    private async waitForToolCallBatch(sessionId: string): Promise<ToolCallEvent[]> {
        if (this.hasQueuedToolCalls(sessionId)) {
            await this.delayBatchWindow();
            return this.drainToolCallQueue(sessionId);
        }

        await new Promise<void>(resolve => {
            this.toolCallWaiters.set(sessionId, resolve);
        });

        await this.delayBatchWindow();
        return this.drainToolCallQueue(sessionId);
    }

    private hasQueuedToolCalls(sessionId: string): boolean {
        const queue = this.toolCallQueues.get(sessionId);
        return Boolean(queue && queue.length > 0);
    }

    private async delayBatchWindow(): Promise<void> {
        if (TOOL_CALL_BATCH_WINDOW_MS <= 0) return;
        await new Promise(resolve => setTimeout(resolve, TOOL_CALL_BATCH_WINDOW_MS));
    }

    private drainToolCallQueue(sessionId: string): ToolCallEvent[] {
        const queue = this.toolCallQueues.get(sessionId) || [];
        this.toolCallQueues.delete(sessionId);
        return queue;
    }

    private buildToolCallResponse(events: ToolCallEvent[], codeCall: any, llmResult: any, chainOutputs: any[]): any {
        const runtimeCalls = events.map(({ callId, toolName, args }) => {
            callToSession.set(callId, codeCall.call_id);
            return {
                type: "function_call",
                id: `fc_${callId}`,
                call_id: callId,
                name: toolName,
                arguments: JSON.stringify(args),
                caller: { call_id: codeCall.call_id },
            };
        });

        log.info("Sandbox blocked, returning runtime tool calls:", runtimeCalls.map((c: any) => c.name).join(", "));

        const originalOutput = llmResult.output || [];
        const newOutput = [
            ...chainOutputs,
            ...originalOutput,
            ...runtimeCalls,
        ];

        const response = { ...llmResult, output: newOutput };
        log.trace("-> client (blocked):", response);
        return response;
    }

    private parseToolResultOutput(output?: string): unknown {
        if (output === undefined) return undefined;
        try {
            return JSON.parse(output);
        } catch {
            return output;
        }
    }

    private cleanup(sessionId: string): void {
        this.toolBridge.unregisterApiTools(sessionId);
        sessions.delete(sessionId);
        this.executionPromises.delete(sessionId);
        this.toolCallWaiters.delete(sessionId);
        this.toolCallQueues.delete(sessionId);
    }
}
