export interface ChatToResponsesResult {
  body: {
    model?: string;
    input: any[];
    tools: any[];
    requestParams: Record<string, unknown>;
  };
}

function assertObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
}

function normalizeToolArguments(argumentsValue: unknown): string {
  if (typeof argumentsValue === "string") {
    return argumentsValue;
  }
  if (argumentsValue === undefined) {
    return "{}";
  }
  return JSON.stringify(argumentsValue);
}

function copyDefinedFields(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  fields: string[],
): number {
  let copied = 0;
  for (const field of fields) {
    if (source[field] !== undefined) {
      target[field] = source[field];
      copied++;
    }
  }
  return copied;
}

function convertTools(chatTools: unknown): any[] {
  if (chatTools === undefined) return [];
  if (!Array.isArray(chatTools)) {
    throw new Error("Invalid chat request: tools must be an array");
  }

  return chatTools.map((tool, idx) => {
    assertObject(tool, `Invalid chat request: tools[${idx}] must be an object`);
    if (tool.type !== "function") {
      throw new Error(`Invalid chat request: tools[${idx}].type must be 'function'`);
    }

    const fn = tool.function;
    assertObject(fn, `Invalid chat request: tools[${idx}].function must be an object`);

    if (typeof fn.name !== "string" || fn.name.length === 0) {
      throw new Error(`Invalid chat request: tools[${idx}].function.name must be a non-empty string`);
    }

    return {
      type: "function",
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : undefined,
      parameters: typeof fn.parameters === "object" ? fn.parameters : undefined,
      output_schema: typeof tool.output_schema === "object" ? tool.output_schema : undefined,
      "open-ptc-runtime-function": tool["open-ptc-runtime-function"] === true,
    };
  });
}

function convertMessages(messages: unknown): any[] {
  if (!Array.isArray(messages)) {
    throw new Error("Invalid chat request: messages must be an array");
  }

  const input: any[] = [];
  const knownToolCallIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    assertObject(msg, `Invalid chat request: messages[${i}] must be an object`);

    const role = msg.role;
    if (typeof role !== "string") {
      throw new Error(`Invalid chat request: messages[${i}].role must be a string`);
    }

    if (role === "user" || role === "system" || role === "developer") {
      const convertedMessage: Record<string, unknown> = {
        type: "message",
        role,
        content: msg.content,
      };

      copyDefinedFields(msg, convertedMessage, ["name", "audio"]);
      input.push(convertedMessage);
      continue;
    }

    if (role === "assistant") {
      const toolCalls = msg.tool_calls;
      const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;

      const assistantMessage: Record<string, unknown> = {
        type: "message",
        role: "assistant",
      };
      let hasAssistantPayload = false;

      if (msg.content !== null && msg.content !== undefined) {
        assistantMessage.content = msg.content;
        hasAssistantPayload = true;
      }

      const copiedAssistantFields = copyDefinedFields(msg, assistantMessage, [
        "reasoning_content",
        "refusal",
        "name",
        "audio",
      ]);
      if (copiedAssistantFields > 0) {
        hasAssistantPayload = true;
      }

      if (hasAssistantPayload) {
        input.push(assistantMessage);
      }

      if (hasToolCalls) {
        for (let j = 0; j < toolCalls.length; j++) {
          const toolCall = toolCalls[j];
          assertObject(toolCall, `Invalid chat request: messages[${i}].tool_calls[${j}] must be an object`);

          if (toolCall.type !== "function") {
            throw new Error(`Invalid chat request: messages[${i}].tool_calls[${j}].type must be 'function'`);
          }

          if (typeof toolCall.id !== "string" || toolCall.id.length === 0) {
            throw new Error(`Invalid chat request: messages[${i}].tool_calls[${j}].id must be a non-empty string`);
          }

          const fn = toolCall.function;
          assertObject(fn, `Invalid chat request: messages[${i}].tool_calls[${j}].function must be an object`);

          if (typeof fn.name !== "string" || fn.name.length === 0) {
            throw new Error(`Invalid chat request: messages[${i}].tool_calls[${j}].function.name must be a non-empty string`);
          }

          const convertedToolCall: Record<string, unknown> = {
            type: "function_call",
            call_id: toolCall.id,
            name: fn.name,
            arguments: normalizeToolArguments(fn.arguments),
          };

          if (toolCall.caller !== undefined) {
            assertObject(
              toolCall.caller,
              `Invalid chat request: messages[${i}].tool_calls[${j}].caller must be an object`,
            );
            if (typeof toolCall.caller.call_id !== "string" || toolCall.caller.call_id.length === 0) {
              throw new Error(
                `Invalid chat request: messages[${i}].tool_calls[${j}].caller.call_id must be a non-empty string`,
              );
            }
            convertedToolCall.caller = { call_id: toolCall.caller.call_id };
          }

          knownToolCallIds.add(toolCall.id);
          input.push(convertedToolCall);
        }
      }

      continue;
    }

    if (role === "tool") {
      if (typeof msg.tool_call_id !== "string" || msg.tool_call_id.length === 0) {
        throw new Error(`Invalid chat request: messages[${i}].tool_call_id is required for role=tool`);
      }

      if (knownToolCallIds.size > 0 && !knownToolCallIds.has(msg.tool_call_id)) {
        throw new Error(
          `Invalid chat request: messages[${i}].tool_call_id '${msg.tool_call_id}' does not match any assistant tool_calls[].id in this request`,
        );
      }

      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      });
      continue;
    }

    throw new Error(`Invalid chat request: unsupported role '${role}' at messages[${i}]`);
  }

  return input;
}

