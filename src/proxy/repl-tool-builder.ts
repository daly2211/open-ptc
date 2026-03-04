import { generateFullTsFile } from "@/codegen/signature-generator.ts";
import type { BaseToolDefinition } from "@/shared/tool-types.ts";
import type { ProxyTool } from "./types.ts";
import type { McpToolDefinition } from "@/mcp/mcp-registry.ts";

export async function buildReplTool(
  runtimeTools: ProxyTool[],
  mcpTools: McpToolDefinition[] = []
): Promise<object> {
  // Build tool definitions for runtime tools
  const runtimeDefs: BaseToolDefinition[] = runtimeTools.map(t => ({
    referenceName: t.name,
    toolName: t.name,
    cleanToolName: t.name,
    description: t.description,
    inputSchema: t.parameters || { type: "object", properties: {} },
    outputSchema: t.output_schema,
    guardFunction: () => true,
  }));

  // Build tool definitions for MCP tools (they're already BaseToolDefinition-like)
  const mcpDefs: BaseToolDefinition[] = mcpTools.map(t => ({
    referenceName: t.referenceName,
    toolName: t.toolName,
    cleanToolName: t.cleanToolName,
    description: t.description,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
    guardFunction: t.guardFunction,
  }));

  // Group runtime tools under "main" namespace
  const allSignatures: string[] = [];

  if (runtimeDefs.length > 0) {
    const mainSigs = await generateFullTsFile("main", runtimeDefs);
    allSignatures.push(mainSigs);
  }

  // Group MCP tools by server
  const mcpByServer = new Map<string, BaseToolDefinition[]>();
  for (const tool of mcpDefs) {
    const serverName = tool.referenceName.split(".")[0];
    if (!mcpByServer.has(serverName)) {
      mcpByServer.set(serverName, []);
    }
    mcpByServer.get(serverName)!.push(tool);
  }

  for (const [serverName, tools] of mcpByServer) {
    const serverSigs = await generateFullTsFile(serverName, tools);
    allSignatures.push(serverSigs);
  }

  const signatures = allSignatures.join("\n\n");

  return {
    type: "function",
    name: "code_executor",
    description: `Execute TypeScript/JavaScript code in a sandboxed environment.

Available functions:
${signatures}

Use await for all function calls. Use console.log() to produce output.`,
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "TypeScript/JavaScript code to execute",
        },
      },
      required: ["code"],
    },
  };
}

export function stripProxyFields(tool: ProxyTool): object {
  const { "open-ptc-runtime-function": _, ...rest } = tool;
  return rest;
}
