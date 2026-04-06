/**
 * Open-PTC Unified Server
 *
 * Run any combination of services:
 *   --api      REST API for MCP tools (port 9730)
 *   --mcp      MCP Server for external clients (port 9731)
 *   --ws       WebSocket server for bidirectional tool calling (port 9733)
 *   --proxy    Open-PTC Proxy for programmatic tool calling (port 9734)
 *
 * The RPC server (port 9732) is internal-only, used by the sandbox to call tools.
 * It starts automatically when needed (--api, --ws, or --proxy).
 *
 * Usage:
 *   deno run --allow-all src/server.ts --api --ws --proxy
 *   deno run --allow-all src/server.ts --proxy  # Just Open-PTC Proxy
 *   deno run --allow-all src/server.ts         # Everything (default)
 */

import "@std/dotenv/load";
import { McpRegistry, type McpServerConfig } from "@/mcp/mcp-registry.ts";
import { ToolBridge } from "@/bridge/tool-bridge.ts";
import { CodeExecutionEngine } from "@/execution/sandbox-executor.ts";
import { WsServer } from "@/servers/ws-server.ts";
import { Proxy } from "@/proxy/proxy.ts";
import { McpServer, StreamableHttpTransport } from "mcp-lite";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";

// Parse CLI args
const args = Deno.args;
const enableApi = args.includes("--api") || args.length === 0 || args.includes("--all");
const enableMcp = args.includes("--mcp") || args.length === 0 || args.includes("--all");
const enableWs = args.includes("--ws") || args.length === 0 || args.includes("--all");
const enableProxy = args.includes("--proxy") || args.length === 0 || args.includes("--all");

// Ports
const RPC_PORT = parseInt(Deno.env.get("RPC_SERVER_PORT") || "9732");
const API_PORT = parseInt(Deno.env.get("API_SERVER_PORT") || "9730");
const MCP_PORT = parseInt(Deno.env.get("MCP_SERVER_PORT") || "9731");
const WS_PORT = parseInt(Deno.env.get("WS_SERVER_PORT") || "9733");
const PROXY_PORT = parseInt(Deno.env.get("PROXY_PORT") || "9734");
const LITELLM_URL = Deno.env.get("LITELLM_URL") ?? "http://localhost:4001";

// Determine if RPC is needed
const needsRpc = enableApi || enableWs || enableProxy;

function substituteEnvVars<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (_, key) => Deno.env.get(key) ?? "") as T;
  }
  if (Array.isArray(value)) {
    return value.map(substituteEnvVars) as T;
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = substituteEnvVars(v);
    }
    return result as T;
  }
  return value;
}

// Load MCP config
const rawConfig = JSON.parse(
  await Deno.readTextFile(new URL("../mcp_config.json", import.meta.url))
);
const serverConfigs: McpServerConfig[] = substituteEnvVars(rawConfig);

// Initialize shared infrastructure
console.log(`
 ██████╗ ██████╗ ███████╗███╗   ██╗      ██████╗ ████████╗ ██████╗
██╔═══██╗██╔══██╗██╔════╝████╗  ██║      ██╔══██╗╚══██╔══╝██╔════╝
██║   ██║██████╔╝█████╗  ██╔██╗ ██║█████╗██████╔╝   ██║   ██║     
██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║╚════╝██╔═══╝    ██║   ██║     
╚██████╔╝██║     ███████╗██║ ╚████║      ██║        ██║   ╚██████╗
 ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝      ╚═╝        ╚═╝    ╚═════╝
`);

console.log("Initializing MCP registry...");
const mcpRegistry = await McpRegistry.create(serverConfigs);
console.log(`Loaded ${mcpRegistry.getAllTools().length} MCP tools`);

const toolBridge = new ToolBridge(mcpRegistry.getAllTools());
const codeExecutor = new CodeExecutionEngine(mcpRegistry.groupToolsByServer());

// Track servers for cleanup
const servers: ReturnType<typeof Deno.serve>[] = [];

