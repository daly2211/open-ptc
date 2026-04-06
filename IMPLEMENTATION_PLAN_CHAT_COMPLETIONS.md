# Open-PTC Proxy Implementation Plan
## Add `/v1/chat/completions` Alongside Existing `/v1/responses`

Date: 2026-04-01
Audience: Junior Developer
Status: Design and implementation guide (non-streaming only)

## 1. Goals

1. Add first-class support for OpenAI-style `POST /v1/chat/completions` in the proxy.
2. Reuse the existing runtime tool orchestration path already implemented for `POST /v1/responses`.
3. Keep behavior consistent and avoid duplicated orchestration logic.
4. Keep `POST /v1/completions` available as a direct downstream passthrough endpoint.
5. Ignore streaming for now (explicitly reject `stream: true` for chat translation flow).

## 2. Non-goals (for this phase)

1. No streaming support for translated chat completions (`stream: true` is out of scope).
2. No major refactor of sandbox orchestration internals.
3. No broad redesign of the proxy architecture.

## 3. Existing Code You Must Understand

1. Routing and current responses flow:
   - `src/proxy/proxy.ts`
2. LLM upstream client:
   - `src/proxy/llm-client.ts`
3. Runtime orchestration/session lifecycle:
   - `src/proxy/sandbox-orchestrator.ts`
   - `src/proxy/session-store.ts`
4. Tool categorization and transformation:
   - `src/proxy/proxy-utils.ts`
5. Proxy tool types:
   - `src/proxy/types.ts`

## 4. Target Architecture (Single Path for Chat)

### 4.1 Request handling strategy

- `/v1/responses`: keep current behavior unchanged.
- `/v1/chat/completions`: always use translation pipeline.
  1. Convert chat request shape -> internal responses-style request shape.
  2. Run through existing responses orchestration path (including runtime tools/sandbox).
  3. Convert internal responses-style result -> chat completion result shape.
- `/v1/completions`: direct passthrough to downstream LiteLLM `/v1/completions`.

### 4.2 Why this is clean

1. One orchestration engine (already proven).
2. One translation layer for chat compatibility.
3. Minimal new moving pieces.

## 5. API Contracts You Must Implement

## 5.1 Incoming Chat Completions request (proxy input)

Typical fields you must handle:

```json
{
  "model": "gpt-5.4",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Get weather in Paris and summarize." }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get weather for a city",
        "parameters": {
          "type": "object",
          "properties": { "city": { "type": "string" } },
          "required": ["city"]
        }
      },
      "open-ptc-runtime-function": true
    }
  ],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "reasoning_effort": "medium",
  "temperature": 0.3,
  "stream": false
}
```

Notes:
1. `stream: true` should return `400` for now in this translated chat path.
2. Preserve optional generation params as pass-through metadata for downstream calls.

## 5.2 Internal request shape used by current orchestration

Internal target shape (what existing responses path expects):

```json
{
  "model": "gpt-5.4",
  "input": [
    { "type": "message", "role": "system", "content": "You are a helpful assistant." },
    { "type": "message", "role": "user", "content": "Get weather in Paris and summarize." }
  ],
  "tools": [
    {
      "type": "function",
      "name": "get_weather",
      "description": "Get weather for a city",
      "parameters": {
        "type": "object",
        "properties": { "city": { "type": "string" } },
        "required": ["city"]
      },
      "open-ptc-runtime-function": true
    }
  ],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "reasoning_effort": "medium",
  "temperature": 0.3
}
```

## 5.3 Tool continuation shape in chat

When client sends tool output in chat protocol:

```json
{
  "model": "gpt-5.4",
  "messages": [
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_abc123",
          "type": "function",
          "function": {
            "name": "get_weather",
            "arguments": "{\"city\":\"Paris\"}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_abc123",
      "content": "{\"city\":\"Paris\",\"temp\":72,\"condition\":\"sunny\"}"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "parameters": { "type": "object" }
      },
      "open-ptc-runtime-function": true
    }
  ],
  "stream": false
}
```

This must translate to internal `function_call` and `function_call_output` items so the current session resume path works.

Parallel continuation is also supported in a single request. If multiple tool calls were returned in one assistant turn, the client can submit multiple `role=tool` messages in one follow-up call:

```json
{
  "model": "gpt-5.4",
  "messages": [
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_weather",
          "type": "function",
          "function": {
            "name": "get_weather",
            "arguments": "{\"city\":\"Paris\"}"
          }
        },
        {
          "id": "call_time",
          "type": "function",
          "function": {
            "name": "get_current_time",
            "arguments": "{}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_weather",
      "content": "{\"city\":\"Paris\",\"temp\":72}"
    },
    {
      "role": "tool",
      "tool_call_id": "call_time",
      "content": "{\"time\":\"2026-04-01T12:00:00Z\"}"
    }
  ]
}
```

Translation rule for this case: each `role=tool` message maps to one `function_call_output` item in the same internal request, keyed by its own `call_id`.

## 5.4 Outgoing Chat Completions response (proxy output)

When model wants tools:

