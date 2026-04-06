/**
 * Open-PTC Proxy — Thin HTTP routing layer for programmatic tool calling.
 *
 * Delegates to:
 * - LlmClient       for LLM communication
 * - SandboxOrchestrator for sandbox lifecycle management
 * - proxy-utils      for request/response transformation
 */

import { Hono } from "hono";
import { ToolBridge } from "@/bridge/tool-bridge.ts";
import { CodeExecutionEngine } from "@/execution/sandbox-executor.ts";
import type { McpToolDefinition } from "@/mcp/mcp-registry.ts";
import type { ProxyTool } from "./types.ts";
import { LlmClient, forwardHeaders, type LlmBackendMode } from "./llm-client.ts";
import { SandboxOrchestrator } from "./sandbox-orchestrator.ts";
import { findToolResult, stripInternalFields, categorizeTools, buildLlmTools } from "./proxy-utils.ts";
import { callToSession } from "./session-store.ts";
import { log } from "./proxy-logger.ts";
import {
  chatRequestToResponsesBody,
  responsesResultToChatCompletion,
} from "./chat-completions-adapter.ts";

export interface ProxyOptions {
  litellmUrl: string;
  toolBridge: ToolBridge;
  codeExecutor: CodeExecutionEngine;
  mcpTools?: McpToolDefinition[];
}

export class Proxy {
  private llmClient: LlmClient;
  private orchestrator: SandboxOrchestrator;
  private mcpTools: McpToolDefinition[];

  constructor(options: ProxyOptions) {
    this.llmClient = new LlmClient(options.litellmUrl);
    this.orchestrator = new SandboxOrchestrator(
      options.toolBridge,
      options.codeExecutor,
      this.llmClient,
    );
    this.mcpTools = options.mcpTools || [];
  }

  createHandler(): (req: Request) => Promise<Response> | Response {
    const app = new Hono();

    app.post("/v1/responses", async (c) => {
      const body = await c.req.json();
      log.info("Received request from client");
      log.trace("Request body:", body);

      const result = await this.runResponsesFlow(body, forwardHeaders(c.req), "responses");
      if (result._status) {
        const { _status, ...rest } = result;
        return c.json(rest, _status);
      }

      log.trace("-> client:", result);
      return c.json(result);
    });

    app.post("/v1/chat/completions", async (c) => {
      const chatBody = await c.req.json();
      log.info("Received chat.completions request from client");
      log.trace("Chat request body:", chatBody);

      try {
        const { body } = chatRequestToResponsesBody(chatBody);
        const responsesBody = {
          ...body.requestParams,
          model: body.model,
          input: body.input,
          tools: body.tools,
        };

        const internalResult = await this.runResponsesFlow(responsesBody, forwardHeaders(c.req), "chat_completions");
        if (internalResult._status) {
          const { _status, ...rest } = internalResult;
          return c.json(rest, _status);
        }

        const chatResult = responsesResultToChatCompletion(internalResult, chatBody.model);
        log.trace("-> client (chat.completions):", chatResult);
        return c.json(chatResult);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ error: message }, 400);
      }
    });

    app.post("/v1/completions", async (c) => {
      const body = await c.req.json();
      const reqHeaders = forwardHeaders(c.req);
      const upstream = await this.llmClient.post("/v1/completions", body, reqHeaders);
      const responseBody = await upstream.text();

      return new Response(responseBody, {
        status: upstream.status,
        headers: {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
        },
      });
    });

    // Pass-through all other routes to LiteLLM
    app.all("/*", (c) => {
      const url = new URL(c.req.url);
      const targetUrl = `${this.llmClient.url}${url.pathname}${url.search}`;
      return fetch(targetUrl, {
        method: c.req.method,
        headers: forwardHeaders(c.req),
        body: c.req.raw.body,
      });
    });

    return app.fetch;
  }

  private async runResponsesFlow(body: any, reqHeaders: Headers, llmMode: LlmBackendMode): Promise<any> {
    // Extract extra params (temperature, etc.) to forward on continuations
    const { input: _ri, tools: _rt, model: _rm, ...requestParams } = body;

    const rawTools: ProxyTool[] = body.tools || [];
    const categorized = categorizeTools(rawTools);
    const transformedTools = await buildLlmTools(categorized, this.mcpTools);

    // --- Path A: Client is returning a runtime tool result ---
    const toolResult = findToolResult(body.input);
    if (toolResult && callToSession.has(toolResult.call_id)) {
      log.debug("Tool result found for call:", toolResult.call_id?.slice(0, 8));

      const cleanInput = stripInternalFields(body.input);
      return this.orchestrator.resumeAfterToolResult({
        toolResult,
        cleanInput,
        model: body.model,
        tools: transformedTools,
        requestParams,
        reqHeaders,
        llmMode,
      });
    }

    // --- Path B: Fresh request - send to LLM ---
    const cleanInput = stripInternalFields(body.input);

    log.debug("Input items:", cleanInput?.length, "| tools:", transformedTools.map((t: any) => t.name)?.join(", "));
    log.trace("Transformed request:", { input: cleanInput, tools: transformedTools });

    const llmResponse = await this.llmClient.chat(
      { input: cleanInput, tools: transformedTools, model: body.model, extraParams: requestParams },
      reqHeaders,
      llmMode,
    );

    const fcalls = llmResponse.output?.filter((o: any) => o.type === "function_call") || [];
    if (fcalls.length > 0) {
      log.debug("Function calls:", fcalls.map((o: any) => `${o.name}(${o.call_id?.slice(0, 8)})`).join(", "));
    }

    // --- Path B1: LLM wants to run code_executor ---
    const codeCall = llmResponse.output?.find(
      (o: any) => o.type === "function_call" && o.name === "code_executor"
    );

    if (codeCall && categorized.runtimeTools.length > 0) {
      log.info("Executing sandbox for code_executor");

      const allExecutorCalls = llmResponse.output?.filter(
        (o: any) => o.type === "function_call" && o.name === "code_executor"
      ) || [];

      return this.orchestrator.execute({
        codeCall,
        runtimeTools: categorized.runtimeTools,
        llmResult: llmResponse,
        originalInput: cleanInput,
        pendingExecutors: allExecutorCalls,
        executorOutputs: [],
        tools: transformedTools,
        chainDepth: 0,
        requestParams,
        chainOutputs: [],
        reqHeaders,
        llmMode,
      });
    }

    // --- Path B2: No sandbox - forward LLM response directly ---
    return llmResponse;
  }
}