interface ExtractedAssistantFields {
  content: string | any[] | null;
  reasoning_content?: string | any[] | null;
  refusal?: string | any[] | null;
  message_fields?: Record<string, unknown>;
}

function extractAssistantContent(output: any[]): ExtractedAssistantFields {
  const assistantMessages = output.filter(
    (item: any) => item.type === "message" && item.role === "assistant",
  );

  const result: ExtractedAssistantFields = { content: null };

  if (assistantMessages.length === 0) {
    return result;
  }

  const textParts: string[] = [];
  let firstStructured: any[] | null = null;
  let sawNonTextStructured = false;
  let reasoningContent: string | any[] | null = null;
  let refusalContent: string | any[] | null = null;
  const messageFields: Record<string, unknown> = {};

  const reservedFields = new Set([
    "type",
    "role",
    "content",
    "reasoning_content",
    "refusal",
  ]);

  for (const msg of assistantMessages) {
    // Backward compatibility for older marker-style encoding
    if (msg.reasoning_content === true && (msg.refusal === undefined || msg.refusal === false)) {
      reasoningContent = msg.content;
      continue;
    }
    if (msg.refusal === true && (msg.reasoning_content === undefined || msg.reasoning_content === false)) {
      refusalContent = msg.content;
      continue;
    }

    if (reasoningContent === null && msg.reasoning_content !== undefined && msg.reasoning_content !== true) {
      reasoningContent = msg.reasoning_content;
    }
    if (refusalContent === null && msg.refusal !== undefined && msg.refusal !== true) {
      refusalContent = msg.refusal;
    }

    for (const [key, value] of Object.entries(msg)) {
      if (reservedFields.has(key)) continue;
      if (messageFields[key] === undefined && value !== undefined) {
        messageFields[key] = value;
      }
    }

    const content = msg.content;

    if (typeof content === "string") {
      textParts.push(content);
      continue;
    }

    if (Array.isArray(content)) {
      const outputText = content
        .filter((part: any) => {
          const isOutputText = part?.type === "output_text" && typeof part?.text === "string";
          const isText = part?.type === "text" && typeof part?.text === "string";
          return isOutputText || isText;
        })
        .map((part: any) => part.text);

      const hasNonTextContent = content.some((part: any) => {
        const isOutputText = part?.type === "output_text" && typeof part?.text === "string";
        const isText = part?.type === "text" && typeof part?.text === "string";
        return !isOutputText && !isText;
      });

      if (hasNonTextContent) {
        sawNonTextStructured = true;
        if (!firstStructured) {
          firstStructured = content;
        }
        continue;
      }

      if (outputText.length > 0) {
        textParts.push(outputText.join(""));
      } else if (!firstStructured) {
        firstStructured = content;
      }
    }
  }

  if (sawNonTextStructured && firstStructured) {
    if (textParts.length > 0) {
      result.content = [...firstStructured, { type: "output_text", text: textParts.join("\n") }];
    } else {
      result.content = firstStructured;
    }
  } else if (textParts.length > 0) {
    result.content = textParts.join("\n");
  } else if (firstStructured) {
    result.content = firstStructured;
  }

  if (reasoningContent !== null) {
    result.reasoning_content = reasoningContent;
  }
  if (refusalContent !== null) {
    result.refusal = refusalContent;
  }

  if (Object.keys(messageFields).length > 0) {
    result.message_fields = messageFields;
  }

  return result;
}

