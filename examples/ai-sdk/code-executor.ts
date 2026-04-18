/**
 * Code Executor Wrapper for Vercel AI SDK Agents
 *
 * Connects to the Open-PTC WebSocket server to provide bidirectional
 * tool calling. Local TypeScript/JavaScript functions are registered as tools
 * on the server, and executed code can call them back through the WebSocket
 * connection.
 *
 * The server generates TypeScript signatures from the JSON schemas, which
 * are included in the tool description so the LLM knows how to call them.
 *
 * This is the TypeScript equivalent of the Python `code_executor.py` used
 * in the LangGraph example.
 */

import { tool } from "ai";
import { z } from "zod";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A plain function the user wants to expose in the sandbox. */
export interface ToolFunction {
  name: string;
  description: string;
  parameters: Record<string, ParameterDef>;
  returns?: string;
  outputSchema?: object;
  handler: (...args: any[]) => any | Promise<any>;
}

export interface ParameterDef {
  type: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
  required?: boolean;
  enum?: string[];
  default?: unknown;
}

/** Matches the server's ClientToolDescriptor protocol. */
interface ClientToolDescriptor {
  name: string;
  description?: string;
  inputSchema: object;
  outputSchema?: object;
}

/** WebSocket messages we send. */
type ClientMessage =
  | { type: "register_tools"; tools: ClientToolDescriptor[] }
  | { type: "get_signatures"; serverNames?: string[]; toolNames?: string[] }
  | { type: "execute_code"; executionId: string; code: string }
  | { type: "tool_result"; callId: string; result?: unknown; error?: string };

/** WebSocket messages we receive. */
interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// WebSocket Bridge
// ---------------------------------------------------------------------------

class WsBridge {
  private ws: WebSocket | null = null;
  private handlers: Map<string, ToolFunction["handler"]> = new Map();
  private pending = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private responseWaiters: Array<{
    expect: string[];
    resolve: (msg: ServerMessage) => void;
    reject: (e: Error) => void;
  }> = [];
  private connected = false;
  public signatures = "";

  constructor(
    private wsUrl: string,
    private functions: ToolFunction[],
    private timeout: number,
  ) {
    for (const fn of functions) {
      this.handlers.set(fn.name, fn.handler);
    }
  }

  // -- Lifecycle -------------------------------------------------------------

  async start(): Promise<void> {
    await this.connect();

    // Register tools
    const descriptors = this.functions.map(fnToDescriptor);
    const regResp = await this.sendAndWait(
      { type: "register_tools", tools: descriptors },
      ["success", "error"],
    );
    if (regResp.type === "error") {
      throw new Error(`Tool registration failed: ${regResp.message}`);
    }

    // Fetch signatures
    const sigResp = await this.sendAndWait(
      { type: "get_signatures" },
      ["signatures", "error"],
    );
    if (sigResp.type === "error") {
      throw new Error(`Failed to get signatures: ${sigResp.message}`);
    }
    this.signatures = (sigResp.content as string) ?? "";
  }

  stop(): void {
    this.ws?.close();
  }

  // -- Code execution --------------------------------------------------------

