import { McpClient } from "./mcp-client.ts";
import { 
  schemaToTypeGuard, 
  generateTsSignatureFromTool,
  generateFullTsFile 
} from "./signature-generator.ts";
import type {TransportConfig} from "./mcp-client.ts";


export interface McpServerConfig {
  name: string;
  transport: TransportConfig;
}

export interface ToolDefinition {
  referenceName: string;
  serverName: string;
  cleanServerName: string;
  toolName: string;
  cleanToolName: string;
  description?: string;
  inputSchema: object;
  outputSchema?: object | null;
  guardFunction: (value: unknown) => boolean;
  transport: TransportConfig;
  mcpClient: McpClient;
}

export function cleanupVariableName(name: string): string {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

export class McpRegistry {
  private tools: ToolDefinition[] = [];
  private toolsByRef = new Map<string, ToolDefinition>();
  private toolsByServer = new Map<string, ToolDefinition[]>();
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

        const toolDef: ToolDefinition = {
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

        this.tools.push(toolDef);
        this.toolsByRef.set(referenceName, toolDef);

        if (!this.toolsByServer.has(cleanServerName)) {
          this.toolsByServer.set(cleanServerName, []);
        }
        this.toolsByServer.get(cleanServerName)!.push(toolDef);
      }
    } catch (error) {
      console.error(`Failed to introspect server ${serverConfig.name}:`, error);
    }
  }

  getAllTools(): ToolDefinition[] {
    return [...this.tools];
  }

  getTool(referenceName: string): ToolDefinition | undefined {
    return this.toolsByRef.get(referenceName);
  }

  getToolsByServer(serverName: string): ToolDefinition[] {
    return this.toolsByServer.get(serverName) || [];
  }

  getToolReferenceNames(): string[] {
    return this.tools.map(t => t.referenceName);
  }

  getServerNames(): string[] {
    return Array.from(this.toolsByServer.keys());
  }

  groupToolsByServer(): Map<string, ToolDefinition[]> {
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

    for (const [serverName, tools] of this.toolsByServer.entries()) {
      lines.push(`// ========================================`);
      lines.push(`// Server: ${serverName}`);
      lines.push(`// ========================================`);
      lines.push("");
      
      const tsFile = await generateFullTsFile(serverName, tools);
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
    const selectedTools = new Set<ToolDefinition>();
    
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
    const toolsByServer = new Map<string, ToolDefinition[]>();
    for (const tool of filteredTools) {
      if (!toolsByServer.has(tool.cleanServerName)) {
        toolsByServer.set(tool.cleanServerName, []);
      }
      toolsByServer.get(tool.cleanServerName)!.push(tool);
    }
    
    const signatures: string[] = [];
    
    // If single tool, use individual signature
    if (filteredTools.length === 1) {
      const sig = await generateTsSignatureFromTool(filteredTools[0]);
      signatures.push(sig);
    }
    // If multiple tools but from single server, use generateFullTsFile
    else if (toolsByServer.size === 1) {
      const [serverName, tools] = Array.from(toolsByServer.entries())[0];
      const fullFile = await generateFullTsFile(serverName, tools);
      signatures.push(fullFile);
    }
    // If multiple servers, generate full file for each server
    else {
      for (const [serverName, tools] of toolsByServer.entries()) {
        const fullFile = await generateFullTsFile(serverName, tools);
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
      
      const tools = this.toolsByServer.get(serverName)!;
      tools.forEach((tool, toolIndex) => {
        const isLastTool = toolIndex === tools.length - 1;
        const branch = isLastTool ? "└───" : "├───";
        
        let line = `${toolPrefix}${branch}${tool.cleanToolName}`;
        
        if (config.includeDescriptions && tool.description) {
          const desc = tool.description.length > CHAR_LIMIT 
            ? tool.description.slice(0, CHAR_LIMIT) + "..."
            : tool.description;
          line += ` # ${desc}`.replace(/\r?\n|\r/g, ' ');
        }
        
        lines.push(line);
      });
    });
    
    return lines.join("\n");
  }
}
