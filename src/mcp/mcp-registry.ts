import { McpClient } from "./mcp-client.ts";
import {
  schemaToTypeGuard,
  generateTsSignatureFromTool,
  generateFullTsFile 
} from "@/codegen/signature-generator.ts";
import type { TransportConfig } from "@/mcp/mcp-client.ts";
import { cleanupVariableName, type BaseToolDefinition } from "@/shared/tool-types.ts";
export interface McpServerConfig {
  name: string;
  transport: TransportConfig;
}

// MCP-specific tool definition extending the base tool definition
// with MCP transport and client metadata
export interface McpToolDefinition extends BaseToolDefinition {
  serverName: string;
  cleanServerName: string;
  transport: TransportConfig;
  mcpClient: McpClient;
}

export class McpRegistry {
  private tools: McpToolDefinition[] = [];
  private toolsByRef = new Map<string, McpToolDefinition>();
  private toolsByServer = new Map<string, McpToolDefinition[]>();
  private clients = new Set<McpClient>();

  private constructor() {}

  static async create(serverConfigs: McpServerConfig[]): Promise<McpRegistry> {
    const registry = new McpRegistry();

    for (const serverConfig of serverConfigs) {
      await registry.introspectServer(serverConfig);
    }

    return registry;
  }

  private async introspectServer(serverConfig: McpServerConfig): Promise<void> {
    const mcpClient = new McpClient(serverConfig.transport);

    try {
      await mcpClient.connect();
      this.clients.add(mcpClient);

      const toolsResult = await mcpClient.listTools();

      const serverName = mcpClient.getServerName() ?? serverConfig.name;
      const cleanServerName = cleanupVariableName(serverName);

      for (const tool of toolsResult.tools) {
        const toolName = tool.name;
        const cleanToolName = cleanupVariableName(toolName);
        const referenceName = `${cleanServerName}.${cleanToolName}`;

        const inputSchema = tool.inputSchema ||
          { type: "object", properties: {}, additionalProperties: true };
        const guardFunction = schemaToTypeGuard(inputSchema);

        const mcpTool: McpToolDefinition = {
          referenceName,
          serverName,
          cleanServerName,
          toolName,
          cleanToolName,
          description: tool.description,
          inputSchema,
          outputSchema: tool.outputSchema,
          guardFunction,
          transport: serverConfig.transport,
          mcpClient,
        };

        this.tools.push(mcpTool);
        this.toolsByRef.set(referenceName, mcpTool);

        if (!this.toolsByServer.has(cleanServerName)) {
          this.toolsByServer.set(cleanServerName, []);
        }
        this.toolsByServer.get(cleanServerName)!.push(mcpTool);
      }
    } catch (error) {
      console.error(`Failed to introspect server ${serverConfig.name}:`, error);
    }
  }

  getAllTools(): McpToolDefinition[] {
    return [...this.tools];
  }

  getTool(referenceName: string): McpToolDefinition | undefined {
    return this.toolsByRef.get(referenceName);
  }

  getToolsByServer(serverName: string): McpToolDefinition[] {
    return this.toolsByServer.get(serverName) || [];
  }

  getToolReferenceNames(): string[] {
    return this.tools.map(t => t.referenceName);
  }

  getServerNames(): string[] {
    return Array.from(this.toolsByServer.keys());
  }

  groupToolsByServer(): Map<string, McpToolDefinition[]> {
    return new Map(this.toolsByServer);
  }

  async disconnect(): Promise<void> {
    for (const client of this.clients) {
      try {
        await client.disconnect();
      } catch (error) {
        console.error("Error disconnecting client:", error);
      }
    }

    this.clients.clear();
    this.tools = [];
    this.toolsByRef.clear();
    this.toolsByServer.clear();
  }

