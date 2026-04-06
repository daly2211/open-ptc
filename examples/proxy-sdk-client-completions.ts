/**
 * Open-PTC Proxy Client Example — Using OpenAI SDK Chat Completions API
 *
 * This mirrors examples/proxy-sdk-client.ts behavior (tool loop + retries),
 * but uses client.chat.completions.create() against /v1/chat/completions.
 *
 * Run:
 *   deno run --allow-net --allow-env examples/proxy-sdk-client-completions.ts
 */

import "@std/dotenv/load";
import OpenAI from "npm:openai@^4.0.0";

const PROXY_URL = Deno.env.get("PROXY_URL") || "http://localhost:9734";
const MODEL = Deno.env.get("MODEL") || "trinity-large";

const client = new OpenAI({
  baseURL: `${PROXY_URL}/v1`,
  apiKey: "dummy",
});

const tools: any[] = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
    output_schema: {
      type: "object",
      properties: {
        city: { type: "string" },
        temp: { type: "number" },
        condition: { type: "string" },
      },
    },
    "open-ptc-runtime-function": true,
  },
  {
    type: "function",
    function: {
      name: "simgly_lookup",
      description: "Lookup information using simgly",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    output_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        answer: { type: "string" },
      },
    },
    "open-ptc-runtime-function": true,
  },
  {
    type: "function",
    function: {
      name: "google_search",
      description: "Search Google for information",
      parameters: {
        type: "object",
        properties: { question: { type: "string" } },
        required: ["question"],
      },
    },
  },
];

let failFirstGoogle = true;
function handleToolCall(name: string, args: Record<string, unknown>) {
  if (name === "google_search") {
    if (failFirstGoogle) {
      failFirstGoogle = false;
      return { response: `Google service is down for the moment. Q:${JSON.stringify(args)}` };
    }
    return {
      response:
        "Google service is up and running. Answer: uyx56er78ubyplo is the game id for Xinga 2 a steam game by black forest games",
    };
  }

  if (name === "get_weather") {
    return { city: args.city, temp: 72, condition: "sunny" };
  }

  if (name === "simgly_lookup") {
    return { query: args.query, answer: "uyx56er78ubyplo is the game id for Xinga 2" };
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function main() {
  console.log("=== Proxy + OpenAI SDK Chat Completions Example ===\n");
  console.log("Using baseURL:", `${PROXY_URL}/v1`);
  console.log("Model:", MODEL);

  const messages: any[] = [
    {
      role: "user",
      content:
        "Check weather in Paris, and look up what uyx56er78ubyplo is. Use simgly and google. If one fails, retry and continue.",
    },
  ];

  let response = await client.chat.completions.create({
    model: MODEL,
    messages,
    tools,
    tool_choice: "auto",
    stream: false,
    max_tokens: 16384
  });

  console.log("response", response);

  // Step 2: Handle tool calls until there are no more to fulfill
  // Standard chat-completions path: inspect choices[0].message.tool_calls
  // (still ignore code_executor — proxy handles those internally)
  const getPendingToolCalls = (res: any) =>
    (res?.choices?.[0]?.message?.tool_calls || []).filter(
      (tc: any) => tc?.type === "function" && tc?.id && tc?.function?.name !== "code_executor",
    );

  while (getPendingToolCalls(response).length > 0) {
    const assistantMessage = response?.choices?.[0]?.message || {};
    const pendingCalls = getPendingToolCalls(response);

    messages.push({
      role: "assistant",
      content: assistantMessage.content,
      tool_calls: assistantMessage.tool_calls,
    });

    for (const toolCall of pendingCalls) {
      const name = toolCall?.function?.name;
      const rawArguments = typeof toolCall?.function?.arguments === "string"
        ? toolCall.function.arguments
        : JSON.stringify(toolCall?.function?.arguments ?? {});

      if (!name) {
        continue;
      }

      const args = JSON.parse(rawArguments || "{}");
      const result = handleToolCall(name, args);

      const isRuntimeTool = Boolean(toolCall?.caller);
      const label = isRuntimeTool ? "Runtime tool" : "Normal tool";

      console.log(`${label}: ${name}(${rawArguments})`);
      console.log(`Result: ${JSON.stringify(result)}\n`);

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }

    console.log("input", messages);

    response = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: "auto",
      stream: false,
      max_tokens: 16384
    });

    console.log("response", response);

  }

  console.log("=== Final Response ===");
  console.log("Full response object:", response);
  console.log(response.choices[0]?.message?.content || "[no assistant content]");
}

main().catch((error) => {
  console.error("Example failed:", error);
  Deno.exit(1);
});
