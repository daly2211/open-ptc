import type { ToolDefinition } from "./mcp-registry.ts";

export class CodeExecutionEngine {
  private readonly toolsByServer: Map<string, ToolDefinition[]>;

  constructor(toolsByServer: Map<string, ToolDefinition[]>) {
    this.toolsByServer = toolsByServer;
  }

  private generateProxyCode(): string {
    const serverProxies: string[] = [];

    for (const [serverName, tools] of this.toolsByServer.entries()) {
      const toolProxies = tools
        .map(
          (tool) =>
            `  ${tool.cleanToolName}: (input) => callTool('${tool.referenceName}', input)`,
        )
        .join(",\n");

      serverProxies.push(
        `const ${serverName} = {\n${toolProxies}\n};`,
      );
    }

    return serverProxies.join("\n\n");
  }

  async executeCode(
    code: string,
  ): Promise<{ success: boolean; output: string }> {
    const proxyCode = this.generateProxyCode();
    const rpcClientCode = await Deno.readTextFile(
      new URL("./jrpc-client.ts", import.meta.url),
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
      let timoutText = '';
      
      const TIMEOUT_MS = parseInt(Deno.env.get("CODE_EXECUTION_TIMEOUT_MS") || "30000");
      const timeout = setTimeout(() => {
        process.kill("SIGTERM");
        timoutText = `\n\n[Process terminated after exceeding timeout of ${TIMEOUT_MS} ms]`;
      }, TIMEOUT_MS);

      const { code, stdout, stderr } = await process.output();
      clearTimeout(timeout);

      const stdoutText = new TextDecoder().decode(stdout);
      const stderrText = new TextDecoder().decode(stderr);

      return { success: code === 0, output: stdoutText + "\n\n" + stderrText + timoutText };
    } finally {
      await Deno.remove(tempFile).catch(() => {});
    }
  }
}

if (import.meta.main) {
  await import("@std/dotenv/load");
  const { McpRegistry } = await import("./mcp-registry.ts");

  const servers = JSON.parse(
    await Deno.readTextFile(new URL("./mcp_config.json", import.meta.url)),
  );

  const registry = await McpRegistry.create(servers);
  const engine = new CodeExecutionEngine(registry.groupToolsByServer());

  const result = await engine.executeCode(`
    const result = await tavily_mcp.tavily_search({ 
      query: 'What is Model Context Protocol?',
      max_results: 1
    });
    console.log(result.results[0].title);
  `);

  console.log(result.output);
}
