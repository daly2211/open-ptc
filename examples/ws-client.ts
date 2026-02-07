/**
 * WebSocket Client Example — Bidirectional Tool Calling
 *
 * Demonstrates the full round-trip:
 *   1. Client connects and registers local tool handlers on the server
 *   2. Client sends code for sandboxed execution
 *   3. When the sandbox calls a registered tool, the server routes the call
 *      back to this client over the same WebSocket
 *   4. Client executes the handler locally and returns the result
 *
 * Run:  deno run --allow-all examples/ws-client.ts
 */

import "@std/dotenv/load";
import type { ClientMessage, ServerMessage, ToolCallMessage, ClientToolDescriptor } from "@/ws/ws-protocol.ts";

const WS_SERVER_URL = Deno.env.get("WS_SERVER_URL") || "ws://localhost:9733";

interface ExecResult {
  success: boolean;
  output?: string;
  error?: string;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

class WsClient {
  private ws: WebSocket | null = null;
  private pendingExecs = new Map<string, {
    resolve: (result: ExecResult) => void;
    reject: (error: Error) => void;
  }>();
  private toolHandlers = new Map<string, ToolHandler>();
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_SERVER_URL);

      this.ws.onopen = () => {
        this.connected = true;
        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          this.handleMessage(JSON.parse(event.data));
        } catch (error) {
          console.error("Failed to parse message:", error);
        }
      };

      this.ws.onerror = () => reject(new Error("WebSocket connection failed"));

      this.ws.onclose = () => {
        this.connected = false;
        this.connectPromise = null;
      };
    });

    return this.connectPromise;
  }

  registerToolHandler(name: string, handler: ToolHandler): void {
    this.toolHandlers.set(name, handler);
  }

  registerTools(tools: ClientToolDescriptor[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Registration timeout")), 5000);
      
      const handler = (event: MessageEvent) => {
        const msg: ServerMessage = JSON.parse(event.data);
        if (msg.type === "success") {
          clearTimeout(timeout);
          this.ws?.removeEventListener("message", handler);
          resolve();
        } else if (msg.type === "error") {
          clearTimeout(timeout);
          this.ws?.removeEventListener("message", handler);
          reject(new Error(msg.message));
        }
      };

      this.ws?.addEventListener("message", handler);
      this.send({ type: "register_tools", tools });
    });
  }

  getSignatures(): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Signature fetch timeout")), 5000);
      
      const handler = (event: MessageEvent) => {
        const msg: ServerMessage = JSON.parse(event.data);
        if (msg.type === "signatures") {
          clearTimeout(timeout);
          this.ws?.removeEventListener("message", handler);
          resolve(msg.content);
        } else if (msg.type === "error") {
          clearTimeout(timeout);
          this.ws?.removeEventListener("message", handler);
          reject(new Error(msg.message));
        }
      };

      this.ws?.addEventListener("message", handler);
      this.send({ type: "get_signatures", serverNames: [], toolNames: [] });
    });
  }

  executeCode(code: string): Promise<ExecResult> {
    const executionId = `exec_${Date.now()}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Execution timeout")), 60000);
      
      this.pendingExecs.set(executionId, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      this.send({ type: "execute_code", executionId, code });
    });
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "tool_call":
        this.handleToolCall(message as ToolCallMessage);
        break;

      case "execution_result": {
        const pending = this.pendingExecs.get(message.executionId);
        if (pending) {
          this.pendingExecs.delete(message.executionId);
          pending.resolve({
            success: message.success,
            output: message.output,
            error: message.error,
          });
        }
        break;
      }

      case "error":
        console.error("Server error:", message.message);
        break;
    }
  }

  /** Handle a tool_call routed back from the sandbox via the server. */
  private async handleToolCall(message: ToolCallMessage): Promise<void> {
    const handler = this.toolHandlers.get(message.toolName);

    if (!handler) {
      this.send({
        type: "tool_result",
        callId: message.callId,
        error: `No handler for tool: ${message.toolName}`,
      });
      return;
    }

    try {
      const result = await handler(message.args as Record<string, unknown>);
      this.send({
        type: "tool_result",
        callId: message.callId,
        result,
      });
    } catch (error) {
      this.send({
        type: "tool_result",
        callId: message.callId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  disconnect(): void {
    this.ws?.close();
  }
}

// — Demo ——————————————————————————————————————————————————————————————————————

async function main() {
  const client = new WsClient();

  try {
    console.log("Connecting to WebSocket server...");
    await client.connect();
    console.log("Connected");

    // Step 1 — Register local handlers that the sandbox can call back into
    console.log("\nRegistering tool handlers...");

    client.registerToolHandler("get_user", (args: unknown) => {
      const { userId } = args as { userId: number };
      console.log(`  get_user called with userId: ${userId}`);
      return Promise.resolve({
        id: userId,
        name: "John Doe",
        email: "john@example.com",
      });
    });

    client.registerToolHandler("calculate", (args: unknown) => {
      const { a, b, operation } = args as { a: number; b: number; operation: string };
      console.log(`  calculate called: ${a} ${operation} ${b}`);
      const ops: Record<string, (x: number, y: number) => number> = {
        add: (x, y) => x + y,
        subtract: (x, y) => x - y,
        multiply: (x, y) => x * y,
        divide: (x, y) => x / y,
      };
      return Promise.resolve({ result: ops[operation]?.(a, b) ?? 0 });
    });

    client.registerToolHandler("get_temperature", (args: unknown) => {
      const { city } = args as { city: string };
      console.log(`  get_temperature called for city: ${city}`);
      return Promise.resolve(25); // Example temperature
    });

    const toolsToRegister: ClientToolDescriptor[] = [
      {
        name: "get_user",
        description: "Get user information by ID",
        inputSchema: {
          type: "object",
          properties: {
            userId: { type: "number", description: "The user ID to fetch" },
          },
          required: ["userId"],
        },
      },
      {
        name: "calculate",
        description: "Perform basic arithmetic operations",
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "number" },
            operation: { type: "string", enum: ["add", "subtract", "multiply", "divide"] },
          },
          required: ["a", "b", "operation"],
        },
      },
      {
        name: "get_temperature",
        description: "Get the current temperature for a city",
        inputSchema: {
          type: "object",
          properties: {
            city: { type: "string", description: "The city to get the temperature for" },
          },
          required: ["city"],
        },
        outputSchema: {
          type: "number",
          description: "The current temperature in Celsius",
        },
      },
    ];
    await client.registerTools(toolsToRegister);
    console.log("Tools registered");

    // Step 2 — Fetch the TypeScript signatures the server generated
    console.log("\nFetching tool signatures...");
    const signatures = await client.getSignatures();
    console.log("Signatures preview:", signatures.slice(0, 200) + "...");

    // Step 3 — Execute code in the sandbox; it calls our tools back
    console.log("\nExecuting code...");
    const code = `
const user = await main.get_user({ userId: 42 });
console.log("User:", JSON.stringify(user, null, 2));

const calc = await main.calculate({ a: 10, b: 5, operation: "multiply" });
console.log("Calculation result:", calc.result);

const temp = await main.get_temperature({ city: "New York" });
console.log("Temperature:", temp);
`;

    const result = await client.executeCode(code);
    console.log(result.success ? "Execution succeeded" : "Execution failed");
    if (result.output) console.log("Output:", result.output);
    if (result.error) console.error("Error:", result.error);

  } catch (error) {
    console.error("Error:", error);
  } finally {
    await new Promise(r => setTimeout(r, 500));
    client.disconnect();
  }
}

if (import.meta.main) {
  main();
}
