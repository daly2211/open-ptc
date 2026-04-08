/**
 * Vercel AI SDK + Open-PTC Example
 *
 * Connects to the Open-PTC WebSocket server, registers local functions,
 * and creates an agent that executes TypeScript in a sandbox — calling your
 * functions back over the WebSocket connection.
 *
 * This is the TypeScript equivalent of the Python LangGraph example.
 *
 * Prerequisites:
 *   1. Start the servers:  deno run --allow-all src/server.ts  (or docker compose up)
 *   2. Set API_KEY (or OPENAI_API_KEY) in .env
 *   3. npm install
 *
 * Run:  npx tsx example.ts
 */

import "dotenv/config";
import { generateText, stepCountIs } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createReplTool, type ToolFunction } from "./repl-tool.ts";

const WS_URL = process.env.WS_SERVER_URL ?? "ws://localhost:9733";

// -- Model configuration -----------------------------------------------------

function getModel() {
  const baseURL = process.env.BASE_URL ?? "https://api.openai.com/v1";
  const apiKey = process.env.API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  const modelName = process.env.MODEL_NAME ?? "gpt-4o";
  const modelApi = (process.env.MODEL_API ?? "chat").toLowerCase();

  console.log(`Using model: ${modelName}`);

  const provider = createOpenAI({
    baseURL,
    apiKey,
    compatibility: "compatible",
  });

  if (modelApi === "responses") {
    return provider.responses(modelName);
  }

  if (modelApi === "completion") {
    return provider.completion(modelName);
  }

  // Default to chat for OpenAI-compatible endpoints (LiteLLM/proxies) that may
  // not implement the Responses API.
  return provider.chat(modelName);
}

// -- Define plain functions to expose in the sandbox -------------------------

const functions: ToolFunction[] = [
  {
    name: "get_temperature",
    description: "Get the current temperature for a city in Fahrenheit",
    parameters: {
      city: { type: "string", description: "City name to look up" },
    },
    outputSchema: { type: "number" },
    handler: ({ city }: { city: string }) => {
      const temps: Record<string, number> = {
        NYC: 72.0,
        LA: 85.0,
        Chicago: 65.0,
      };
      return temps[city] ?? 70.0;
    },
  },
  {
    name: "convert_temp",
    description: "Convert temperature from Fahrenheit to another unit",
    parameters: {
      fahrenheit: { type: "number", description: "Temperature in Fahrenheit" },
      to_unit: {
        type: "string",
        description: "Target unit",
        enum: ["celsius", "kelvin"],
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        fahrenheit: { type: "number" },
      },
    },
    handler: ({
      fahrenheit,
      to_unit,
    }: {
      fahrenheit: number;
      to_unit: string;
    }) => {
      if (to_unit === "celsius") {
        return Math.round(((fahrenheit - 32) * 5) / 9 * 10) / 10;
      }
      if (to_unit === "kelvin") {
        return {
          fahrenheit: Math.round(((fahrenheit - 32) * 5 / 9 + 273.15) * 10) /
            10,
        };
      }
      return { fahrenheit };
    },
  },
  {
    name: "calculate",
    description: "Perform a mathematical operation on two numbers",
    parameters: {
      a: { type: "number", description: "First number" },
      b: { type: "number", description: "Second number" },
      operation: {
        type: "string",
        description: "One of add, subtract, multiply, divide",
        enum: ["add", "subtract", "multiply", "divide"],
      },
    },
    outputSchema: { type: "number" },
    handler: ({
      a,
      b,
      operation,
    }: {
      a: number;
      b: number;
      operation: string;
    }) => {
      const ops: Record<string, (x: number, y: number) => number> = {
        add: (x, y) => x + y,
        subtract: (x, y) => x - y,
        multiply: (x, y) => x * y,
        divide: (x, y) => (y !== 0 ? x / y : Infinity),
      };
      return (ops[operation] ?? (() => 0))(a, b);
    },
  },
];

// -- Agent setup & run -------------------------------------------------------

async function main() {
  console.log("Connecting to Open-PTC WS server...");

  const codeExecutor = await createReplTool(functions, { wsUrl: WS_URL });
  console.log(codeExecutor.description);
  console.log("Connected & tools registered.\n");

  const model = getModel();

  const { text, steps } = await generateText({
    model,
    tools: { code_executor: codeExecutor },
    maxTokens: 4000,
    stopWhen: stepCountIs(10),
    system:
      "You are a helpful assistant that writes and executes TypeScript code. " +
      "When you need to solve a problem, use the code_executor tool. " +
      "The code_executor tool requires a 'code' parameter with TypeScript code as a string. " +
      "Always include console.log() in your code to produce output.",
    prompt: "What's the temperature in NYC in Celsius?",
    onStepFinish: ({ toolCalls, toolResults, text }) => {
      if (toolCalls.length) {
        console.log("\n--- Tool Calls ---");
        console.log(JSON.stringify(toolCalls, null, 2));
      }
      if (text) {
        console.log("\n--- Step Text ---");
        console.log(text);
      }
      if (toolResults.length) {
        console.log("\n--- Tool Results ---");
        console.log(JSON.stringify(
          toolResults.map((tr) => ({
            toolName: tr.toolName,
            output: tr.output,
          })),
          null,
          2,
        ));
      }
    },
  });

  console.log("\nFinal answer:", text);
  console.log(`\nCompleted in ${steps.length} step(s)`);

  process.exit(0);
}

main().catch((err) => {
  console.error("\nError:", err instanceof Error ? err.message : String(err));
  console.error("\nMake sure:");
  console.error(
    "  1. The Open-PTC servers are running (deno run --allow-all src/server.ts)",
  );
  console.error("  2. API_KEY or OPENAI_API_KEY is set in .env");
  console.error(
    "  3. MODEL_API is set to chat when using OpenAI-compatible proxy endpoints",
  );
  process.exit(1);
});
