import "@std/dotenv/load";
import { McpServer, StreamableHttpTransport } from "mcp-lite";
import { Server } from "@mcp/sdk/server/index.js";
import { StdioServerTransport } from "@mcp/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@mcp/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const API_SERVER_URL = Deno.env.get("API_SERVER_URL") || "http://localhost:9730";
const MCP_SERVER_PORT = parseInt(Deno.env.get("MCP_SERVER_PORT") || "9731");
const useStdio = Deno.args.includes("--stdio");

type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
};

type GetToolsTreeArgs = {
  includeDescriptions?: boolean;
  charLimit?: number;
};

type GetToolSignaturesArgs = {
  serverNames?: string[];
  toolNames?: string[];
};

type ExecuteTypeScriptArgs = {
  code: string;
};

const toolDefinitions = {
  get_tools_tree: {
    description: "Get a tree view of available tools organized by server.",
    inputSchema: z.object({
      includeDescriptions: z.boolean().optional().describe("Include descriptions (default: false)"),
      charLimit: z.number().optional().describe("Max characters in output"),
    }),
    handler: async (args: GetToolsTreeArgs): Promise<ToolResponse> => {
      const params = new URLSearchParams();
      if (args.includeDescriptions) params.set("descriptions", "true");
      if (args.charLimit) params.set("charLimit", String(args.charLimit));
      const response = await fetch(`${API_SERVER_URL}/tree${params.toString() ? `?${params}` : ""}`);
      if (!response.ok) throw new Error(`API request failed: ${response.statusText}`);
      return { content: [{ type: "text", text: await response.text() }] };
    },
  },
  get_tool_signatures: {
    description: "Get TypeScript function signatures for tools with optional filtering.",
    inputSchema: z.object({
      serverNames: z.array(z.string()).optional().describe("Filter by server names"),
      toolNames: z.array(z.string()).optional().describe("Filter by tool names"),
    }),
    handler: async (args: GetToolSignaturesArgs): Promise<ToolResponse> => {
      const params = new URLSearchParams();
      if (args.serverNames?.length) params.set("serverNames", args.serverNames.join(","));
      if (args.toolNames?.length) params.set("toolNames", args.toolNames.join(","));
      const response = await fetch(`${API_SERVER_URL}/signatures${params.toString() ? `?${params}` : ""}`);
      if (!response.ok) throw new Error(`API request failed: ${response.statusText}`);
      return { content: [{ type: "text", text: await response.text() }] };
    },
  },
  execute_typescript_code: {
    description: "Execute TypeScript code in a sandbox with access to all MCP tools.",
    inputSchema: z.object({
      code: z.string().describe("TypeScript code to execute"),
    }),
    handler: async (args: ExecuteTypeScriptArgs): Promise<ToolResponse> => {
      const response = await fetch(`${API_SERVER_URL}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: args.code }),
      });
      if (!response.ok) throw new Error(`API request failed: ${response.statusText}`);
      return { content: [{ type: "text", text: JSON.stringify(await response.json(), null, 2) }] };
    },
  },
};

type ToolName = keyof typeof toolDefinitions;

function setupStdioServer() {
  const server = new Server({ name: "open-codemode", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: Object.entries(toolDefinitions).map(([name, def]) => ({
      name,
      description: def.description,
      inputSchema: zodToJsonSchema(def.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name as ToolName;
    const tool = toolDefinitions[toolName];
    if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);
    const args = request.params.arguments ?? {};
    return await tool.handler(args as never);
  });

  return server;
}

function setupHttpServer() {
  const server = new McpServer({ 
    name: "open-codemode", 
    version: "1.0.0", 
    schemaAdapter: (schema) => zodToJsonSchema(schema as z.ZodType) 
  });
  
  server.tool("get_tools_tree", toolDefinitions.get_tools_tree);
  server.tool("get_tool_signatures", toolDefinitions.get_tool_signatures);
  server.tool("execute_typescript_code", toolDefinitions.execute_typescript_code);

  return server;
}

if (import.meta.main) {
  if (useStdio) {
    const server = setupStdioServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`MCP Server running on stdio`);
  } else {
    const server = setupHttpServer();
    const transport = new StreamableHttpTransport();
    const httpHandler = transport.bind(server);
    Deno.serve({ port: MCP_SERVER_PORT, hostname: "0.0.0.0" }, (req) => httpHandler(req));
    console.log(`MCP Server: http://localhost:${MCP_SERVER_PORT} -> ${API_SERVER_URL}`);
  }
}