```json
{
  "id": "chatcmpl_proxy_001",
  "object": "chat.completion",
  "created": 1743489600,
  "model": "gpt-5.4",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_abc123",
            "type": "function",
            "function": {
              "name": "get_weather",
              "arguments": "{\"city\":\"Paris\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls",
      "logprobs": null
    }
  ],
  "usage": {
    "prompt_tokens": 100,
    "completion_tokens": 22,
    "total_tokens": 122,
    "completion_tokens_details": {
      "reasoning_tokens": 12,
      "audio_tokens": 0,
      "accepted_prediction_tokens": 0,
      "rejected_prediction_tokens": 0
    },
    "prompt_tokens_details": {
      "audio_tokens": 0,
      "cached_tokens": 0
    }
  }
}
```

When model is done:

```json
{
  "id": "chatcmpl_proxy_002",
  "object": "chat.completion",
  "created": 1743489620,
  "model": "gpt-5.4",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The weather in Paris is sunny and 72F.",
        "tool_calls": null
      },
      "finish_reason": "stop",
      "logprobs": null
    }
  ],
  "usage": {
    "prompt_tokens": 120,
    "completion_tokens": 18,
    "total_tokens": 138,
    "completion_tokens_details": {
      "reasoning_tokens": 0,
      "audio_tokens": 0,
      "accepted_prediction_tokens": 0,
      "rejected_prediction_tokens": 0
    },
    "prompt_tokens_details": {
      "audio_tokens": 0,
      "cached_tokens": 0
    }
  }
}
```

## 6. Translation Spec (Exact Mapping)

## 6.1 Chat request -> internal responses request

| Chat field | Internal field | Notes |
|---|---|---|
| `model` | `model` | direct |
| `messages[*]` | `input[*]` | convert by role/type rules below |
| `tools` | `tools` | convert function object shape to proxy tool shape |
| `tool_choice` | `tool_choice` | direct if present |
| `parallel_tool_calls` | `parallel_tool_calls` | direct if present |
| `reasoning_effort` | `reasoning_effort` | direct if present |
| `temperature`/`top_p`/... | `requestParams` | forwarded passthrough |
| `stream` | reject if true | `400` in this phase |
| `messages[*].content` | `input[*].content` | preserve strings and typed content arrays as-is |

Message conversion rules:

1. `role=user|system|developer` message ->
```json
{ "type": "message", "role": "<same>", "content": "... or [typed parts]" }
```

Content handling decision (explicit):
1. If `content` is a string, pass through unchanged.
2. If `content` is an array of typed content parts, pass through unchanged.
3. Do not concatenate or normalize arrays to plain strings in this phase.

2. `role=assistant` with `tool_calls` ->
  1. If assistant `content` is non-null (string or array), first emit one internal assistant `message` item preserving that content.
  2. Then emit one internal `function_call` item per tool call:
```json
{ "type": "function_call", "call_id": "<tool_call.id>", "name": "<function.name>", "arguments": "<function.arguments>" }
```

3. `role=tool` with `tool_call_id` -> internal function call output:
```json
{ "type": "function_call_output", "call_id": "<tool_call_id>", "output": "<content>" }
```

4. `role=assistant` with plain content and no `tool_calls` -> internal assistant message item.

5. ID correlation rule (critical):
  1. Chat `tool_calls[].id` maps to internal `function_call.call_id`.
  2. Chat `role=tool.tool_call_id` maps to internal `function_call_output.call_id`.
  3. If an internal function call item contains both `id` and `call_id`, always use `call_id` for correlation. Never use `id` for tool output matching.

Tool conversion rule:

Chat tools are `{"type":"function","function":{...}}`, while internal proxy tools are flat:

```json
{
  "type": "function",
  "name": "<function.name>",
  "description": "<function.description>",
  "parameters": { ... },
  "output_schema": { ... optional ... },
  "open-ptc-runtime-function": true|false
}
```

## 6.2 Internal responses result -> chat response

Map internal output items into one chat choice:

1. If output has function calls pending (excluding internal-only code executor artifacts):
   - `choices[0].message.tool_calls = [...]`
  - `choices[0].message.content` should be populated from assistant message content items if present in the same turn; otherwise set to `null`
   - `finish_reason = "tool_calls"`

2. Else collect final assistant textual message content:
   - `choices[0].message.content = "..."`
   - `choices[0].message.tool_calls = null`
  - `finish_reason` is derived from explicit mapping rules below

3. Usage mapping:
   - map prompt/completion/total tokens
   - preserve reasoning token details if present

4. Always set:
   - `object = "chat.completion"`
   - `choices[0].logprobs = null` unless implemented later

Finish reason mapping (required, do not guess):

1. If there are pending non-internal function calls in output -> `finish_reason = "tool_calls"`.
2. Else if top-level status is `completed` -> `finish_reason = "stop"`.
3. Else if top-level status is `incomplete` and `incomplete_details.reason` is `max_tokens` -> `finish_reason = "length"`.
4. Else if top-level status is `incomplete` and `incomplete_details.reason` is `content_filter` -> `finish_reason = "content_filter"`.
5. Else default to `finish_reason = "stop"` and log a warning with the unmatched status/reason.

