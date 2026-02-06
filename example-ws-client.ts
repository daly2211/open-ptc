/**
 * Example WebSocket Client
 * 
 * Demonstrates how to:
 * 1. Connect to the WebSocket server
 * 2. Register custom tools
 * 3. Get tool signatures
 * 4. Execute code that uses both MCP and custom tools
 * 5. Handle tool calls from the server
 */

import "@std/dotenv/load";
import type { ClientMessage, ServerMessage, ToolCallMessage, ClientToolDescriptor } from "./ws-protocol.ts";

const WS_SERVER_URL = Deno.env.get("WS_SERVER_URL") || "ws://localhost:9733";

class ExampleWsClient {
  private ws: WebSocket | null = null;
  private pendingExecutions = new Map<string, {
    resolve: (result: any) => void;
    reject: (error: Error) => void;
  }>();
  private toolHandlers = new Map<string, (args: unknown) => Promise<unknown>>();
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  /**
   * Connect to the WebSocket server
   */
  async connect(): Promise<void> {
    if (this.connected) return;
    
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_SERVER_URL);

      this.ws.onopen = () => {
        console.log("Connected to WebSocket server");
        this.connected = true;
        resolve();
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(JSON.parse(event.data));
      };

      this.ws.onerror = (error) => {
        console.error("WebSocket error:", error);
        reject(error);
      };

      this.ws.onclose = () => {
        console.log("Disconnected from WebSocket server");
        this.connected = false;
        this.connectPromise = null;
      };
    });

    return this.connectPromise;
  }

  /**
   * Register a tool handler
   */
  registerToolHandler(name: string, handler: (args: unknown) => Promise<unknown>): void {
    this.toolHandlers.set(name, handler);
  }

  /**
   * Register tools with the server
   */
  async registerTools(tools: ClientToolDescriptor[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const messageHandler = (event: MessageEvent) => {
        const message: ServerMessage = JSON.parse(event.data);
        if (message.type === "success") {
          this.ws?.removeEventListener("message", messageHandler);
          console.log("Tools registered:", message.message);
          resolve();
        } else if (message.type === "error") {
          this.ws?.removeEventListener("message", messageHandler);
          reject(new Error(message.message));
        }
      };

      this.ws?.addEventListener("message", messageHandler);
      this.send({ type: "register_tools", tools });
    });
  }

  /**
   * Get tool signatures
   */
  async getSignatures(serverNames?: string[], toolNames?: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const messageHandler = (event: MessageEvent) => {
        const message: ServerMessage = JSON.parse(event.data);
        if (message.type === "signatures") {
          this.ws?.removeEventListener("message", messageHandler);
          resolve(message.content);
        } else if (message.type === "error") {
          this.ws?.removeEventListener("message", messageHandler);
          reject(new Error(message.message));
        }
      };

      this.ws?.addEventListener("message", messageHandler);
      this.send({ type: "get_signatures", serverNames, toolNames });
    });
  }

  /**
   * Execute code
   */
  async executeCode(code: string): Promise<{ success: boolean; output?: string; error?: string }> {
    const executionId = `exec_${Date.now()}`;

    return new Promise((resolve, reject) => {
      this.pendingExecutions.set(executionId, { resolve, reject });
      this.send({ type: "execute_code", executionId, code });
    });
  }

  /**
   * Handle incoming messages
   */
  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "tool_call":
        this.handleToolCall(message as ToolCallMessage);
        break;

      case "execution_result":
        const pending = this.pendingExecutions.get(message.executionId);
        if (pending) {
          this.pendingExecutions.delete(message.executionId);
          pending.resolve({
            success: message.success,
            output: message.output,
            error: message.error,
          });
        }
        break;

      case "error":
        console.error("Server error:", message.message);
        break;
    }
  }

  /**
   * Handle tool call from server
   */
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
      const result = await handler(message.args);
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

  /**
   * Send a message to the server
   */
  private send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Disconnect from the server
   */
  disconnect(): void {
    this.ws?.close();
  }
}

// ============================================================================
// Demo
// ============================================================================

async function main() {
  const client = new ExampleWsClient();

  try {
    // 1. Connect
    console.log("\n=== Connecting ===");
    await client.connect();

    // 2. Register tool handlers (these run locally when server calls them)
    console.log("\n=== Registering Tool Handlers ===");
    
    client.registerToolHandler("get_user", async (args: unknown) => {
      const { userId } = args as { userId: number };
      console.log(`[Local] get_user called with userId: ${userId}`);
      // Simulate fetching user data
      return {
        id: userId,
        name: "John Doe",
        email: "john@example.com",
      };
    });

    client.registerToolHandler("calculate", async (args: unknown) => {
      const { expression } = args as { expression: string };
      console.log(`[Local] calculate called with: ${expression}`);
      // Simple eval (don't do this in production!)
      return { result: eval(expression) };
    });

    // 3. Register tools with the server
    console.log("\n=== Registering Tools with Server ===");
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
        outputSchema: {
          type: "object",
          properties: {
            id: { type: "number" },
            name: { type: "string" },
            email: { type: "string" },
          },
        },
      },
      {
        name: "calculate",
        description: "Evaluate a mathematical expression",
        inputSchema: {
          type: "object",
          properties: {
            expression: { type: "string", description: "Math expression to evaluate" },
          },
          required: ["expression"],
        },
        outputSchema: {
          type: "object",
          properties: {
            result: { type: "number" },
          },
        },
      },
    ];
    await client.registerTools(toolsToRegister);

    // 4. Get signatures
    console.log("\n=== Getting Tool Signatures ===");
    const signatures = await client.getSignatures();
    console.log("Signatures:\n", signatures+ "...");

    // 5. Execute code that uses both MCP and custom tools
    console.log("\n=== Executing Code ===");
    const code = `
// Use a custom tool registered via WebSocket
const user = await main.get_user({ userId: 42 });
console.log("User:", JSON.stringify(user, null, 2));

// Use another custom tool
const calc = await main.calculate({ expression: "2 + 2 * 10" });
console.log("Calculation result:", calc.result);

// You can also use MCP tools here if available
// const searchResult = await tavily.tavily_search({ query: "hello" });
`;

    const result = await client.executeCode(code);
    console.log("\nExecution result:");
    console.log("Success:", result.success);
    console.log("Output:", result.output);

  } catch (error) {
    console.error("Error:", error);
  } finally {
    // Give some time for final messages
    await new Promise(r => setTimeout(r, 500));
    client.disconnect();
  }
}

if (import.meta.main) {
  main();
}
