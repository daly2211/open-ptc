import "@std/dotenv/load";
import { McpRegistry } from "@/mcp/mcp-registry.ts";
import { ToolBridge } from "@/bridge/tool-bridge.ts";
import { CodeExecutionEngine } from "@/execution/sandbox-executor.ts";
import { WsToolRegistry } from "@/ws/ws-tool-registry.ts";
import { generateFullTsFile } from "@/codegen/signature-generator.ts";
import type {
  ClientMessage,
  ServerMessage,
  ClientToolDescriptor,
} from "@/ws/ws-protocol.ts";

export class WsServer {
  private connections = new Map<string, WebSocket>();
  private connectionIdCounter = 0;

  private readonly mcpRegistry: McpRegistry;
  private readonly wsToolRegistry: WsToolRegistry;
  private readonly toolBridge: ToolBridge;
  private readonly codeExecutor: CodeExecutionEngine;

  constructor(mcpRegistry: McpRegistry, toolBridge: ToolBridge) {
    this.mcpRegistry = mcpRegistry;
    this.wsToolRegistry = new WsToolRegistry();
    this.toolBridge = toolBridge;

    // Create code execution engine with WS tool registry
    this.codeExecutor = new CodeExecutionEngine(
      mcpRegistry.groupToolsByServer(),
      this.wsToolRegistry
    );

    // Configure ToolBridge with WebSocket support
    this.toolBridge.configureWsSupport(
      this.wsToolRegistry,
      (connectionId) => this.connections.get(connectionId)
    );
  }

  getWsToolRegistry(): WsToolRegistry {
    return this.wsToolRegistry;
  }

  getConnection(connectionId: string): WebSocket | undefined {
    return this.connections.get(connectionId);
  }