function mapFinishReason(result: any, hasToolCalls: boolean): string {
  if (hasToolCalls) return "tool_calls";

  const status = result?.status;
  const reason = result?.incomplete_details?.reason;

  if (status === "completed") return "stop";
  if (status === "incomplete" && reason === "max_tokens") return "length";
  if (status === "incomplete" && reason === "content_filter") return "content_filter";

  console.warn("[proxy.chat-adapter] Unmapped finish reason, defaulting to stop", {
    status,
    reason,
  });
  return "stop";
}

export function chatRequestToResponsesBody(chatBody: any): ChatToResponsesResult {
  assertObject(chatBody, "Invalid chat request: body must be a JSON object");

  if (chatBody.stream === true) {
    throw new Error("stream=true not supported yet for translated chat path");
  }

  const input = convertMessages(chatBody.messages);
  const tools = convertTools(chatBody.tools);

  const {
    messages: _messages,
    tools: _tools,
    stream: _stream,
    ...requestParams
  } = chatBody;

  return {
    body: {
      model: typeof chatBody.model === "string" ? chatBody.model : undefined,
      input,
      tools,
      requestParams,
    },
  };
}

export function responsesResultToChatCompletion(result: any, requestedModel?: string): any {
  const output = Array.isArray(result?.output) ? result.output : [];
  const choiceMetadata = typeof result?.choice_metadata === "object" && result.choice_metadata !== null
    ? result.choice_metadata
    : {};

  const functionCalls = output.filter(
    (item: any) => item?.type === "function_call",
  );

  const toolCalls = functionCalls.map((fc: any) => {
    const toolCall: any = {
      id: fc.call_id,
      type: "function",
      function: {
        name: fc.name,
        arguments: typeof fc.arguments === "string" ? fc.arguments : JSON.stringify(fc.arguments ?? {}),
      },
    };

    if (fc?.caller?.call_id) {
      toolCall.caller = { call_id: fc.caller.call_id };
    }

    return toolCall;
  });

  const extracted = extractAssistantContent(output);
  const finishReason = mapFinishReason(result, toolCalls.length > 0);

  const message: any = {
    role: "assistant",
    content: extracted.content ?? null,
    tool_calls: toolCalls.length > 0 ? toolCalls : null,
  };

  // Restore reasoning_content if present
  if (extracted.reasoning_content !== undefined) {
    message.reasoning_content = extracted.reasoning_content;
  }

  // Restore refusal if present
  if (extracted.refusal !== undefined) {
    message.refusal = extracted.refusal;
  }

  if (extracted.message_fields) {
    for (const [key, value] of Object.entries(extracted.message_fields)) {
      if (message[key] === undefined) {
        message[key] = value;
      }
    }
  }

  const choice: any = {
    index: typeof choiceMetadata.index === "number" ? choiceMetadata.index : 0,
    message,
    finish_reason: finishReason,
    logprobs: choiceMetadata.logprobs ?? null,
  };

  if (choiceMetadata.content_filter_results !== undefined) {
    choice.content_filter_results = choiceMetadata.content_filter_results;
  }

  return {
    id: result?.id ?? `chatcmpl_proxy_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
    object: "chat.completion",
    created: typeof result?.created === "number" ? result.created : Math.floor(Date.now() / 1000),
    model: result?.model ?? requestedModel,
    choices: [choice],
    usage: result?.usage,
  };
}