ID mapping on response conversion:

1. Internal `function_call.call_id` maps to chat `choices[0].message.tool_calls[*].id`.
2. Never map internal `function_call.id` to chat tool call IDs.

## 7. Files to Create/Modify

## 7.1 New file

1. `src/proxy/chat-completions-adapter.ts`

Suggested exported functions:

```ts
export interface ChatToResponsesResult {
  body: {
    model?: string;
    input: any[];
    tools: any[];
    requestParams: Record<string, unknown>;
  };
}

export function chatRequestToResponsesBody(chatBody: any): ChatToResponsesResult;

export function responsesResultToChatCompletion(result: any, requestedModel?: string): any;
```

## 7.2 Update existing files

1. `src/proxy/proxy.ts`
   - Add route: `POST /v1/chat/completions`
   - Convert request using adapter
   - Reuse existing responses orchestration path
   - Convert final output back to chat completion shape
   - Add clear 400 for `stream: true`
   - Add explicit route: `POST /v1/completions` passthrough

2. `src/proxy/llm-client.ts`
   - Keep existing responses call
   - Add tiny generic upstream post helper (optional but recommended)

3. `src/server.ts`
   - Update startup logs to advertise chat/completions and completions endpoints

4. `examples/proxy/README.md` and root `README.md`
   - Document endpoint behavior and non-streaming limitation

## 8. Step-by-step Implementation Tasks

1. Create adapter with pure conversion functions and unit-testable logic.
2. Integrate adapter into new `/v1/chat/completions` route.
3. Reuse existing request lifecycle:
   - tool result detection
   - resume path
   - fresh call path
   - sandbox chaining
4. Convert route output to chat shape before returning JSON.
5. Add `/v1/completions` direct passthrough route.
6. Update logs/docs/examples.
7. Run lint/type checks.
8. Run manual scenario tests.

## 9. Pseudocode for `/v1/chat/completions`

```ts
app.post("/v1/chat/completions", async (c) => {
  const chatBody = await c.req.json();

  if (chatBody.stream === true) {
    return c.json({ error: "stream=true not supported yet for translated chat path" }, 400);
  }

  const reqHeaders = forwardHeaders(c.req);
  const { body } = chatRequestToResponsesBody(chatBody);

  // body: { model, input, tools, requestParams }
  // then run the same orchestration flow used by /v1/responses
  const internalResult = await runResponsesFlow(body, reqHeaders);

  const chatResult = responsesResultToChatCompletion(internalResult, chatBody.model);
  return c.json(chatResult);
});
```

Note: `runResponsesFlow` can be implemented by extracting existing `/v1/responses` route logic into a shared private method to avoid duplication.

## 10. Error Handling Rules

1. `stream=true` in chat route -> `400` with actionable error message.
2. Missing `messages` or invalid shape -> `400` with validation summary.
3. Tool continuation without `tool_call_id` -> `400`.
4. Tool continuation with unknown `tool_call_id` -> keep current behavior (`400`) from orchestration.
5. If tool continuation attempts to correlate against internal `id` instead of `call_id`, reject with `400` and actionable error text.
6. Unknown/expired runtime call_id during resume -> keep current behavior (`400`) from orchestration.
7. Downstream failure -> preserve status code and error body where possible.

## 11. Manual Test Cases (Required)

1. Basic chat (no tools):
   - Input: one user message
   - Expect: one assistant choice, `finish_reason=stop`

2. Chat with non-runtime tool:
   - model requests tool call
   - client returns `role=tool` message
   - expect final assistant message

3. Chat with runtime tool (`open-ptc-runtime-function=true`):
   - expect translated tool_calls returned
   - send back tool result with `tool_call_id`
   - expect resumed completion

4. Parallel tool results in one continuation request:
  - model returns multiple tool calls in one assistant turn
  - client sends multiple `role=tool` messages (one per `tool_call_id`) in same request
  - expect all map to multiple `function_call_output` items and model continues once

5. Assistant message containing both content and `tool_calls`:
  - ensure content is preserved as a message item and tool calls are also preserved

6. Multi-step runtime chain:
   - multiple tool calls across turns
   - ensure session continuity

7. Multi-content message arrays:
  - user/system/developer/assistant content sent as typed parts array
  - ensure arrays are preserved, not flattened

8. `stream=true`:
   - expect 400 and clear message

9. `/v1/completions`:
   - verify passthrough response shape from downstream

10. Regression `/v1/responses`:
   - confirm unchanged behavior against existing example.

## 12. Suggested Task Breakdown (Junior-friendly)

1. Build adapter request conversion + tests.
2. Build adapter response conversion + tests.
3. Add chat route wired to existing orchestration.
4. Add completions passthrough route.
5. Add docs and startup logs.
6. Run manual verification checklist.

## 13. Definition of Done

1. `/v1/chat/completions` supports non-streaming requests with tool loops via translation.
2. Runtime tool calls continue/resume correctly through existing orchestrator.
3. `/v1/completions` works as downstream passthrough.
4. Existing `/v1/responses` path remains unchanged.
5. Docs clearly describe current limitations and usage.
