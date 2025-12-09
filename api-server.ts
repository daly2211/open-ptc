import "@std/dotenv/load";
import { McpRegistry, type McpServerConfig } from "./mcp-registry.ts";
import { ToolBridge } from "./tool-bridge.ts";
import { CodeExecutionEngine } from "./sandbox-executor.ts";

const serverConfigs: McpServerConfig[] = JSON.parse(
  await Deno.readTextFile(new URL("./mcp_config.json", import.meta.url))
);

// Initialize registry and tools
const registry = await McpRegistry.create(serverConfigs);
const toolDefinitions = registry.getAllTools();
const toolsByServer = registry.groupToolsByServer();

const RPC_PORT = parseInt(Deno.env.get("RPC_SERVER_PORT") || "9732");
const API_PORT = parseInt(Deno.env.get("API_SERVER_PORT") || "9730");

// Start ToolBridge RPC server
const bridge = new ToolBridge(toolDefinitions);
const rpcHandler = bridge.getRpcServer();
const rpcServer = Deno.serve({ port: RPC_PORT, hostname: "0.0.0.0" }, rpcHandler);

// Create code execution engine
const engine = new CodeExecutionEngine(toolsByServer);

// HTTP API Server
const apiHandler = async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  try {
    // GET /tree - Get tools tree view
    if (url.pathname === "/tree" && req.method === "GET") {
      const includeDescriptions = url.searchParams.get("descriptions") === "true";
      const charLimit = url.searchParams.get("charLimit") ? parseInt(url.searchParams.get("charLimit")!) : undefined;
      
      const tree = registry.getToolsTree({ includeDescriptions, charLimit });
      
      return new Response(tree, {
        headers: { "Content-Type": "text/plain" },
      });
    }

    // GET /signatures - Get tool signatures with optional filters
    if (url.pathname === "/signatures" && req.method === "GET") {
      const serverNames = url.searchParams.get("serverNames")?.split(",").filter(Boolean);
      const toolNames = url.searchParams.get("toolNames")?.split(",").filter(Boolean);
      
      const signatures = await registry.getSignatures({
        serverNames,
        toolNames,
      });
      
      return new Response(signatures, {
        headers: { "Content-Type": "text/plain" },
      });
    }

    // POST /exec - Execute code
    if (url.pathname === "/exec" && req.method === "POST") {
      const body = await req.json();
      const code = body.code;

      if (!code || typeof code !== "string") {
        return new Response(
          JSON.stringify({ error: "Missing or invalid 'code' field" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const result = await engine.executeCode(code);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // 404 for unknown routes
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("API error:", error);
    return new Response(
      JSON.stringify({ 
        error: "Internal server error", 
        message: error instanceof Error ? error.message : String(error) 
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

const apiServer = Deno.serve({ port: API_PORT, hostname: "0.0.0.0" }, apiHandler);

console.log(`RPC Server running on http://localhost:${RPC_PORT}`);
console.log(`API Server running on http://localhost:${API_PORT}`);
console.log("   GET  /tree       - Get tools tree view");
console.log("   GET  /signatures - Get all tool signatures");
console.log("   POST /exec       - Execute code");

// Cleanup on exit
Deno.addSignalListener("SIGINT", async () => {
  console.log("\nShutting down...");
  await registry.disconnect();
  await rpcServer.shutdown();
  await apiServer.shutdown();
  Deno.exit(0);
});
