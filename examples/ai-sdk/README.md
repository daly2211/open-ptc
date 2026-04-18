# Vercel AI SDK Integration with Open-PTC

Connects a Vercel AI SDK agent to the Open-PTC **WebSocket server** for bidirectional tool calling. Your TypeScript/JavaScript functions run locally; the sandbox calls them back through the WebSocket connection.

This is the TypeScript equivalent of the [Python LangGraph example](../langgraph/).

## How It Works

```
LLM  ──>  code_executor tool  ──>  WS Server  ──>  Deno sandbox
                                       │                  │
                                       │     tool_call     │
                                       │  <────────────    │
                                       │                   │
              Local function  <────────┘                   │
              (runs in Node)                               │
                    │                                      │
                    └──── tool_result ──>  WS Server ──>   │
                                                      continues
```

1. `createCodeExecutor()` connects to the WS server, registers your functions (with JSON Schemas), and fetches the TypeScript signatures the server produces
2. The signatures go into the tool description so the LLM knows the available API
3. When the LLM writes code that calls a function, the server sends a `tool_call` back over the WebSocket
4. The wrapper executes your function locally and sends back the result
5. The agent loop (`stopWhen: stepCountIs(N)`) allows multi-step tool usage

## Quick Start

```bash
# 1. Start the Open-PTC servers
deno run --allow-all src/server.ts  # or docker compose up

# 2. Install dependencies
cd examples/ai-sdk
npm install

# 3. Set up env
cp .env.example .env
# Then set at least one API key:
#   API_KEY=...
#   OPENAI_API_KEY=...
#
# Optional model routing vars used by example.ts:
#   BASE_URL=https://api.openai.com/v1
#   MODEL_NAME=gpt-5.2-chat
#   MODEL_API=chat   # chat | responses | completion

# 4. Run the example
npx tsx example.ts
```

## Usage

```typescript
import { generateText, stepCountIs } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createCodeExecutor } from "./code-executor.ts";

// Define regular functions to expose in the sandbox
const codeExecutor = await createCodeExecutor([
  {
    name: "get_weather",
    description: "Get weather for a location",
    parameters: {
      location: { type: "string", description: "City name" },
    },
    outputSchema: { type: "object" },
    handler: ({ location }) => ({ temp: 72, condition: "sunny" }),
  },
]);

const provider = createOpenAI({
  baseURL: process.env.BASE_URL ?? "https://api.openai.com/v1",
  apiKey: process.env.API_KEY ?? process.env.OPENAI_API_KEY ?? "",
  compatibility: "compatible",
});

const model = provider.chat(process.env.MODEL_NAME ?? "gpt-4o");

const { text } = await generateText({
  model,
  tools: { code_executor: codeExecutor },
  stopWhen: stepCountIs(10),
  prompt: "What's the weather in Paris?",
});
```

### Configuration

```typescript
const codeExecutor = await createCodeExecutor(functions, {
  wsUrl: "ws://custom-host:9733",  // WebSocket server URL
  timeout: 120_000,                // Execution timeout (ms)
});

// In AI SDK, the tool name is determined by the key in the `tools` object:
// tools: { code_executor: codeExecutor }
```

## Defining Functions

Functions are defined as plain objects with a `handler` and an `outputSchema`:

```typescript
import { ToolFunction } from "./code-executor.ts";

const myFunction: ToolFunction = {
  name: "search",
  description: "Search for items",
  parameters: {
    query: { type: "string", description: "Search query" },
    max_results: { type: "number", description: "Max results", default: 10 },
  },
  outputSchema: { type: "array" },
  handler: ({ query, max_results = 10 }) => {
    // Your implementation here
    return [{ title: "Result 1" }];
  },
};
```

### Parameter Types

| Type | JSON Schema | Description |
|------|-------------|-------------|
| `"string"` | `string` | Text values |
| `"number"` | `number` | Numeric values |
| `"boolean"` | `boolean` | True/false |
| `"object"` | `object` | Objects/dicts |
| `"array"` | `array` | Arrays/lists |

### Optional Parameters

Parameters with a `default` value or `required: false` are treated as optional:

```typescript
{
  parameters: {
    query: { type: "string" },                           // required
    limit: { type: "number", default: 10 },              // optional (has default)
    verbose: { type: "boolean", required: false },       // optional (explicit)
  }
}
```