  async execute(code: string): Promise<string> {
    const executionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(executionId);
        resolve(`Execution timed out after ${this.timeout / 1000} seconds`);
      }, this.timeout);

      this.pending.set(executionId, {
        resolve: (msg: ServerMessage) => {
          clearTimeout(timer);
          if (msg.success) {
            resolve((msg.output as string) ?? "");
          } else {
            resolve(`Execution failed: ${msg.output ?? "Unknown error"}`);
          }
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.send({ type: "execute_code", executionId, code });
    });
  }

  // -- Internal networking ---------------------------------------------------

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.on("open", () => {
        this.connected = true;
        resolve();
      });

      this.ws.on("error", (err) => {
        if (!this.connected) reject(err);
      });

      this.ws.on("close", () => {
        this.connected = false;
      });

      this.ws.on("message", (data) => {
        try {
          const msg: ServerMessage = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch {
          /* ignore parse errors */
        }
      });
    });
  }

  private handleMessage(msg: ServerMessage): void {
    // Tool call from server → execute local handler
    if (msg.type === "tool_call") {
      this.handleToolCall(msg);
      return;
    }

    // Execution result
    if (msg.type === "execution_result") {
      const entry = this.pending.get(msg.executionId as string);
      if (entry) {
        this.pending.delete(msg.executionId as string);
        entry.resolve(msg);
      }
      return;
    }

    // Expected response (for sendAndWait)
    for (let i = 0; i < this.responseWaiters.length; i++) {
      const waiter = this.responseWaiters[i];
      if (waiter.expect.includes(msg.type)) {
        this.responseWaiters.splice(i, 1);
        waiter.resolve(msg);
        return;
      }
    }
  }

  private async handleToolCall(msg: ServerMessage): Promise<void> {
    const callId = msg.callId as string;
    const toolName = msg.toolName as string;
    const args = (msg.args as Record<string, unknown>) ?? {};

    const handler = this.handlers.get(toolName);
    if (!handler) {
      this.send({
        type: "tool_result",
        callId,
        error: `No handler for tool: ${toolName}`,
      });
      return;
    }

    try {
      const result = await handler(args);
      this.send({ type: "tool_result", callId, result });
    } catch (err) {
      this.send({
        type: "tool_result",
        callId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private sendAndWait(
    msg: ClientMessage,
    expect: string[],
    timeoutMs = 15_000,
  ): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for ${expect.join("/")}`));
      }, timeoutMs);

      this.responseWaiters.push({
        expect,
        resolve: (resp) => {
          clearTimeout(timer);
          resolve(resp);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.send(msg);
    });
  }
}

// ---------------------------------------------------------------------------
// JSON Schema helpers
// ---------------------------------------------------------------------------

const TS_TYPE_TO_JSON: Record<string, string> = {
  string: "string",
  number: "number",
  boolean: "boolean",
  object: "object",
  array: "array",
};

function fnToDescriptor(fn: ToolFunction): ClientToolDescriptor {
  const properties: Record<string, object> = {};
  const required: string[] = [];

  for (const [name, param] of Object.entries(fn.parameters)) {
    const prop: Record<string, unknown> = {};
    if (param.type) prop.type = TS_TYPE_TO_JSON[param.type] ?? param.type;
    if (param.description) prop.description = param.description;
    if (param.enum) prop.enum = param.enum;
    if (param.default !== undefined) prop.default = param.default;
    properties[name] = prop;

    if (param.required !== false && param.default === undefined) {
      required.push(name);
    }
  }

  const descriptor: ClientToolDescriptor = {
    name: fn.name,
    description: fn.description,
    inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
  };

  // Prefer explicit outputSchema; keep legacy inference for backward compatibility.
  if (fn.outputSchema) {
    descriptor.outputSchema = fn.outputSchema;
  } else if (fn.returns && fn.returns !== "void" && fn.returns !== "undefined") {
    const outputType = TS_TYPE_TO_JSON[fn.returns] ?? fn.returns;
    if (outputType && outputType !== "void" && outputType !== "undefined") {
      descriptor.outputSchema = { type: outputType };
    }
  }

  return descriptor;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CodeExecutorOptions {
  /** WebSocket server URL. Default: "ws://localhost:9733" */
  wsUrl?: string;
  /** Execution timeout in milliseconds. Default: 60_000 */
  timeout?: number;
}

/**
 * Create a Vercel AI SDK tool backed by the Open-PTC WebSocket server.
 *
 * Registers the provided functions as bidirectional tools on the server.
 * The server generates TypeScript signatures from the JSON schemas, which
 * are embedded in the tool description so the LLM knows what's available.
 *
 * When executed code calls a function, the server calls back over the
 * WebSocket and the function runs locally.
 *
 * @example
 * ```ts
 * const executor = await createCodeExecutor([
 *   {
 *     name: "get_weather",
 *     description: "Get the current weather for a city",
 *     parameters: { city: { type: "string", description: "City name" } },
 *     outputSchema: { type: "object" },
 *     handler: ({ city }) => ({ temp: 72, condition: "sunny" }),
 *   },
 * ]);
 *
 * const agent = new ToolLoopAgent({
 *   model: openai("gpt-4o"),
 *   tools: { code_executor: executor },
 * });
 * ```
 */
export async function createCodeExecutor(
  functions: ToolFunction[],
  options: CodeExecutorOptions = {},
) {
  const {
    wsUrl = "ws://localhost:9733",
    timeout = 60_000,
  } = options;

  if (!functions.length) {
    throw new Error("At least one function must be provided");
  }

  const bridge = new WsBridge(wsUrl, functions, timeout);
  await bridge.start();

  const description = [
    "Execute TypeScript/JavaScript code in a sandboxed environment.",
    "The code has access to the following functions:\n",
    bridge.signatures,
    "\nUse `await` for all function calls.",
    "Use `console.log()` to produce output — only logged values appear in the result.",
    "Example: `console.log(await main.get_temperature({ city: 'NYC' }))`",
  ].join("\n");

  const paramSchema = z.object({
    code: z.string().describe("TypeScript/JavaScript code to execute in the sandbox"),
  });

  return tool({
    description,
    parameters: paramSchema,
    execute: async ({ code }) => {
      return bridge.execute(code);
    },
  });
}

/**
 * Shorthand for createCodeExecutor.
 */
export const codeExecutor = createCodeExecutor;
