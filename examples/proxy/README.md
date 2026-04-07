# Open-PTC Proxy Client Guide

This guide is for application developers integrating with Open-PTC over HTTP.

If you already use OpenAI-style Responses API payloads, Open-PTC lets you keep that client pattern while adding programmatic tool execution through a sandbox.

## What You Do as the Client

Your app owns the runtime tool implementations.

At a high level:

1. Send a normal `POST /v1/responses` request with your `model`, `input`, and `tools`.
2. Mark tools that you intend to execute as functions in the sandbox with `"open-ptc-runtime-function": true`.
3. Respond to tool calls as you would normally, except for calls of the `code_executor` tool, which you can ignore since it's fulfilled internally by Open-PTC and relayed to the client just to show what the sandbox is trying to execute.
4. Repeat until no pending runtime tool calls remain.

## Endpoint You Call

Primary endpoint:

- `POST /v1/responses`

Also available as passthrough to downstream LiteLLM:

- `POST /v1/chat/completions`
- `POST /v1/completions`

For runtime-tool orchestration, use `/v1/responses`.

## Request Contract

Send `model`, `input`, and `tools` as you normally would.

Mark any tool that should run in the sandbox with `"open-ptc-runtime-function": true`.
And optionally include an `output_schema` for better generated signatures in the tool description.
Keep normal tool calls the same as you usually would.

Example tool definition:

```json
{
  "type": "function",
  "name": "query_db",
  "description": "Query the database",
  "parameters": {
    "type": "object",
    "properties": {
      "sql": { "type": "string" }
    },
    "required": ["sql"]
  },
  "output_schema": {
    "type": "array",
    "items": { "type": "object" }
  },
  "open-ptc-runtime-function": true
}
```


## How to Detect Pending Runtime Calls

Inspect `response.output` for `function_call` items where:

- `name !== "code_executor"`
- `caller` is present

These are runtime tool calls your client must fulfill.

Example runtime call item:

```json
{
  "type": "function_call",
  "call_id": "api_xyz",
  "name": "query_db",
  "arguments": "{\"sql\":\"SELECT * FROM users\"}",
  "caller": { "call_id": "call_123" }
}
```


>Important: 
`code_executor` calls are generated internally by Open-PTC to run the sandbox code and can be ignored by your client.  
All other tool calls (runtime ones included) that come through are for your client to execute and return results for.

## Continuation Contract

For each runtime call you handled, append this to your next request input:

```json
{
  "type": "function_call_output",
  "call_id": "api_xyz",
  "output": "[{\"id\":1,\"name\":\"Ada\"}]"
}
```

Important:

- Keep passing the same `tools` array on continuation requests.
- Preserve prior response items you need as conversation state (the example clients append all output items back into `input`).

## Minimal Client Loop (fetch)

```typescript
const tools = [
  {
    type: "function",
    name: "get_weather",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
    "open-ptc-runtime-function": true,
  },
];

function pendingRuntimeCalls(response: any): any[] {
  return (response.output ?? []).filter(
    (item: any) => item.type === "function_call" && item.name !== "code_executor"
  );
}

async function postResponses(payload: Record<string, unknown>) {
  const res = await fetch("http://localhost:9734/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await res.json();
}

const input: any[] = [
  { type: "message", role: "user", content: "Weather in Paris?" },
];

let response = await postResponses({ model: "gpt-5.2-chat", input, tools });

while (pendingRuntimeCalls(response).length > 0) {
  for (const item of response.output ?? []) {
    input.push(item);
  }

  for (const call of pendingRuntimeCalls(response)) {
    const args = JSON.parse(call.arguments);
    const result = await handleToolCall(call.name, args); // your implementation

    input.push({
      type: "function_call_output",
      call_id: call.call_id,
      output: JSON.stringify(result),
    });
  }

  response = await postResponses({ model: "gpt-5.2-chat", input, tools });
}

console.log(response.output);
```

## Using OpenAI SDK Instead of fetch

OpenAI SDK works if you point `baseURL` to Open-PTC:

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:9734/v1",
  apiKey: "dummy",
});

const response = await client.responses.create({ model, input, tools });
```

See full working examples:

- `examples/proxy/proxy-client.ts`
- `examples/proxy/proxy-sdk-client.ts`

## Quick Start (Run the Example)

### Terminal 1: Start the Open-PTC proxy server & LiteLLM 
```bash
docker compose up -d
```
or
```bash
deno run --allow-all src/server.ts --proxy
```
(with LiteLLM running separately if not using Docker)

### Terminal 2: Run a client example
```bash
deno run --allow-all examples/proxy/proxy-client.ts
```


## Client-Facing Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_URL` | `http://localhost:9734` | Open-PTC proxy base URL |
| `MODEL` | `gpt-5.2-chat` | Model name sent in client requests (configurable in litellm_config.yaml) |


## Implementation Notes

Internally, Open-PTC injects a synthetic `code_executor` tool, runs sandboxed TypeScript, and pauses execution when sandbox code calls your runtime tools. Your `function_call_output` unblocks execution and continues the orchestration chain.
