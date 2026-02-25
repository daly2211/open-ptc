/**
 * PTC-Proxy Client Example — Using OpenAI SDK
 *
 * Same as ptc-proxy-client.ts but uses the official OpenAI SDK.
 * Just set baseURL to the PTC proxy - no patches needed!
 *
 * Prerequisites:
 *   - PTC-Proxy running on http://localhost:9734
 *   - LiteLLM running (or LITELLM_URL env set)
 *
 * Run:  deno run --allow-net --allow-env examples/ptc-proxy-sdk-client.ts
 */

import "@std/dotenv/load";
import { queryObjects } from "node:v8";
import OpenAI from "openai";

const PTC_PROXY_URL = Deno.env.get("PTC_PROXY_URL") || "http://localhost:9734";
const MODEL = Deno.env.get("MODEL") || "gpt-5.2-chat";

// Create OpenAI client pointing to PTC proxy
const client = new OpenAI({
  baseURL: PTC_PROXY_URL + "/v1",  // <-- Just change baseURL!
  apiKey: "dummy", // Required by SDK but proxy handles actual auth
});

// Define tools (using any for custom PTC fields)
const tools: any[] = [
  // RUNTIME TOOL - LLM writes code that calls this
  {
    type: "function",
    name: "get_weather",
    description: "Get weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
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
    name: "tavily_lookup",
    description: "Lookup information using Tavily",
    parameters: {
      type: "object", properties: {
        query: { type: "string" }
      }, required: ["query"]
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
    name: "google_search",
    description: "Search Google for information",
    parameters: {
      type: "object", properties: {
        question: { type: "string" }
      }
    },
  }
];

// Handle tool calls
function handleToolCall(name: string, args: Record<string, unknown>) {
  if (name === "google_search") {
    return { response: "Google service is down for the moment. Q:" + JSON.stringify(args) };
  }
  if (name === "get_weather") {
    return { city: args.city, temp: 72, condition: "sunny" };
  }
  else if (name === "tavily_lookup") {
    return { query: args.query, answer: "uyx56er78ubyplo is the game id for Xinga 2" };
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function main() {
  console.log("=== PTC-Proxy + OpenAI SDK Example ===\n");
  console.log("Using OpenAI SDK with baseURL:", PTC_PROXY_URL + "/v1");
  console.log("Model:", MODEL);
  console.log("");

  // Build conversation input
  const input: any[] = [
    { type: "message", role: "user", content: "Check weather in Paris, and look up what uyx56er78ubyplo is? Lookup using both tavily and google. Do two code_executor calls in one output NOT back to back." }//Check weather in Paris. and look up MCP in tavily." },
  ];

  // Step 1: Send initial request using SDK
  let response = await client.responses.create({
    model: MODEL,
    input,
    tools,
  });

  // Step 2: Handle tool calls until there are no more to fulfill
  // Check if the response has any function calls we need to handle (not code_executor — proxy handles those)
  const getPendingToolCalls = (res: any) =>
    (res.output || []).filter((item: any) => item.type === "function_call" && item.name !== "code_executor");

  while (getPendingToolCalls(response).length > 0) {
    // Add ALL output items to input (including reasoning for some models)
    for (const item of (response as any).output) {
      input.push(item);
    }

    for (const item of getPendingToolCalls(response)) {
      const isRuntimeTool = Boolean(item.caller);
      const label = isRuntimeTool ? "Runtime tool" : "Normal tool";

      console.log(`${label}: ${item.name}(${item.arguments})`);

      const args = JSON.parse(item.arguments);
      const result = await handleToolCall(item.name, args);

      console.log(`Result: ${JSON.stringify(result)}\n`);

      input.push({
        type: "function_call_output",
        call_id: item.call_id,
        output: JSON.stringify(result),
      });
    }

    // Send updated request
    response = await client.responses.create({
      model: MODEL,
      input,
      tools,
    });
  }



  // // Step 3: Get final message from LLM
  // const sandboxOutput = (response as any).output?.find((o: any) => o.type === "function_call_output");
  // if (sandboxOutput) {
  //   input.push(sandboxOutput);

  //   response = await client.responses.create({
  //     model: MODEL,
  //     input,
  //     tools,
  //   });
  // }

  for (const item of (response as any).output) {
    input.push(item);
  }

  // console.log("\n=== Response: ===", JSON.stringify(response, null, 2));


  console.log("\n=== Final request to LLM: ", JSON.stringify({ input }, null, 2));

  // step 3, push all output back to input and send one final time to get the final message with tool call outputs included
  response = await client.responses.create({
    model: MODEL,
    input: [...input, { type: "message", role: "user", content: "Did you get a response from Google?" }],
    tools,
  });

  // Step 4: Print final result
  console.log("=== Final Response ===");
  console.log(JSON.stringify(response.output, null, 2));
  // const output = (response as any).output;
  // if (Array.isArray(output)) {
  //   const finalMessage = output.find((o: any) => o.type === "message");
  //   if (finalMessage) {
  //     console.log(finalMessage.content);
  //   } else {
  //     for (const item of output) {
  //       if (item.type === "function_call_output") {
  //         console.log(item.output);
  //       }
  //     }
  //   }
  // } else {
  //   console.log(JSON.stringify(response, null, 2));
  // }
}

main().catch(console.error);
