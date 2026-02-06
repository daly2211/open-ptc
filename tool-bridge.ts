import { JSONRPCServer } from "@yieldray/json-rpc-ts";
import { McpClient } from "./mcp-client.ts";
import type { McpToolDefinition } from "./mcp-registry.ts";
import type { WsToolRegistry } from "./ws-tool-registry.ts";
import { WS_CONFIG } from "./ws-protocol.ts";

interface McpToolRegistration {
  type: "mcp";
  referenceName: string;
  mcpClient: McpClient;
  toolName: string;
  guardFunction: (value: unknown) => boolean;
}

interface ToolCallRequest {
  toolRef: string;
  args?: Record<string, unknown>;
}

interface ToolCallResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

interface PendingWsToolCall {
  callId: string;
  connectionId: string;
  toolName: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export class ToolBridge {
  private readonly mcpTools: Map<string, McpToolRegistration> = new Map();
  private readonly rpcServer: JSONRPCServer;

  // WebSocket tool support (optional)
  private wsToolRegistry?: WsToolRegistry;
  private wsPendingCalls = new Map<string, PendingWsToolCall>();
  private getWebSocket?: (connectionId: string) => WebSocket | undefined;
  private wsCallCounter = 0;

  constructor(mcpTools: McpToolDefinition[]) {
    // Register MCP tools
    for (const mcpTool of mcpTools) {
      const registration: McpToolRegistration = {
        type: "mcp",
        referenceName: mcpTool.referenceName,
        mcpClient: mcpTool.mcpClient,
        toolName: mcpTool.toolName,
        guardFunction: mcpTool.guardFunction,
      };

      this.mcpTools.set(mcpTool.referenceName, registration);
    }

    // Setup RPC server to handle all tool calls
    this.rpcServer = new JSONRPCServer();

    this.rpcServer.setMethod("callTool", async (request: ToolCallRequest) => {
      return await this.handleToolCall(request);
    });
  }

  // Configure WebSocket tool support (called after construction)
  configureWsSupport(
    wsToolRegistry: WsToolRegistry,
    getWebSocket: (connectionId: string) => WebSocket | undefined
  ): void {
    this.wsToolRegistry = wsToolRegistry;
    this.getWebSocket = getWebSocket;
  }

  // Handle tool call requests (routes to MCP or WebSocket tools based on namespace)
  private async handleToolCall(
    request: ToolCallRequest
  ): Promise<ToolCallResponse | unknown> {
    const { toolRef, args = {} } = request;

    // Check if it's a WebSocket tool (namespace starts with main_)
    if (toolRef.startsWith("main_")) {
      return await this.handleWsToolCall(request);
    }

    // Otherwise, it's an MCP tool
    const mcpTool = this.mcpTools.get(toolRef);
    if (!mcpTool) {
      return {
        success: false,
        error: `Tool not found: ${toolRef}`,
      };
    }

    if (!mcpTool.guardFunction(args)) {
      return {
        success: false,
        error: `Type validation failed for tool ${toolRef}. Arguments do not match expected schema.`,
      };
    }

    try {
      const result = await mcpTool.mcpClient.callTool({
        name: mcpTool.toolName,
        arguments: args,
      });

      return {
        success: true,
        data: this.getStructuredMcpToolResponse(result),
      };
    } catch (error) {
      return {
        success: false,
        error: `Error calling tool ${toolRef}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // Handle WebSocket tool call requests (bidirectional - calls back to client)
  private async handleWsToolCall(request: ToolCallRequest): Promise<ToolCallResponse> {
    if (!this.wsToolRegistry || !this.getWebSocket) {
      return {
        success: false,
        error: "WebSocket tools not configured",
      };
    }

    const { toolRef, args = {} } = request;

    // Get tool definition
    const wsTool = this.wsToolRegistry.getTool(toolRef);
    if (!wsTool) {
      return {
        success: false,
        error: `WebSocket tool not found: ${toolRef}`,
      };
    }

    // Validate args
    if (!wsTool.guardFunction(args)) {
      return {
        success: false,
        error: `Invalid arguments for ${toolRef}`,
      };
    }

    // Get WebSocket connection
    const connectionId = wsTool.connectionId;
    const ws = this.getWebSocket(connectionId);

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return {
        success: false,
        error: `WebSocket connection unavailable for ${toolRef}`,
      };
    }

    // Create pending call promise and wrap result
    try {
      const data = await new Promise((resolve, reject) => {
        const callId = `wscall_${Date.now()}_${++this.wsCallCounter}`;
        let settled = false;

        const cleanup = () => {
          settled = true;
          clearTimeout(timeoutId);
          ws.removeEventListener("close", onClose);
          ws.removeEventListener("error", onError);
        };

        const settle = (
          fn: typeof resolve | typeof reject,
          value: unknown
        ) => {
          if (settled) return;
          cleanup();
          this.wsPendingCalls.delete(callId);
          fn(value);
        };

        const timeoutId = setTimeout(() => {
          settle(reject, new Error(`Timeout calling WebSocket tool: ${toolRef}`));
        }, WS_CONFIG.TOOL_CALL_TIMEOUT_MS);

        const onClose = () => {
          settle(reject, new Error(`WebSocket closed while calling tool: ${toolRef}`));
        };

        const onError = () => {
          settle(reject, new Error(`WebSocket error while calling tool: ${toolRef}`));
        };

        // Listen for connection failure during the pending call
        ws.addEventListener("close", onClose);
        ws.addEventListener("error", onError);

        // Store the pending call (resolveWsToolCall will use settle via this entry)
        this.wsPendingCalls.set(callId, {
          callId,
          connectionId,
          toolName: wsTool.toolName,
          resolve: (value: unknown) => settle(resolve, value),
          reject: (error: Error) => settle(reject, error),
          timeoutId,
        });

        // Send tool_call message to client over WebSocket
        try {
          ws.send(
            JSON.stringify({
              type: "tool_call",
              callId,
              toolName: wsTool.toolName, // Original name without namespace
              args,
            })
          );
        } catch (sendError) {
          settle(
            reject,
            new Error(`Failed to send tool call: ${sendError instanceof Error ? sendError.message : String(sendError)}`)
          );
        }
      });

      return {
        success: true,
        data,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Called by WsServer when client sends tool_result
  resolveWsToolCall(callId: string, result: unknown, error?: string): void {
    const pending = this.wsPendingCalls.get(callId);
    if (!pending) {
      console.warn(`Received result for unknown call ID: ${callId}`);
      return;
    }

    clearTimeout(pending.timeoutId);
    this.wsPendingCalls.delete(callId);

    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve(result);
    }
  }

  // Cleanup pending calls when connection closes
  cancelWsCallsForConnection(connectionId: string): void {
    for (const [callId, pending] of this.wsPendingCalls.entries()) {
      if (pending.connectionId === connectionId) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error("Connection closed"));
        this.wsPendingCalls.delete(callId);
      }
    }
  }

  getRpcServer(): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
      const jsonString = await this.rpcServer.handleRequest(
        await request.text()
      );
      return new Response(jsonString, {
        headers: { "content-type": "application/json" },
      });
    };
  }

  getRegisteredMcpTools(): string[] {
    return Array.from(this.mcpTools.keys());
  }

  // Parse and normalize tool response from MCP servers
  getStructuredMcpToolResponse(response: any): any {
    // Case 1: Tool provided structured content directly
    if (response.structuredContent !== undefined) {
      return response.structuredContent;
    }

    // Case 2: Parse JSON from content[0].text if it looks like JSON
    const text = response?.content?.[0]?.text;
    if (typeof text === "string") {
      const trimmed = text.trim();
      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      ) {
        try {
          return JSON.parse(trimmed);
        } catch {
          // fall through
        }
      }
      // Case 3: plain string, just return it
      return trimmed;
    }

    // Case 4: unknown structure
    return null;
  }
}

// Example usage
if (import.meta.main) {
  const { McpRegistry } = await import("./mcp-registry.ts");

  const servers = JSON.parse(
    await Deno.readTextFile(new URL("./mcp_config.json", import.meta.url))
  );

  const mcpRegistry = await McpRegistry.create(servers);
  const toolBridge = new ToolBridge(mcpRegistry.getAllTools());

  const port = Deno.env.get("RPC_SERVER_PORT")
    ? parseInt(Deno.env.get("RPC_SERVER_PORT")!)
    : 9732;

  Deno.serve({ port }, toolBridge.getRpcServer());
  console.log(`ToolBridge RPC server running on port ${port}`);
}
