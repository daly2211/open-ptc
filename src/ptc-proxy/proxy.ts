import { Hono } from "hono";
import { ToolBridge } from "@/bridge/tool-bridge.ts";
import { CodeExecutionEngine } from "@/execution/sandbox-executor.ts";
import { buildReplTool, stripPtcFields } from "./repl-tool-builder.ts";
import { sessions, callToSession } from "./session-store.ts";
import type { PtcTool, ToolCallEvent } from "./types.ts";
import type { McpToolDefinition } from "@/mcp/mcp-registry.ts";
import { json } from "node:stream/consumers";

const MAX_CHAIN_DEPTH = 10;

export interface PtcProxyOptions {
  litellmUrl: string;
  toolBridge: ToolBridge;
  codeExecutor: CodeExecutionEngine;
  mcpTools?: McpToolDefinition[];
}

export class PtcProxy {
  private toolBridge: ToolBridge;
  private codeExecutor: CodeExecutionEngine;
  private litellmUrl: string;
  private mcpTools: McpToolDefinition[];
  private toolCallResolvers = new Map<string, (event: ToolCallEvent) => void>();
  private executionPromises = new Map<string, Promise<{ success: boolean; output: string }>>();

  constructor(options: PtcProxyOptions) {
    this.toolBridge = options.toolBridge;
    this.codeExecutor = options.codeExecutor;
    this.litellmUrl = options.litellmUrl;
    this.mcpTools = options.mcpTools || [];

    this.toolBridge.configureApiMode((callId, toolName, args, sessionId) => {
      const resolver = this.toolCallResolvers.get(sessionId);
      if (resolver) {
        this.toolCallResolvers.delete(sessionId);
        resolver({ callId, toolName, args });
      }
    });
  }

