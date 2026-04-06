import { assertEquals, assertThrows } from "jsr:@std/assert";
import {
  chatRequestToResponsesBody,
  responsesResultToChatCompletion,
} from "./chat-completions-adapter.ts";
import { stripInternalFields } from "./proxy-utils.ts";

Deno.test("chatRequestToResponsesBody converts messages and tools", () => {
  const chatBody = {
    model: "gpt-5.4",
    messages: [
      { role: "system", content: [{ type: "text", text: "You are helpful" }] },
      { role: "assistant", content: "Let me call a tool", tool_calls: [{
        id: "call_abc",
        type: "function",
        function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
      }] },
      { role: "tool", tool_call_id: "call_abc", content: { city: "Paris", temp: 72 } },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object" },
        },
        "open-ptc-runtime-function": true,
      },
    ],
    stream: false,
    temperature: 0.3,
    tool_choice: "auto",
  };

  const converted = chatRequestToResponsesBody(chatBody);

  assertEquals(converted.body.model, "gpt-5.4");
  assertEquals(converted.body.tools[0].name, "get_weather");
  assertEquals(converted.body.tools[0]["open-ptc-runtime-function"], true);
  assertEquals(converted.body.input[0], {
    type: "message",
    role: "system",
    content: [{ type: "text", text: "You are helpful" }],
  });
  assertEquals(converted.body.input[1], {
    type: "message",
    role: "assistant",
    content: "Let me call a tool",
  });
  assertEquals(converted.body.input[2], {
    type: "function_call",
    call_id: "call_abc",
    name: "get_weather",
    arguments: "{\"city\":\"Paris\"}",
  });
  assertEquals(converted.body.input[3], {
    type: "function_call_output",
    call_id: "call_abc",
    output: "{\"city\":\"Paris\",\"temp\":72}",
  });
  assertEquals(converted.body.requestParams.temperature, 0.3);
  assertEquals(converted.body.requestParams.tool_choice, "auto");
});

Deno.test("chatRequestToResponsesBody rejects stream=true", () => {
  assertThrows(
    () => chatRequestToResponsesBody({ model: "x", stream: true, messages: [] }),
    Error,
    "stream=true not supported yet for translated chat path",
  );
});

Deno.test("responsesResultToChatCompletion maps pending tool calls using call_id (including code_executor)", () => {
  const result = {
    id: "resp_1",
    model: "gpt-5.4",
    status: "requires_action",
    output: [
      {
        type: "function_call",
        id: "fc_internal",
        call_id: "call_weather",
        name: "get_weather",
        arguments: "{\"city\":\"Paris\"}",
      },
      {
        type: "function_call",
        call_id: "call_exec",
        name: "code_executor",
        arguments: "{\"code\":\"...\"}",
      },
    ],
  };

  const chat = responsesResultToChatCompletion(result, "gpt-5.4");

  assertEquals(chat.id, "resp_1");
  assertEquals(chat.choices[0].finish_reason, "tool_calls");
  assertEquals(chat.choices[0].message.tool_calls, [
    {
      id: "call_weather",
      type: "function",
      function: {
        name: "get_weather",
        arguments: "{\"city\":\"Paris\"}",
      },
    },
    {
      id: "call_exec",
      type: "function",
      function: {
        name: "code_executor",
        arguments: "{\"code\":\"...\"}",
      },
    },
  ]);
});

Deno.test("responsesResultToChatCompletion maps completed text output to stop", () => {
  const result = {
    status: "completed",
    model: "gpt-5.4",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "The weather in Paris is sunny." },
          { type: "output_text", text: " It is 72F." },
        ],
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };

  const chat = responsesResultToChatCompletion(result, "gpt-5.4");

  assertEquals(chat.choices[0].finish_reason, "stop");
  assertEquals(chat.choices[0].message.content, "The weather in Paris is sunny. It is 72F.");
  assertEquals(chat.choices[0].message.tool_calls, null);
  assertEquals(chat.usage.total_tokens, 15);
});

