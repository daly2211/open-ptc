import { schemaToTypeGuard } from "./signature-generator.ts";
import { cleanupVariableName, type BaseToolDefinition } from "./tool-types.ts";
import type { ClientToolDescriptor } from "./ws-protocol.ts";

// WebSocket tool definition with connection-specific metadata
export interface WsToolDefinition extends BaseToolDefinition {
  connectionId: string;
  namespace: string;
}

// Registry for managing WebSocket client tools (each connection has its own isolated namespace)
export class WsToolRegistry {
  private toolsByConnection = new Map<string, WsToolDefinition[]>();
  private toolsByRef = new Map<string, WsToolDefinition>();

  // Generate a unique namespace for a connection
  private generateNamespace(connectionId: string): string {
    return `main_${connectionId}`;
  }

  // Register tools for a WebSocket connection
  registerTools(
    connectionId: string,
    tools: ClientToolDescriptor[]
  ): WsToolDefinition[] {
    const namespace = this.generateNamespace(connectionId);
    const registeredTools: WsToolDefinition[] = [];

    for (const tool of tools) {
      const cleanToolName = cleanupVariableName(tool.name);
      const referenceName = `${namespace}.${cleanToolName}`;

      // Validate input schema exists
      const inputSchema = tool.inputSchema || {
        type: "object",
        properties: {},
        additionalProperties: true,
      };

      const wsTool: WsToolDefinition = {
        connectionId,
        namespace,
        referenceName,
        toolName: tool.name,
        cleanToolName,
        description: tool.description,
        inputSchema,
        outputSchema: tool.outputSchema,
        guardFunction: schemaToTypeGuard(inputSchema),
      };

      registeredTools.push(wsTool);
      this.toolsByRef.set(referenceName, wsTool);
    }

    // Store tools by connection
    const existingTools = this.toolsByConnection.get(connectionId) || [];
    this.toolsByConnection.set(connectionId, [...existingTools, ...registeredTools]);

    return registeredTools;
  }

  // Unregister all tools for a connection (called on disconnect)
  unregisterConnection(connectionId: string): void {
    const wsTools = this.toolsByConnection.get(connectionId);
    if (wsTools) {
      for (const wsTool of wsTools) {
        this.toolsByRef.delete(wsTool.referenceName);
      }
    }
    this.toolsByConnection.delete(connectionId);
  }

  // Get all tools registered for a specific connection
  getToolsForConnection(connectionId: string): WsToolDefinition[] {
    return this.toolsByConnection.get(connectionId) || [];
  }

  // Get a tool by its full reference name
  getTool(referenceName: string): WsToolDefinition | undefined {
    return this.toolsByRef.get(referenceName);
  }

  // Get the connection ID for a tool reference
  getConnectionForTool(referenceName: string): string | undefined {
    return this.toolsByRef.get(referenceName)?.connectionId;
  }

  // Check if a connection has any registered tools
  hasTools(connectionId: string): boolean {
    const wsTools = this.toolsByConnection.get(connectionId);
    return wsTools !== undefined && wsTools.length > 0;
  }

  // Get count of tools for a connection
  getToolCount(connectionId: string): number {
    return this.toolsByConnection.get(connectionId)?.length || 0;
  }

  // Get all registered tool reference names
  getAllToolRefs(): string[] {
    return Array.from(this.toolsByRef.keys());
  }
}