  createHandler(): (req: Request) => Promise<Response> | Response {
    const app = new Hono();

    app.post("/v1/responses", async (c) => {
      const body = await c.req.json();

      console.log("[PROXY] Received request from client\n" + JSON.stringify(body, null, 2));

      // Extract request params to forward to LLM continuations (temperature, etc.)
      const { input: _ri, tools: _rt, model: _rm, ...requestParams } = body;

      const toolResult = findToolResult(body.input);
      console.log("[PROXY] toolResult found:", toolResult ? toolResult.call_id?.slice(0, 8) : "null");
      console.log("[PROXY] callToSession has call_id:", toolResult ? callToSession.has(toolResult.call_id) : "N/A");
      if (toolResult && callToSession.has(toolResult.call_id)) {
        const cleanInput = stripInternalFields(body.input);
        const toolResultIndex = body.input.findIndex(
          (item: any) => item.type === "function_call_output" && item.call_id === toolResult.call_id
        );
        const originalOutput = toolResultIndex > 0 ? body.input.slice(0, toolResultIndex) : [];
        console.log("[PROXY] Calling handleToolResult, originalOutput items:", originalOutput.length);

        const tools: PtcTool[] = body.tools || [];
        const runtimeTools = tools.filter(t => t["open-ptc-runtime-function"]);
        const normalTools = tools.filter(t => !t["open-ptc-runtime-function"]);
        let transformedTools = normalTools.map(stripPtcFields);
        if (runtimeTools.length > 0) {
          const replTool = await buildReplTool(runtimeTools, this.mcpTools);
          transformedTools = [...normalTools.map(stripPtcFields), replTool];
        }

        return this.handleToolResult(c, toolResult, originalOutput, cleanInput, body.model, transformedTools, requestParams);
      }

      const tools: PtcTool[] = body.tools || [];
      const runtimeTools = tools.filter(t => t["open-ptc-runtime-function"]);
      const normalTools = tools.filter(t => !t["open-ptc-runtime-function"]);

      // Strip internal fields from input before forwarding to LLM
      const cleanInput = stripInternalFields(body.input);

      let transformed = { ...body, input: cleanInput };
      if (runtimeTools.length > 0) {
        // Runtime tools are ONLY accessible inside code_executor sandbox
        // Do NOT send them as normal tools to the LLM
        const replTool = await buildReplTool(runtimeTools, this.mcpTools);
        transformed = {
          ...transformed,
          tools: [...normalTools.map(stripPtcFields), replTool],
        };
      } else {
        // No runtime tools - pass through normal tools as-is
        transformed = {
          ...transformed,
          tools: normalTools.map(stripPtcFields),
        };
      }

      console.log("\n[PROXY] === REQUEST ===");
      console.log("[PROXY] input items:", cleanInput?.length);
      console.log("[PROXY] input types:", cleanInput?.slice?.(-5)?.map?.((i: any) => i.type)?.join?.(", ") || "N/A");
      console.log("[PROXY] full input types:", cleanInput?.map?.((i: any) => i.type)?.join?.(", ") || "N/A");
      console.log("[PROXY] tools to LLM:", transformed.tools?.map((t: any) => t.name)?.join?.(", "));

      console.log("\n[PROXY] === LLM REQUEST: ", JSON.stringify(transformed, null, 2));

      const response = await fetch(`${this.litellmUrl}/v1/responses`, {
        method: "POST",
        headers: forwardHeaders(c.req),
        body: JSON.stringify(transformed),
      });

      const result = await response.json();
      console.log("\n[PROXY] === LLM RESPONSE: ", JSON.stringify(result, null, 2));

      console.log("[PROXY] LLM response status:", result.status);
      const fcalls = result.output?.filter((o: any) => o.type === "function_call") || [];
      if (fcalls.length > 0) {
        console.log("[PROXY] function_calls:", fcalls.map((o: any) => `${o.name}(${o.call_id?.slice(0, 8)})`).join(", "));
      }
      const msgs = result.output?.filter((o: any) => o.type === "message") || [];
      if (msgs.length > 0) {
        console.log("[PROXY] message:", msgs[0].content?.slice?.(0, 60) || "[array]");
      }

      const codeCall = result.output?.find(
        (o: any) => o.type === "function_call" && o.name === "code_executor"
      );


      if (codeCall && runtimeTools.length > 0) {
        console.log("\n[PROXY] -> EXECUTING SANDBOX for code_executor");

        const allExecutorCalls = result.output?.filter(
          (o: any) => o.type === "function_call" && o.name === "code_executor"
        ) || [];

        return this.executeSandbox(c, codeCall, runtimeTools, result, cleanInput, allExecutorCalls, [], transformed.tools, 0, requestParams, []);
      }

      console.log("\n[PROXY] proxy -> client, data: " + JSON.stringify(result, null, 2));
      return c.json(result);
    });

    app.all("/*", (c) => {
      const url = new URL(c.req.url);
      const targetUrl = `${this.litellmUrl}${url.pathname}${url.search}`;
      const body = c.req.raw.body;
      return fetch(targetUrl, {
        method: c.req.method,
        headers: forwardHeaders(c.req),
        body: body,
      });
    });

    return app.fetch;
  }