Deno.test("responsesResultToChatCompletion preserves caller on runtime tool calls", () => {
  const result = {
    status: "requires_action",
    output: [
      {
        type: "function_call",
        call_id: "call_runtime_1",
        name: "google_search",
        arguments: "{\"query\":\"x\"}",
        caller: { call_id: "call_executor_1" },
      },
    ],
  };

  const chat = responsesResultToChatCompletion(result, "gpt-5.4");
  assertEquals(chat.choices[0].message.tool_calls?.[0]?.caller, { call_id: "call_executor_1" });
});

Deno.test("responsesResultToChatCompletion maps choice metadata", () => {
  const result = {
    status: "completed",
    output: [{ type: "message", role: "assistant", content: "ok" }],
    choice_metadata: {
      index: 2,
      logprobs: { token_logprobs: [0.1] },
      content_filter_results: { hate: { filtered: false } },
    },
  };

  const chat = responsesResultToChatCompletion(result, "gpt-5.4");
  assertEquals(chat.choices[0].index, 2);
  assertEquals(chat.choices[0].logprobs, { token_logprobs: [0.1] });
  assertEquals(chat.choices[0].content_filter_results, { hate: { filtered: false } });
});

Deno.test("responsesResultToChatCompletion returns standard single-message choice shape", () => {
  const result = {
    status: "completed",
    output: [
      { type: "function_call", call_id: "call_exec", name: "code_executor", arguments: "{}" },
      { type: "function_call_output", call_id: "call_exec", output: "sandbox done" },
    ],
  };

  const chat = responsesResultToChatCompletion(result, "gpt-5.4");
  assertEquals(chat.output, undefined);
  assertEquals(chat.choices[0].messages, undefined);
  assertEquals(chat.choices[0].message.tool_calls, [
    {
      id: "call_exec",
      type: "function",
      function: {
        name: "code_executor",
        arguments: "{}",
      },
    },
  ]);
});

Deno.test("chatRequestToResponsesBody preserves caller metadata on assistant tool_calls", () => {
  const chatBody = {
    model: "gpt-5.4",
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "api_1",
            type: "function",
            function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
            caller: { call_id: "functions.code_executor:0" },
          },
        ],
      },
    ],
    stream: false,
  };

  const converted = chatRequestToResponsesBody(chatBody);
  assertEquals(converted.body.input[0], {
    type: "function_call",
    call_id: "api_1",
    name: "get_weather",
    arguments: "{\"city\":\"Paris\"}",
    caller: { call_id: "functions.code_executor:0" },
  });
});

Deno.test("replay path strips internal runtime traces when caller is preserved", () => {
  const chatBody = {
    model: "gpt-5.4",
    messages: [
      { role: "user", content: "Check weather in Paris" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "functions.code_executor:0",
            type: "function",
            function: { name: "code_executor", arguments: "{\"code\":\"...\"}" },
          },
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "api_1",
            type: "function",
            function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
            caller: { call_id: "functions.code_executor:0" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "api_1",
        content: "{\"city\":\"Paris\",\"temp\":72}",
      },
      {
        role: "tool",
        tool_call_id: "functions.code_executor:0",
        content: "sandbox output",
      },
    ],
    stream: false,
  };

  const converted = chatRequestToResponsesBody(chatBody);
  const stripped = stripInternalFields(converted.body.input);

  assertEquals(
    stripped.some((item: any) => item.type === "function_call" && item.call_id === "functions.code_executor:0"),
    true,
  );
  assertEquals(
    stripped.some((item: any) => item.type === "function_call_output" && item.call_id === "functions.code_executor:0"),
    true,
  );
  assertEquals(
    stripped.some((item: any) => item.type === "function_call" && item.call_id === "api_1"),
    false,
  );
  assertEquals(
    stripped.some((item: any) => item.type === "function_call_output" && item.call_id === "api_1"),
    false,
  );
});
