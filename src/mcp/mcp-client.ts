import { Client } from "@mcp/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@mcp/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@mcp/sdk/client/sse.js";
import { StdioClientTransport } from "@mcp/sdk/client/stdio.js";
import type { ListToolsResult } from "@mcp/sdk/types";

type CallToolArgs = Parameters<Client["callTool"]>[0];
type CallToolResponse = Awaited<ReturnType<Client["callTool"]>>;

interface HttpConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

interface SseConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  requestHeaders?: Record<string, string>;
}

interface StdioConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type TransportConfig = HttpConfig | SseConfig | StdioConfig;

export class McpClient {
  private readonly client: Client;
  private transport:
    | StreamableHTTPClientTransport
    | SSEClientTransport
    | StdioClientTransport
    | null = null;
  private connected = false;

  constructor(
    private readonly config: TransportConfig,
    clientName = "open-codemode",
    clientVersion = "1.0.0",
  ) {
    this.client = new Client(
      {
        name: clientName,
        version: clientVersion,
      },
      { capabilities: {} },
    );
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    switch (this.config.type) {
      case "http":
        this.transport = new StreamableHTTPClientTransport(
          new URL(this.config.url),
          this.config.headers
            ? { requestInit: { headers: this.config.headers } }
            : undefined,
        );
        break;

      case "sse":
        this.transport = new SSEClientTransport(
          new URL(this.config.url),
          {
            requestInit: this.config.requestHeaders
              ? { headers: this.config.requestHeaders }
              : undefined,
          },
        );
        break;

      case "stdio": {
        this.transport = new StdioClientTransport({
          command: this.config.command,
          args: this.config.args ?? [],
          env: this.config.env,
        });
        break;
      }
    }

    await this.client.connect(this.transport);
    this.connected = true;
  }

  getServerName(): string | null {
    return this.client.getServerVersion()?.name || null;
  }

  async listTools(): Promise<ListToolsResult> {
    this.ensureConnected();
    return await this.client.listTools();
  }

  async callTool(params: CallToolArgs): Promise<CallToolResponse> {
    this.ensureConnected();
    return await this.client.callTool(params);
  }

  async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    try {
      await this.client.close();
    } finally {
      this.transport?.close();
      this.transport = null;
      this.connected = false;
    }
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error("McpClient is not connected. Call connect() first.");
    }
  }
}

// Demo: Connect to each server and list tools
if (import.meta.main) {
  const servers = JSON.parse(
    await Deno.readTextFile(new URL("./mcp_config.json", import.meta.url))
  );

  for (const server of servers) {
    try {
      const client = new McpClient(server.transport);
      await client.connect();
      const tools = await client.listTools();
      console.log(`[${server.name}] Tools: ${tools.tools.length}`);
      await client.disconnect();
    } catch (error) {
      console.error(`[${server.name}] Error:`, error);
    }
  }
}