  private async executeSandbox(
    c: any,
    codeCall: any,
    runtimeTools: PtcTool[],
    llmResult: any,
    originalInput: any[],
    pendingExecutors: any[],
    executorOutputs: any[],
    tools: any[],
    chainDepth: number = 0,
    requestParams: Record<string, unknown> = {},
    chainOutputs: any[] = []
  ) {
    const sessionId = codeCall.call_id;

    if (chainDepth >= MAX_CHAIN_DEPTH) {
      console.log("[PROXY] -> MAX CHAIN DEPTH reached (" + MAX_CHAIN_DEPTH + "), returning last LLM response");
      const maxDepthResponse = { ...llmResult, output: llmResult.output || [], status: llmResult.status || "completed" };
      console.log("\n[PROXY] proxy -> client, data: " + JSON.stringify(maxDepthResponse, null, 2));
      return c.json(maxDepthResponse);
    }

    const { code } = JSON.parse(codeCall.arguments);

    const session = sessions.create(sessionId, runtimeTools);
    session.pendingExecutors = pendingExecutors;
    session.executorOutputs = executorOutputs;
    this.toolBridge.registerApiTools(sessionId, runtimeTools);

    const execPromise = this.codeExecutor.executeCodeForApiSession(code, sessionId, runtimeTools);
    this.executionPromises.set(sessionId, execPromise);

    const toolCallPromise = new Promise<ToolCallEvent>(resolve => {
      this.toolCallResolvers.set(sessionId, resolve);
    });

    const raceResult = await Promise.race([
      execPromise.then(r => ({ type: "completed" as const, result: r })),
      toolCallPromise.then(e => ({ type: "tool_call" as const, event: e })),
    ]);

    if (raceResult.type === "tool_call") {
      const { callId, toolName, args } = raceResult.event;
      callToSession.set(callId, sessionId);

      const originalOutput = llmResult.output || [];
      const newOutput = [
        ...originalOutput,
        {
          type: "function_call",
          id: `fc_${callId}`,
          call_id: callId,
          name: toolName,
          arguments: JSON.stringify(args),
          caller: { call_id: codeCall.call_id },
        },
      ];

      console.log("[PROXY] -> SANDBOX BLOCKED, returning runtime tool call:", toolName);
      const blockedResponse = {
        ...llmResult,
        output: newOutput,
      };
      console.log("\n[PROXY] proxy -> client, data: " + JSON.stringify(blockedResponse, null, 2));
      return c.json(blockedResponse);
    }

    const sandboxOutput = raceResult.result.output;
    console.log("[PROXY] -> SANDBOX COMPLETED, output:", sandboxOutput?.slice(0, 100));

    const currentOutput = {
      type: "function_call_output",
      call_id: codeCall.call_id,
      output: sandboxOutput,
    };

    const allOutputs = [...executorOutputs, currentOutput];

    const remainingExecutors = pendingExecutors.filter(
      (e: any) => e.call_id !== codeCall.call_id
    );

    if (remainingExecutors.length > 0) {
      console.log("[PROXY] -> MORE EXECUTORS PENDING:", remainingExecutors.length);
      this.cleanup(sessionId);

      const nextExecutor = remainingExecutors[0];
      return this.executeSandbox(
        c,
        nextExecutor,
        runtimeTools,
        llmResult,
        originalInput,
        remainingExecutors,
        allOutputs,
        tools,
        chainDepth,
        requestParams,
        chainOutputs
      );
    }

    this.cleanup(sessionId);

    // If the LLM also requested normal (non-code_executor) tool calls,
    // return them to the client alongside the sandbox results instead of auto-continuing.
    const normalFunctionCalls = (llmResult.output || []).filter(
      (o: any) => o.type === "function_call" && o.name !== "code_executor"
    );

    if (normalFunctionCalls.length > 0) {
      console.log("[PROXY] -> NORMAL TOOLS also requested:", normalFunctionCalls.map((o: any) => o.name).join(", "));
      const codeExecutorCalls = (llmResult.output || []).filter(
        (o: any) => o.type === "function_call" && o.name === "code_executor"
      );
      const otherItems = (llmResult.output || []).filter(
        (o: any) => o.type !== "function_call"
      );
      const clientOutput = [
        ...otherItems,
        ...codeExecutorCalls,
        ...chainOutputs,
        ...allOutputs,
        ...normalFunctionCalls,
      ];
      const mixedResponse = {
        ...llmResult,
        output: clientOutput,
      };
      console.log("\n[PROXY] proxy -> client, data: " + JSON.stringify(mixedResponse, null, 2));
      return c.json(mixedResponse);
    }

    const llmResponseItems = llmResult.output || [];
    const llmInput = [
      ...originalInput,
      ...llmResponseItems,
      ...allOutputs,
    ];

    const finalResult = await this.continueWithLlm(
      llmInput,
      tools,
      forwardHeaders(c.req),
      llmResult.model,
      requestParams
    );

    // Check if LLM wants another code_executor call (chaining)
    const newCodeCall = finalResult.output?.find(
      (o: any) => o.type === "function_call" && o.name === "code_executor"
    );

    if (newCodeCall && runtimeTools.length > 0) {
      console.log("\n[PROXY] -> CHAINING: LLM returned another code_executor call");
      const allNewExecutorCalls = finalResult.output?.filter(
        (o: any) => o.type === "function_call" && o.name === "code_executor"
      ) || [];

      return this.executeSandbox(
        c,
        newCodeCall,
        runtimeTools,
        finalResult,
        llmInput,
        allNewExecutorCalls,
        [],
        tools,
        chainDepth + 1,
        requestParams,
        [...chainOutputs, ...allOutputs]
      );
    }

    const clientOutput = [...chainOutputs, ...allOutputs, ...(finalResult.output || [])];

    const finalResponse = {
      ...finalResult,
      output: clientOutput,
    };
    console.log("\n[PROXY] proxy -> client, data: " + JSON.stringify(finalResponse, null, 2));
    return c.json(finalResponse);
  }

