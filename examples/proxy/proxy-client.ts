/**
 * Open-PTC Proxy Client Example — Simple HTTP client using fetch
 *
 * Simplified example with three runtime tools:
 *   - get_temperature
 *   - convert_temp
 *   - calculate
 *
 * Prerequisites:
 *   - Open-PTC Proxy running on http://localhost:9734
 *   - LiteLLM running
 *
 * Run: deno run --allow-net --allow-env examples/proxy/proxy-client.ts
 */

import "@std/dotenv/load";

const PROXY_URL = Deno.env.get("PROXY_URL") || "http://localhost:9734";
const MODEL = Deno.env.get("MODEL") || "gpt-5.2-chat";

const tools: any[] = [
  {
    type: "function",
    name: "get_temperature",
    description: "Get the current temperature for a city in Fahrenheit.",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name to look up" },
      },
      required: ["city"],
    },
    output_schema: { // output_schema is optional but allows the open-ptc proxy to create a better function signature for the sandbox tool
      type: "number",
    },
    "open-ptc-runtime-function": true, // Marks this as a runtime tool to be called via the sandbox
  },
  {
    type: "function",
    name: "convert_temp",
    description: "Convert temperature from Fahrenheit to another unit.",
    parameters: {
      type: "object",
      properties: {
        fahrenheit: { type: "number", description: "Temperature in Fahrenheit" },
        to_unit: {
          type: "string",
          description: "Target unit",
          enum: ["celsius", "kelvin"],
        },
      },
      required: ["fahrenheit", "to_unit"],
    },
    output_schema: { // output_schema is optional but allows the open-ptc proxy to create a better function signature for the sandbox tool
      type: "number",
    },
    "open-ptc-runtime-function": true, // Marks this as a runtime tool to be called via the sandbox
  },
  {
    type: "function",
    name: "calculate",
    description: "Perform a mathematical operation on two numbers.",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
        operation: {
          type: "string",
          description: "One of add, subtract, multiply, divide",
          enum: ["add", "subtract", "multiply", "divide"],
        },
      },
      required: ["a", "b", "operation"],
    },
  },
];

function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    return JSON.parse(raw) as Record<string, unknown>;
  }
  if (raw && typeof raw === "object") {
    return raw as Record<string, unknown>;
  }
  return {};
}

function handleToolCall(name: string, args: Record<string, unknown>) {
  const temps: Record<string, number> = {
    NYC: 72.0,
    LA: 85.0,
    Chicago: 65.0,
  };

  const asNumber = (value: unknown): number =>
    typeof value === "number" ? value : Number(value);

  switch (name) {
    case "get_temperature": {
      const city = String(args.city ?? "");
      return temps[city] ?? 70.0;
    }
    case "convert_temp": {
      const fahrenheit = asNumber(args.fahrenheit);
      const toUnit = String(args.to_unit ?? "");
      if (toUnit === "celsius") {
        return Math.round(((fahrenheit - 32) * 5 / 9) * 10) / 10;
      }
      if (toUnit === "kelvin") {
        return Math.round((((fahrenheit - 32) * 5 / 9 + 273.15) * 10)) / 10;
      }
      return fahrenheit;
    }
    case "calculate": {
      const a = asNumber(args.a);
      const b = asNumber(args.b);
      const operation = String(args.operation ?? "");
      const ops: Record<string, (x: number, y: number) => number> = {
        add: (x, y) => x + y,
        subtract: (x, y) => x - y,
        multiply: (x, y) => x * y,
        divide: (x, y) => (y !== 0 ? x / y : Infinity),
      };
      return (ops[operation] ?? (() => 0))(a, b);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function getPendingToolCalls(response: any): any[] {
  return (response.output ?? []).filter(
    (item: any) => item.type === "function_call" && item.name !== "code_executor"
  );
}

async function postResponses(payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${PROXY_URL}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Proxy request failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function main() {
  console.log("=== Proxy + Fetch Example ===\n");
  console.log("Proxy URL:", PROXY_URL + "/v1");
  console.log("Model:", MODEL, "\n");

  const input: any[] = [
    {
      type: "message",
      role: "user",
      content:
        "What's the temperature in NYC in Celsius? " +
        "Then multiply 12 by 3, and finally divide that result by 2. " +
        "Use the available tools.",
    },
  ];

  let response = await postResponses({ model: MODEL, input, tools });

  while (getPendingToolCalls(response).length > 0) {
    for (const item of response.output) {
      input.push(item);
    }

    for (const item of getPendingToolCalls(response)) {
      const label = item.caller ? "Runtime tool" : "Normal tool";
      console.log(`${label}: ${item.name}(${item.arguments})`);

      const args = parseArguments(item.arguments);
      const result = handleToolCall(item.name, args);
      console.log("Result:", JSON.stringify(result), "\n");

      input.push({
        type: "function_call_output",
        call_id: item.call_id,
        output: JSON.stringify(result),
      });
    }

    response = await postResponses({ model: MODEL, input, tools });
  }

  if (response.status === "failed") {
    console.error("Error from LLM:", response.error);
    return;
  }

  console.log("=== Final Response ===");
  console.log(JSON.stringify(response.output, null, 2));
}

main().catch(console.error);
