import type { McpToolDefinition } from "./mcp-registry.ts";
import type { WsToolRegistry } from "./ws-tool-registry.ts";

export class CodeExecutionEngine {
  private readonly mcpToolsByServer: Map<string, McpToolDefinition[]>;
  private wsToolRegistry?: WsToolRegistry;

  constructor(
    mcpToolsByServer: Map<string, McpToolDefinition[]>,
    wsToolRegistry?: WsToolRegistry
  ) {
    this.mcpToolsByServer = mcpToolsByServer;
    this.wsToolRegistry = wsToolRegistry;
  }

  /**
   * Set or update the WebSocket tool registry
   */
  setWsToolRegistry(registry: WsToolRegistry): void {
    this.wsToolRegistry = registry;
  }

  /**
   * Generate proxy code for MCP tools
   */
  private generateMcpProxyCode(): string {
    const serverProxies: string[] = [];

    for (const [serverName, mcpTools] of this.mcpToolsByServer.entries()) {
      const toolProxies = mcpTools
        .map(
          (mcpTool) =>
            `  ${mcpTool.cleanToolName}: (input) => callTool('${mcpTool.referenceName}', input)`
        )
        .join(",\n");

      serverProxies.push(`const ${serverName} = {\n${toolProxies}\n};`);
    }

    return serverProxies.join("\n\n");
  }

  /**
   * Generate proxy code for WebSocket tools (connection-specific)
   */
  private generateWsProxyCode(connectionId: string): string {
    if (!this.wsToolRegistry) {
      return "";
    }

    const wsTools = this.wsToolRegistry.getToolsForConnection(connectionId);
    if (wsTools.length === 0) {
      return "";
    }

    const toolProxies = wsTools
      .map(
        (wsTool) =>
          `  ${wsTool.cleanToolName}: (input) => callTool('${wsTool.referenceName}', input)`
      )
      .join(",\n");

    return `const main = {\n${toolProxies}\n};`;
  }

  /**
   * Generate full proxy code (MCP + optional WS tools)
   */
  private generateProxyCode(connectionId?: string): string {
    const mcpProxies = this.generateMcpProxyCode();

    if (connectionId) {
      const wsProxies = this.generateWsProxyCode(connectionId);
      return wsProxies ? `${mcpProxies}\n\n${wsProxies}` : mcpProxies;
    }

    return mcpProxies;
  }

  /**
   * Execute code in sandbox (existing API for non-WebSocket clients)
   */
  executeCode(
    code: string
  ): Promise<{ success: boolean; output: string }> {
    return this.runInSandbox(code, this.generateMcpProxyCode());
  }

  /**
   * Execute code in sandbox with connection-specific WebSocket tools
   */
  executeCodeForConnection(
    code: string,
    connectionId: string
  ): Promise<{ success: boolean; output: string }> {
    return this.runInSandbox(code, this.generateProxyCode(connectionId));
  }

  /**
   * Internal method to run code in Deno sandbox
   */
  private async runInSandbox(
    code: string,
    proxyCode: string
  ): Promise<{ success: boolean; output: string }> {
    const rpcClientCode = await Deno.readTextFile(
      new URL("./jrpc-client.ts", import.meta.url)
    );

    const rpcUrl = Deno.env.get("RPC_SERVER_URL") || "http://localhost:9732";
    const rpcPort = new URL(rpcUrl).port || "9732";

    const fullCode = `
${rpcClientCode}

${proxyCode}

// User code
${code}
`;

    const tempFile = await Deno.makeTempFile({ suffix: ".ts" });
    await Deno.writeTextFile(tempFile, fullCode);

    try {
      const command = new Deno.Command("deno", {
        args: [
          "run",
          "--no-prompt",
          `--allow-net=localhost:${rpcPort}`,
          "--allow-env=RPC_SERVER_URL",
          tempFile,
        ],
        env: {
          RPC_SERVER_URL: rpcUrl,
        },
        stdout: "piped",
        stderr: "piped",
      });

      const process = command.spawn();
      let timeoutText = "";

      const TIMEOUT_MS = parseInt(
        Deno.env.get("CODE_EXECUTION_TIMEOUT_MS") || "30000"
      );
      const timeout = setTimeout(() => {
        process.kill("SIGTERM");
        timeoutText = `\n\n[Process terminated after exceeding timeout of ${TIMEOUT_MS} ms]`;
      }, TIMEOUT_MS);

      const { code: exitCode, stdout, stderr } = await process.output();
      clearTimeout(timeout);

      const stdoutText = new TextDecoder().decode(stdout);
      const stderrText = new TextDecoder().decode(stderr);

      return {
        success: exitCode === 0,
        output: stdoutText + "\n\n" + stderrText + timeoutText,
      };
    } finally {
      await Deno.remove(tempFile).catch(() => {});
    }
  }
}

if (import.meta.main) {
  await import("@std/dotenv/load");
  const { McpRegistry } = await import("./mcp-registry.ts");

  const servers = JSON.parse(
    await Deno.readTextFile(new URL("./mcp_config.json", import.meta.url))
  );

  const mcpRegistry = await McpRegistry.create(servers);
  const codeExecutor = new CodeExecutionEngine(mcpRegistry.groupToolsByServer());

  const result = await codeExecutor.executeCode(`
    const result = await tavily.tavily_search({ 
      query: 'What is Model Context Protocol?',
      max_results: 1
    });
    console.log(result.results[0].title);
  `);

  console.log(result.output);
}