  private async handleToolResult(
    c: any,
    toolResult: any,
    originalOutput: any[],
    cleanInput: any[],
    model?: string,
    tools?: any[],
    requestParams: Record<string, unknown> = {}
  ) {
    const { call_id, output, error } = toolResult;

    console.log("\n[PROXY] === HANDLE TOOL RESULT ===");
    console.log("[PROXY] call_id:", call_id?.slice(0, 12) + "...");
    console.log("[PROXY] output preview:", output?.slice(0, 50));

    const sessionId = callToSession.get(call_id);
    if (!sessionId) {
      console.log("[PROXY] ERROR: Unknown call_id");
      const errResp = { error: "Unknown or expired call_id" };
      console.log("\n[PROXY] proxy -> client, data: " + JSON.stringify(errResp));
      return c.json(errResp, 400);
    }

    const session = sessions.get(sessionId);
    if (!session) {
      console.log("[PROXY] ERROR: Session expired");
      const errResp = { error: "Session expired" };
      console.log("\n[PROXY] proxy -> client, data: " + JSON.stringify(errResp));
      return c.json(errResp, 400);
    }

    console.log("[PROXY] sessionId:", sessionId?.slice(0, 12) + "...");

    const resolved = this.toolBridge.resolveApiToolCall(
      call_id,
      output ? JSON.parse(output) : undefined,
      error
    );

    if (!resolved) {
      const errResp = { error: "Failed to resolve tool call" };
      console.log("\n[PROXY] proxy -> client, data: " + JSON.stringify(errResp));
      return c.json(errResp, 500);
    }

    callToSession.delete(call_id);

    const execPromise = this.executionPromises.get(sessionId);
    if (!execPromise) {
      const errResp = { error: "No active execution for session" };
      console.log("\n[PROXY] proxy -> client, data: " + JSON.stringify(errResp));
      return c.json(errResp, 500);
    }

    const toolCallPromise = new Promise<ToolCallEvent>(resolve => {
      this.toolCallResolvers.set(sessionId, resolve);
    });

    const raceResult = await Promise.race([
      execPromise.then(r => ({ type: "completed" as const, result: r })),
      toolCallPromise.then(e => ({ type: "tool_call" as const, event: e })),
    ]);

    if (raceResult.type === "tool_call") {
      const { callId, toolName, args } = raceResult.event;
      callToSession.set(callId, sessionId);

      console.log("[PROXY] -> SANDBOX BLOCKED again, returning tool call:", toolName);

      const newOutput = [
        {
          type: "function_call",
          id: `fc_${callId}`,
          call_id: callId,
          name: toolName,
          arguments: JSON.stringify(args),
          caller: { call_id: sessionId },
        },
      ];

      const blockedResponse = {
        output: newOutput,
      };
      console.log("\n[PROXY] proxy -> client, data: " + JSON.stringify(blockedResponse, null, 2));
      return c.json(blockedResponse);
    }

    const sandboxOutput = raceResult.result.output;
    console.log("[PROXY] -> SANDBOX COMPLETED (from handleToolResult)");
    console.log("[PROXY]    sandbox output:", sandboxOutput?.slice(0, 100));

    const currentOutput = {
      type: "function_call_output",
      call_id: sessionId,
      output: sandboxOutput,
    };

    const allOutputs = [...(session.executorOutputs || []), currentOutput];

    const remainingExecutors = (session.pendingExecutors || []).filter(
      (e: any) => e.call_id !== sessionId
    );

    if (remainingExecutors.length > 0) {
      console.log("[PROXY] -> MORE EXECUTORS PENDING (from handleToolResult):", remainingExecutors.length);
      this.cleanup(sessionId);

      const nextExecutor = remainingExecutors[0];
      const llmResult = { output: [], model };
      return this.executeSandbox(
        c,
        nextExecutor,
        session.runtimeTools,
        llmResult,
        cleanInput,
        remainingExecutors,
        allOutputs,
        tools || [],
        0,
        requestParams,
        []
      );
    }

    const savedRuntimeTools = session.runtimeTools;
    this.cleanup(sessionId);

    const llmInput = [
      ...cleanInput,
      ...allOutputs,
    ];

    const finalResult = await this.continueWithLlm(
      llmInput,
      tools || [],
      forwardHeaders(c.req),
      model,
      requestParams
    );

    // Check if LLM wants another code_executor call (chaining)
    const newCodeCall = finalResult.output?.find(
      (o: any) => o.type === "function_call" && o.name === "code_executor"
    );

    if (newCodeCall && savedRuntimeTools.length > 0) {
      console.log("\n[PROXY] -> CHAINING: LLM returned another code_executor call (from handleToolResult)");
      const allNewExecutorCalls = finalResult.output?.filter(
        (o: any) => o.type === "function_call" && o.name === "code_executor"
      ) || [];

      return this.executeSandbox(
        c,
        newCodeCall,
        savedRuntimeTools,
        finalResult,
        llmInput,
        allNewExecutorCalls,
        [],
        tools || [],
        0,
        requestParams,
        allOutputs
      );
    }

    const clientOutput = [...allOutputs, ...(finalResult.output || [])];

    const finalResponse = {
      ...finalResult,
      output: clientOutput,
    };
    console.log("\n[PROXY] proxy -> client, data: " + JSON.stringify(finalResponse, null, 2));
    return c.json(finalResponse);
  }