  // Handle new WebSocket connection
  handleConnection(ws: WebSocket): void {
    const connectionId = `ws_${Date.now()}_${++this.connectionIdCounter}`;
    this.connections.set(connectionId, ws);

    console.log(`[WS] Connection opened: ${connectionId}`);

    ws.onmessage = async (event) => {
      try {
        const message: ClientMessage = JSON.parse(event.data as string);
        await this.handleMessage(ws, connectionId, message);
      } catch (error) {
        console.error(`[WS] Error handling message:`, error);
        this.sendError(ws, `Invalid message format: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    ws.onclose = () => {
      console.log(`[WS] Connection closed: ${connectionId}`);
      this.handleDisconnect(connectionId);
    };

    ws.onerror = (event) => {
      console.error(`[WS] Connection error for ${connectionId}:`, event);
    };
  }

  // Handle disconnection cleanup
  private handleDisconnect(connectionId: string): void {
    // Cancel any pending tool calls
    this.toolBridge.cancelWsCallsForConnection(connectionId);

    // Remove registered tools
    this.wsToolRegistry.unregisterConnection(connectionId);

    // Remove connection
    this.connections.delete(connectionId);
  }

  // Route incoming messages to appropriate handlers
  private async handleMessage(
    ws: WebSocket,
    connectionId: string,
    message: ClientMessage
  ): Promise<void> {
    switch (message.type) {
      case "register_tools":
        this.handleRegisterTools(ws, connectionId, message.tools);
        break;

      case "get_signatures":
        await this.handleGetSignatures(ws, connectionId, message.serverNames, message.toolNames);
        break;

      case "execute_code":
        await this.handleExecuteCode(ws, connectionId, message.executionId, message.code);
        break;

      case "tool_result":
        this.handleToolResult(message.callId, message.result, message.error);
        break;

      default:
        this.sendError(ws, `Unknown message type: ${(message as any).type}`);
    }
  }

  // Handle tool registration
  private handleRegisterTools(
    ws: WebSocket,
    connectionId: string,
    tools: ClientToolDescriptor[]
  ): void {
    try {
      const registered = this.wsToolRegistry.registerTools(connectionId, tools);
      this.send(ws, {
        type: "success",
        message: `Registered ${registered.length} tools`,
      });
      console.log(`[WS] Registered ${registered.length} tools for ${connectionId}`);
    } catch (error) {
      this.sendError(ws, `Failed to register tools: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Handle signature request
  private async handleGetSignatures(
    ws: WebSocket,
    connectionId: string,
    serverNames?: string[],
    toolNames?: string[]
  ): Promise<void> {
    try {
      // Get MCP signatures
      const mcpSignatures = await this.mcpRegistry.getSignatures({
        serverNames,
        toolNames,
      });

      // Get WebSocket tool signatures for this connection
      const wsTools = this.wsToolRegistry.getToolsForConnection(connectionId);
      let wsSignatures = "";

      if (wsTools.length > 0) {
        const fullFile = await generateFullTsFile("main", wsTools);
        wsSignatures = `\n\n${fullFile}`;
      }

      this.send(ws, {
        type: "signatures",
        content: mcpSignatures + wsSignatures,
      });
    } catch (error) {
      this.sendError(ws, `Failed to get signatures: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Handle code execution
  private async handleExecuteCode(
    ws: WebSocket,
    connectionId: string,
    executionId: string,
    code: string
  ): Promise<void> {
    try {
      const result = await this.codeExecutor.executeCodeForConnection(code, connectionId);

      this.send(ws, {
        type: "execution_result",
        executionId,
        success: result.success,
        output: result.output,
      });
    } catch (error) {
      this.send(ws, {
        type: "execution_result",
        executionId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Handle tool result from client
  private handleToolResult(callId: string, result?: unknown, error?: string): void {
    this.toolBridge.resolveWsToolCall(callId, result, error);
  }

  // Send a message to WebSocket client
  private send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  // Send an error message
  private sendError(ws: WebSocket, message: string): void {
    this.send(ws, { type: "error", message });
  }
}

// ============================================================================
// Standalone Server Entry Point
// ============================================================================

if (import.meta.main) {
  const serverConfigs = JSON.parse(
    await Deno.readTextFile(new URL("../../mcp_config.json", import.meta.url))
  );

  // Initialize MCP registry
  console.log("Initializing MCP registry...");
  const mcpRegistry = await McpRegistry.create(serverConfigs);
  console.log(`Loaded ${mcpRegistry.getAllTools().length} MCP tools`);

  // Create ToolBridge with MCP tools
  const toolBridge = new ToolBridge(mcpRegistry.getAllTools());

  // Start RPC server for tool calls
  const RPC_PORT = parseInt(Deno.env.get("RPC_SERVER_PORT") || "9732");
  Deno.serve({ port: RPC_PORT, hostname: "0.0.0.0" }, toolBridge.getRpcServer());
  console.log(`RPC Server running on http://localhost:${RPC_PORT}`);

  // Create WebSocket server
  const wsServer = new WsServer(mcpRegistry, toolBridge);

  // Start WebSocket server
  const WS_PORT = parseInt(Deno.env.get("WS_SERVER_PORT") || "9733");

  Deno.serve({ port: WS_PORT, hostname: "0.0.0.0" }, (req) => {
    if (req.headers.get("upgrade") === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(req);
      wsServer.handleConnection(socket);
      return response;
    }

    return new Response("WebSocket server. Connect using ws:// protocol.", {
      status: 426,
      headers: { "Upgrade": "websocket" },
    });
  });

  console.log(`WebSocket Server running on ws://localhost:${WS_PORT}`);
  console.log("\nWebSocket Protocol:");
  console.log("  register_tools  - Register custom tools for this connection");
  console.log("  get_signatures  - Get TypeScript signatures for all tools");
  console.log("  execute_code    - Execute code with access to MCP + custom tools");
  console.log("  tool_result     - Return result for a tool call");

  Deno.addSignalListener("SIGINT", async () => {
    console.log("\nShutting down...");
    await mcpRegistry.disconnect();
    Deno.exit(0);
  });
}
