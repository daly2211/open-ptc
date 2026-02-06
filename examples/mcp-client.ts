// Example MCP Client Usage
//
// This demonstrates how to connect to the open-codemode MCP server
// and use its tools to explore and execute code.

import { McpClient } from "@/mcp/mcp-client.ts";

const MCP_SERVER_URL = "http://localhost:9731";

async function main() {
  // Create client and connect
  const client = new McpClient({
    type: "http",
    url: MCP_SERVER_URL,
  });

  try {
    console.log("Connecting to MCP server...");
    await client.connect();
    console.log(`Connected to: ${client.getServerName()}\n`);

    // 1. List available tools
    console.log("=== Available Tools ===");
    const tools = await client.listTools();
    tools.tools.forEach((tool) => {
      console.log(`- ${tool.name}: ${tool.description}`);
    });
    console.log();

    // 2. Get tools tree view
    console.log("=== Tools Tree ===");
    const treeResult = await client.callTool({
      name: "get_tools_tree",
      arguments: {
        includeDescriptions: false,
      },
    });
    const treeContent = (treeResult as any).content[0];
    if (treeContent.type === "text") {
      console.log(treeContent.text);
    }
    console.log();

    // 3. Get tool signatures
    console.log("=== Tool Signatures ===");
    const signaturesResult = await client.callTool({
      name: "get_tool_signatures",
      arguments: {},
    });
    const sigContent = (signaturesResult as any).content[0];
    if (sigContent.type === "text") {
      console.log(sigContent.text);
    }
    console.log();

    // 4. Execute TypeScript code
    console.log("=== Execute TypeScript Code ===");
    const code = `
// Example: Use tools from connected MCP servers
const result = await tools.time.get_current_time({});
console.log("Current time:", result);

return { status: "success", time: result };
`;

    const execResult = await client.callTool({
      name: "execute_typescript_code",
      arguments: {
        code: code.trim(),
      },
    });
    console.log("Execution result:");
    const execContent = (execResult as any).content[0];
    if (execContent.type === "text") {
      console.log(execContent.text);
    }

  } catch (error) {
    console.error("Error:", error);
  } finally {
    await client.disconnect();
    console.log("\nDisconnected from MCP server");
  }
}

// Run if executed directly
if (import.meta.main) {
  main();
}