  async generateTypeScriptSignatures(): Promise<string> {
    const lines: string[] = [
      "// Generated MCP Tool Signatures",
      `// Generated on: ${new Date().toISOString()}`,
      "",
    ];

    for (const [serverName, mcpTools] of this.toolsByServer.entries()) {
      lines.push(`// ========================================`);
      lines.push(`// Server: ${serverName}`);
      lines.push(`// ========================================`);
      lines.push("");
      
      const tsFile = await generateFullTsFile(serverName, mcpTools);
      lines.push(tsFile);
      lines.push("");
    }

    return lines.join("\n");
  }

  async getSignatures(options?: {
    serverNames?: string[];
    toolNames?: string[];
  }): Promise<string> {
    // Collect tools based on OR logic
    const selectedTools = new Set<McpToolDefinition>();
    
    // Add all tools from specified servers
    if (options?.serverNames && options.serverNames.length > 0) {
      for (const serverName of options.serverNames) {
        const serverTools = this.toolsByServer.get(serverName);
        if (serverTools) {
          serverTools.forEach(tool => selectedTools.add(tool));
        }
      }
    }
    
    // Add tools by full reference name (servername.toolname)
    if (options?.toolNames && options.toolNames.length > 0) {
      for (const refName of options.toolNames) {
        const tool = this.toolsByRef.get(refName);
        if (tool) {
          selectedTools.add(tool);
        }
      }
    }
    
    // If no filters specified, return all tools
    const filteredTools = selectedTools.size > 0 
      ? Array.from(selectedTools) 
      : [...this.tools];
    
    // Group filtered tools by server
    const toolsByServer = new Map<string, McpToolDefinition[]>();
    for (const mcpTool of filteredTools) {
      if (!toolsByServer.has(mcpTool.cleanServerName)) {
        toolsByServer.set(mcpTool.cleanServerName, []);
      }
      toolsByServer.get(mcpTool.cleanServerName)!.push(mcpTool);
    }
    
    const signatures: string[] = [];
    
    // If single tool, use individual signature
    if (filteredTools.length === 1) {
      const sig = await generateTsSignatureFromTool(filteredTools[0]);
      signatures.push(sig);
    }
    // If multiple tools but from single server, use generateFullTsFile
    else if (toolsByServer.size === 1) {
      const [serverName, mcpTools] = Array.from(toolsByServer.entries())[0];
      const fullFile = await generateFullTsFile(serverName, mcpTools);
      signatures.push(fullFile);
    }
    // If multiple servers, generate full file for each server
    else {
      for (const [serverName, mcpTools] of toolsByServer.entries()) {
        const fullFile = await generateFullTsFile(serverName, mcpTools);
        signatures.push(fullFile);
      }
    }
    
    return signatures.join("\n");
  }

  getToolsTree(config: {includeDescriptions?: boolean, charLimit?: number} = {includeDescriptions: false}): string {
    const lines: string[] = ["tools"];
    const serverNames = Array.from(this.toolsByServer.keys());

    const CHAR_LIMIT = config.charLimit ?? 200; // Limit for description length in tree view
    
    serverNames.forEach((serverName, serverIndex) => {
      const isLastServer = serverIndex === serverNames.length - 1;
      const serverPrefix = isLastServer ? "└───" : "├───";
      const toolPrefix = isLastServer ? "    " : "│   ";
      
      lines.push(`${serverPrefix}${serverName}`);
      
      const mcpTools = this.toolsByServer.get(serverName)!;
      mcpTools.forEach((mcpTool, toolIndex) => {
        const isLastTool = toolIndex === mcpTools.length - 1;
        const branch = isLastTool ? "└───" : "├───";
        
        let line = `${toolPrefix}${branch}${mcpTool.cleanToolName}`;
        
        if (config.includeDescriptions && mcpTool.description) {
          const desc = mcpTool.description.length > CHAR_LIMIT 
            ? mcpTool.description.slice(0, CHAR_LIMIT) + "..."
            : mcpTool.description;
          line += ` # ${desc}`.replace(/\r?\n|\r/g, ' ');
        }
        
        lines.push(line);
      });
    });
    
    return lines.join("\n");
  }
}