// Start RPC server (shared by all modes - internal use only)
if (needsRpc) {
  const rpcServer = Deno.serve({ port: RPC_PORT, hostname: "0.0.0.0" }, toolBridge.getRpcServer());
  servers.push(rpcServer);
  console.log(`[internal] RPC Server on port ${RPC_PORT} (sandbox <-> tools)`);
}

// API Server (MCP-only REST API)
if (enableApi) {
  const apiHandler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    try {
      if (url.pathname === "/tree" && req.method === "GET") {
        const includeDescriptions = url.searchParams.get("descriptions") === "true";
        const charLimit = url.searchParams.get("charLimit") ? parseInt(url.searchParams.get("charLimit")!) : undefined;
        const tree = mcpRegistry.getToolsTree({ includeDescriptions, charLimit });
        return new Response(tree, { headers: { "Content-Type": "text/plain" } });
      }

      if (url.pathname === "/signatures" && req.method === "GET") {
        const serverNames = url.searchParams.get("serverNames")?.split(",").filter(Boolean);
        const toolNames = url.searchParams.get("toolNames")?.split(",").filter(Boolean);
        const signatures = await mcpRegistry.getSignatures({ serverNames, toolNames });
        return new Response(signatures, { headers: { "Content-Type": "text/plain" } });
      }

      if (url.pathname === "/exec" && req.method === "POST") {
        const body = await req.json();
        const code = body.code;
        if (!code || typeof code !== "string") {
          return new Response(JSON.stringify({ error: "Missing or invalid 'code' field" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        const result = await codeExecutor.executeCode(code);
        return new Response(JSON.stringify(result, null, 2), { headers: { "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    } catch (error) {
      return new Response(JSON.stringify({ error: "Internal server error", message: error instanceof Error ? error.message : String(error) }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  };

  const apiServer = Deno.serve({ port: API_PORT, hostname: "0.0.0.0" }, apiHandler);
  servers.push(apiServer);
  console.log(`[OK] API Server on port ${API_PORT}`);
  console.log(`    GET  /tree       - Get tools tree view`);
  console.log(`    GET  /signatures - Get tool signatures`);
  console.log(`    POST /exec       - Execute code`);
}

// MCP Server (for external MCP clients)
if (enableMcp) {
  const mcpServer = new McpServer({
    name: "open-PTC",
    version: "1.0.0",
    schemaAdapter: (schema) => zodToJsonSchema(schema as z.ZodType),
  });

  mcpServer.tool("get_tools_tree", {
    description: "Get a tree view of available tools organized by server.",
    inputSchema: z.object({
      includeDescriptions: z.boolean().optional().describe("Include tool descriptions"),
      charLimit: z.number().optional().describe("Character limit for descriptions"),
    }),
    handler: async (args: { includeDescriptions?: boolean; charLimit?: number }) => {
      const params = new URLSearchParams();
      if (args.includeDescriptions) params.set("descriptions", "true");
      if (args.charLimit) params.set("charLimit", String(args.charLimit));
      const response = await fetch(`http://localhost:${API_PORT}/tree${params.toString() ? `?${params}` : ""}`);
      if (!response.ok) throw new Error(`API request failed: ${response.statusText}`);
      return { content: [{ type: "text", text: await response.text() }] };
    },
  });

  mcpServer.tool("get_tool_signatures", {
    description: "Get TypeScript function signatures for tools with optional filtering.",
    inputSchema: z.object({
      serverNames: z.array(z.string()).optional().describe("Filter by server names"),
      toolNames: z.array(z.string()).optional().describe("Filter by tool names"),
    }),
    handler: async (args: { serverNames?: string[]; toolNames?: string[] }) => {
      const params = new URLSearchParams();
      if (args.serverNames?.length) params.set("serverNames", args.serverNames.join(","));
      if (args.toolNames?.length) params.set("toolNames", args.toolNames.join(","));
      const response = await fetch(`http://localhost:${API_PORT}/signatures${params.toString() ? `?${params}` : ""}`);
      if (!response.ok) throw new Error(`API request failed: ${response.statusText}`);
      return { content: [{ type: "text", text: await response.text() }] };
    },
  });

  mcpServer.tool("execute_typescript_code", {
    description: "Execute TypeScript code in a sandbox with access to all MCP tools.",
    inputSchema: z.object({
      code: z.string().describe("TypeScript code to execute"),
    }),
    handler: async (args: { code: string }) => {
      const response = await fetch(`http://localhost:${API_PORT}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: args.code }),
      });
      if (!response.ok) throw new Error(`API request failed: ${response.statusText}`);
      return { content: [{ type: "text", text: JSON.stringify(await response.json(), null, 2) }] };
    },
  });

  const transport = new StreamableHttpTransport();
  const httpHandler = transport.bind(mcpServer);
  const mcpHttpServer = Deno.serve({ port: MCP_PORT, hostname: "0.0.0.0" }, (req) => httpHandler(req));
  servers.push(mcpHttpServer);
  console.log(`[OK] MCP Server on port ${MCP_PORT}`);
  console.log(`    MCP protocol for external clients`);
}

// WebSocket Server
if (enableWs) {
  const wsServer = new WsServer(mcpRegistry, toolBridge);
  wsServer.getWsToolRegistry() && codeExecutor.setWsToolRegistry(wsServer.getWsToolRegistry());

  const wsHandler = (req: Request): Response => {
    if (req.headers.get("upgrade") === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(req);
      wsServer.handleConnection(socket);
      return response;
    }
    return new Response("WebSocket server. Connect using ws:// protocol.", { status: 426, headers: { "Upgrade": "websocket" } });
  };

  const wsHttpServer = Deno.serve({ port: WS_PORT, hostname: "0.0.0.0" }, wsHandler);
  servers.push(wsHttpServer);
  console.log(`[OK] WebSocket Server on port ${WS_PORT}`);
  console.log(`    register_tools  - Register custom tools`);
  console.log(`    get_signatures  - Get TypeScript signatures`);
  console.log(`    execute_code    - Execute code with tools`);
  console.log(`    tool_result     - Return result for tool call`);
}

// Open-PTC Proxy
if (enableProxy) {
  const proxyInstance = new Proxy({
    litellmUrl: LITELLM_URL,
    toolBridge,
    codeExecutor,
    mcpTools: mcpRegistry.getAllTools(),
  });

  const proxyServer = Deno.serve({ port: PROXY_PORT, hostname: "0.0.0.0" }, proxyInstance.createHandler());
  servers.push(proxyServer);
  console.log(`[OK] Open-PTC Proxy on port ${PROXY_PORT}`);
  console.log(`    POST /v1/responses        - Programmatic tool calling (native Responses API)`);
  console.log(`    POST /v1/chat/completions - OpenAI chat translation (stream=false only)`);
  console.log(`    POST /v1/completions      - Direct downstream passthrough`);
  console.log(`    LiteLLM URL: ${LITELLM_URL}`);
}

// Summary
console.log("\n" + "=".repeat(50));
console.log("Open-PTC Unified Server running");
console.log("=".repeat(50));
if (!enableApi && !enableMcp && !enableWs && !enableProxy) {
  console.log("No services enabled. Use --api, --mcp, --ws, --proxy, or run without args for all.");
}

// Cleanup on exit
let isShuttingDown = false;
Deno.addSignalListener("SIGINT", async () => {
  if (isShuttingDown) {
    console.log("\nForcing immediate shutdown...");
    Deno.exit(1);
  }
  isShuttingDown = true;
  console.log("\nShutting down...");
  try {
    await mcpRegistry.disconnect();
    for (const server of servers) {
      await server.shutdown();
    }
  } catch (error) {
    console.error("Error during shutdown:", error);
  }
  Deno.exit(0);
});