  private cleanup(sessionId: string): void {
    this.toolBridge.unregisterApiTools(sessionId);
    sessions.delete(sessionId);
    this.executionPromises.delete(sessionId);
    this.toolCallResolvers.delete(sessionId);
  }

  private async continueWithLlm(
    input: any[],
    tools: any[],
    headers: Headers,
    model?: string,
    requestParams: Record<string, unknown> = {}
  ): Promise<any> {
    const requestBody: any = {
      ...requestParams,
      input,
      tools,
    };
    if (model) {
      requestBody.model = model;
    }

    console.log("\n[PROXY] === CONTINUE WITH LLM ===");
    console.log("[PROXY] input items:", input.length);
    console.log("[PROXY] input types:", input.map((i: any) => i.type).join(", "));

    const response = await fetch(`${this.litellmUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });

    const result = await response.json();
    console.log("[PROXY] LLM response status:", result.status);

    console.log("[PROXY] LLM response output:", JSON.stringify(result.output, null, 2));


    const msgs = result.output?.filter((o: any) => o.type === "message") || [];
    if (msgs.length > 0) {
      console.log("[PROXY] LLM message:", msgs[0].content?.slice?.(0, 100) || "[array]");
    }

    return result;
  }
}

function findToolResult(input: any[]): any | null {
  // Only find function_call_output for calls that are in callToSession (runtime tool calls)
  return input?.find((item: any) =>
    item.type === "function_call_output" && callToSession.has(item.call_id)
  ) || null;
}

function forwardHeaders(req: { header: (name: string) => string | undefined }): Headers {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  const auth = req.header("authorization");
  if (auth) headers.set("authorization", auth);
  return headers;
}

function filterInternalRuntimeCalls(output: any[], sessionId: string): any[] {
  console.log("[PROXY] filterInternalRuntimeCalls: sessionId:", sessionId?.slice(0, 8));
  console.log("[PROXY] filterInternalRuntimeCalls: INPUT:", output.map((o: any) => `${o.type}${o.name ? '(' + o.name + ')' : ''}${o.call_id ? ':' + o.call_id?.slice(0, 8) : ''}`).join(", "));

  const internalCallIds = new Set<string>();

  // First pass: find internal runtime tool calls (calls with caller.call_id referencing sessionId)
  for (const item of output) {
    if (item.type === "function_call" && item.caller && item.caller.call_id === sessionId) {
      console.log("[PROXY] filterInternalRuntimeCalls: found internal call:", item.name, item.call_id?.slice(0, 8));
      internalCallIds.add(item.call_id);
    }
  }

  console.log("[PROXY] filterInternalRuntimeCalls: internal call_ids:", [...internalCallIds].join(", "));

  // Second pass: filter out internal calls and their outputs
  const filtered = output.filter((item) => {
    // Remove code_executor calls
    if (item.type === "function_call" && item.name === "code_executor") {
      return false;
    }

    // Remove internal runtime tool calls
    if (item.type === "function_call" && item.caller && item.caller.call_id === sessionId) {
      return false;
    }

    // Remove function_call_outputs for internal calls
    if (item.type === "function_call_output" && internalCallIds.has(item.call_id)) {
      return false;
    }

    return true;
  });

  console.log("[PROXY] filterInternalRuntimeCalls: OUTPUT:", filtered.map((o: any) => `${o.type}${o.name ? '(' + o.name + ')' : ''}${o.call_id ? ':' + o.call_id?.slice(0, 8) : ''}`).join(", "));

  return filtered;
}

function stripInternalFields(input: any[]): any[] {
  if (!Array.isArray(input)) return input;

  console.log("[PROXY] stripInternalFields: INPUT items:", input.length);
  console.log("[PROXY] stripInternalFields: INPUT types:", input.map((i: any) => `${i.type}${i.name ? '(' + i.name + ')' : ''}${i.call_id ? ':' + i.call_id?.slice(0, 8) : ''}`).join(", "));

  const toRemove = new Set<number>();

  // First pass: find code_executor call_ids and internal runtime call ids
  const codeExecutorCallIds = new Set<string>();
  const internalRuntimeCallIds = new Set<string>();

  for (const item of input) {
    if (item.type === "function_call" && item.name === "code_executor") {
      codeExecutorCallIds.add(item.call_id);
    }
    // Find internal runtime tool calls (runtime tools with caller pointing to code_executor)
    if (item.type === "function_call" && item.caller && item.caller.call_id) {
      if (codeExecutorCallIds.has(item.caller.call_id)) {
        internalRuntimeCallIds.add(item.call_id);
      }
    }
  }

  // Second pass: ONLY remove internal runtime tool traces
  for (let i = 0; i < input.length; i++) {
    const item = input[i];

    // Remove INTERNAL runtime tool calls (calls made by code_executor sandbox)
    if (item.type === "function_call" && internalRuntimeCallIds.has(item.call_id)) {
      toRemove.add(i);
      continue;
    }

    // Remove INTERNAL runtime tool outputs
    if (item.type === "function_call_output" && internalRuntimeCallIds.has(item.call_id)) {
      toRemove.add(i);
      continue;
    }

    // KEEP: code_executor calls, code_executor outputs, reasoning, messages, etc.
  }

  const filtered = input.filter((_, index) => !toRemove.has(index));

  // Third pass: remove orphaned reasoning (reasoning not followed by any function_call)
  const finalFiltered: any[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const item = filtered[i];
    // if (item.type === "reasoning") {
    //   const nextItem = filtered[i + 1];
    //   if (nextItem && nextItem.type === "function_call") {
    //     finalFiltered.push(item);
    //   }
    //   continue;
    // }
    finalFiltered.push(item);
  }

  console.log("[PROXY] stripInternalFields: OUTPUT items:", finalFiltered.length);
  console.log("[PROXY] stripInternalFields: OUTPUT types:", finalFiltered.map((i: any) => `${i.type}${i.name ? '(' + i.name + ')' : ''}${i.call_id ? ':' + i.call_id?.slice(0, 8) : ''}`).join(", "));

  return finalFiltered;
}
