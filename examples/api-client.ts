/**
 * REST API Client Example
 *
 * Demonstrates the three main HTTP endpoints:
 *   GET  /tree        — Browse available tools as a tree
 *   GET  /signatures  — Retrieve generated TypeScript signatures
 *   POST /exec        — Execute code in the sandbox
 *
 * Run:  deno run --allow-all examples/api-client.ts
 */

import "@std/dotenv/load";

const API_BASE = Deno.env.get("API_BASE_URL") || "http://localhost:9730";

interface ExecResult {
  success: boolean;
  output: string;
}

interface ErrorResponse {
  error: string;
  message?: string;
}

class ApiClient {
  constructor(private baseUrl: string) {}

  async getToolsTree(includeDescriptions = false, charLimit?: number): Promise<string> {
    const params = new URLSearchParams();
    params.set("descriptions", String(includeDescriptions));
    if (charLimit) params.set("charLimit", String(charLimit));
    
    const response = await fetch(`${this.baseUrl}/tree?${params}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    return await response.text();
  }

  async getSignatures(options?: { serverNames?: string[]; toolNames?: string[] }): Promise<string> {
    const params = new URLSearchParams();
    if (options?.serverNames) params.set("serverNames", options.serverNames.join(","));
    if (options?.toolNames) params.set("toolNames", options.toolNames.join(","));
    
    const url = params.toString() ? `${this.baseUrl}/signatures?${params}` : `${this.baseUrl}/signatures`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    return await response.text();
  }

  async executeCode(code: string): Promise<ExecResult> {
    const response = await fetch(`${this.baseUrl}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    
    if (!response.ok) {
      const error: ErrorResponse = await response.json();
      throw new Error(error.message || error.error);
    }
    
    return await response.json();
  }
}

async function main() {
  const client = new ApiClient(API_BASE);

  try {
    console.log("\n=== 1. Get Tools Tree ===");
    const tree = await client.getToolsTree(false);
    console.log(tree);

    console.log("\n=== 2. Get All Tool Signatures ===");
    const signatures = await client.getSignatures();
    console.log(signatures.slice(0, 500) + "...\n");

    console.log("\n=== 3. Execute Simple Code ===");
    const simpleCode = `
console.log("Hello from sandboxed execution!");
console.log("2 + 2 =", 2 + 2);
`;
    const result1 = await client.executeCode(simpleCode);
    console.log("Success:", result1.success);
    console.log("Output:", result1.output);

    console.log("\n=== 4. Execute Code with MCP Tools ===");
    console.log("Note: This requires MCP servers configured in mcp_config.json");
    const mcpCode = `
// Example: If you have an MCP server configured with tools,
// you can call them like this:
// const result = await <server_name>.<tool_name>({ arg: "value" });
// console.log(result);

console.log("Available tool namespaces are shown in the tree above");
`;
    const result2 = await client.executeCode(mcpCode);
    console.log("Output:", result2.output);

    console.log("\n=== All examples completed ===");
  } catch (error) {
    console.error("\n❌ Error:", error instanceof Error ? error.message : String(error));
    console.error("\nMake sure the server is running:");
    console.error("  deno run --allow-all src/servers/api-server.ts");
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
