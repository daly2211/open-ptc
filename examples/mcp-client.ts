/**
 * MCP Client Example
 *
 * Connects to the open-codemode MCP server and demonstrates:
 *   - Listing available MCP tools
 *   - Browsing the tool tree
 *   - Retrieving TypeScript signatures
 *   - Executing code in the sandbox
 *
 * Run:  deno run --allow-all examples/mcp-client.ts
 */

import "@std/dotenv/load";
import { Client } from "@mcp/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@mcp/sdk/client/streamableHttp.js";

const MCP_SERVER_URL = Deno.env.get("MCP_SERVER_URL") || "http://localhost:9731";

interface TextContent {
  type: "text";
  text: string;
}

interface ToolResult {
  content: TextContent[];
}

function extractText(result: ToolResult): string {
  return result.content[0]?.text || "";
}

async function main() {
  const client = new Client(
    { name: "example-client", version: "1.0.0" },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL));

  try {
    console.log("Connecting to MCP server...");
    await client.connect(transport);
    console.log(`[OK] Connected to: ${client.getServerVersion()?.name || "unknown"}\n`);

    console.log("=== Available Tools ===");
    const toolList = await client.listTools();
    toolList.tools.forEach((tool) => {
      console.log(`  - ${tool.name}`);
      console.log(`    ${tool.description}\n`);
    });

    console.log("=== Tools Tree ===");
    const treeResult = await client.callTool({
      name: "get_tools_tree",
      arguments: { includeDescriptions: false },
    });
    console.log(extractText(treeResult as ToolResult));

    console.log("\n=== Tool Signatures (sample) ===");
    const sigResult = await client.callTool({
      name: "get_tool_signatures",
      arguments: {},
    });
    const signatures = extractText(sigResult as ToolResult);
    console.log(signatures.slice(0, 600) + "...\n");

    console.log("=== Execute Code ===");
    const code = `
// Example: Simple TypeScript code execution in sandbox
console.log("Executing in sandbox!");
const data = { message: "Hello from MCP" };
console.log(JSON.stringify(data, null, 2));
`;

    const execResult = await client.callTool({
      name: "execute_typescript_code",
      arguments: { code: code.trim() },
    });
    console.log("Output:");
    console.log(extractText(execResult as ToolResult));

    console.log("\n[OK] All operations completed successfully");
  } catch (error) {
    console.error("\n[ERROR] Error:", error instanceof Error ? error.message : String(error));
    console.error("\nMake sure the MCP server is running:");
    console.error("  deno run --allow-all src/server.ts --mcp");
    Deno.exit(1);
  } finally {
    try {
      await client.close();
      await transport.close();
    } catch {
      // ignore
    }
    console.log("Disconnected");
  }
}

if (import.meta.main) {
  main();
}
