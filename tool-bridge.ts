import { JSONRPCServer } from "@yieldray/json-rpc-ts";
import { McpClient } from "./mcp-client.ts";
import type { ToolDefinition } from "./mcp-registry.ts";

interface ToolRegistration {
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

export class ToolBridge {
  private readonly tools: Map<string, ToolRegistration> = new Map();
  private readonly rpcServer: JSONRPCServer;

  constructor(toolDefinitions: ToolDefinition[]) {
    for (const toolDef of toolDefinitions) {
      const registration: ToolRegistration = {
        referenceName: toolDef.referenceName,
        mcpClient: toolDef.mcpClient,
        toolName: toolDef.toolName,
        guardFunction: toolDef.guardFunction,
      };

      this.tools.set(toolDef.referenceName, registration);
    }

    this.rpcServer = new JSONRPCServer();
    this.rpcServer.setMethod("callTool", async (request: ToolCallRequest) => {
      return await this.handleToolCall(request);
    });
  }

  /**
   * Handle an incoming tool call request
   */
  private async handleToolCall(
    request: ToolCallRequest,
  ): Promise<ToolCallResponse> {
    const { toolRef, args = {} } = request;

    // Check if tool exists
    const tool = this.tools.get(toolRef);
    if (!tool) {
      return {
        success: false,
        error: `Tool not found: ${toolRef}`,
      };
    }

    // Validate arguments with guard function
    if (!tool.guardFunction(args)) {
      return {
        success: false,
        error:
          `Type validation failed for tool ${toolRef}. Arguments do not match expected schema.`,
      };
    }

    // Call the actual MCP tool
    try {
      const result = await tool.mcpClient.callTool({
        name: tool.toolName,
        arguments: args,
      });

      return {
        success: true,
        data: this.getStructuredToolResponse(result),
      };
    } catch {
      return {
        success: false,
        error: "Error calling tool " + toolRef,
      };
    }
  }

  /**
   * Get the HTTP handler for the RPC server
   */
  getRpcServer(): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
      const jsonString = await this.rpcServer.handleRequest(
        await request.text(),
      );
      return new Response(jsonString, {
        headers: { "content-type": "application/json" },
      });
    };
  }

  /**
   * Get list of all registered tool reference names
   */
  getRegisteredTools(): string[] {
    return Array.from(this.tools.keys());
  }

  getStructuredToolResponse(response: any): any {
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

  const registry = await McpRegistry.create(servers);
  const bridge = new ToolBridge(registry.getAllTools());
  

  Deno.serve({ port: Deno.env.get("RPC_SERVER_PORT") ? parseInt(Deno.env.get("RPC_SERVER_PORT")!) : 9732 }, bridge.getRpcServer());
  console.log("ToolBridge RPC server running on port " + (Deno.env.get("RPC_SERVER_PORT") || "9732"));
}
