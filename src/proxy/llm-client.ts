/**
 * LlmClient — Typed wrapper around LiteLLM calls.
 *
 * Supports two downstream modes:
 * - responses:          /v1/responses
 * - chat_completions:   /v1/chat/completions (normalized to internal output shape)
 */

import { log } from "./proxy-logger.ts";

export interface LlmChatRequest {
    input: unknown[];
    tools: unknown[];
    model?: string;
    extraParams?: Record<string, unknown>;
}

export interface LlmChatResponse {
    output: any[];
    status?: string;
    model?: string;
    [key: string]: unknown;
}

export type LlmBackendMode = "responses" | "chat_completions";

export class LlmClient {
    constructor(private baseUrl: string) { }

    /** The base URL of the LLM backend (e.g. LiteLLM). */
    get url(): string {
        return this.baseUrl;
    }

    /**
     * Send a chat request to the LLM and return the parsed response in internal format.
     */
    async chat(
        request: LlmChatRequest,
        headers: Headers,
        mode: LlmBackendMode = "responses",
    ): Promise<LlmChatResponse> {
        if (mode === "chat_completions") {
            return this.chatViaCompletions(request, headers);
        }

        return this.chatViaResponses(request, headers);
    }

    private async chatViaResponses(request: LlmChatRequest, headers: Headers): Promise<LlmChatResponse> {
        const body: Record<string, unknown> = {
            ...(request.extraParams ?? {}),
            input: request.input,
            tools: request.tools,
        };
        if (request.model) {
            body.model = request.model;
        }

        log.debug("LLM request — input items:", request.input.length);
        log.debug("LLM request — input types:", (request.input as any[]).map((i: any) => i.type).join(", "));
        log.trace("LLM request body:", body);

        const response = await this.post("/v1/responses", body, headers);

        const result: LlmChatResponse = await response.json();

        log.debug("LLM response status:", result.status);
        log.trace("LLM response:", result);

        const msgs = result.output?.filter((o: any) => o.type === "message") || [];
        if (msgs.length > 0) {
            log.debug("LLM message preview:", msgs[0].content?.slice?.(0, 100) || "[array]");
        }

        return result;
    }

    private async chatViaCompletions(request: LlmChatRequest, headers: Headers): Promise<LlmChatResponse> {
        const body: Record<string, unknown> = {
            ...(request.extraParams ?? {}),
            messages: this.inputToChatMessages(request.input as any[]),
            tools: this.toolsToChatTools(request.tools as any[]),
            stream: false,
        };
        if (request.model) {
            body.model = request.model;
        }

        log.debug("LLM request (chat_completions) — input items:", request.input.length);
        log.trace("LLM request (chat_completions) body:", body);

        const response = await this.post("/v1/chat/completions", body, headers);
        const chatResult = await response.json();
        const normalized = this.chatCompletionsToInternalResult(chatResult);

        log.debug("LLM response (chat_completions) normalized status:", normalized.status);
        log.trace("LLM response (chat_completions) normalized:", normalized);

        return normalized;
    }

    /**
     * Generic JSON POST helper for upstream LiteLLM routes.
     */
    async post(path: string, body: unknown, headers: Headers): Promise<Response> {
        return fetch(`${this.baseUrl}${path}`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
        });
    }

    private inputToChatMessages(input: any[]): any[] {
        if (!Array.isArray(input)) return [];

        const messages: any[] = [];

        for (const item of input) {
            if (item?.type === "message") {
                if (["system", "user", "developer", "assistant"].includes(item.role)) {
                    const message: any = {
                        role: item.role,
                        content: item.content,
                    };

                    if (item.name !== undefined) {
                        message.name = item.name;
                    }
                    if (item.audio !== undefined) {
                        message.audio = item.audio;
                    }
                    if (item.reasoning_content !== undefined) {
                        message.reasoning_content = item.reasoning_content;
                    }
                    if (item.refusal !== undefined) {
                        message.refusal = item.refusal;
                    }

                    messages.push(message);
                }
                continue;
            }

            if (item?.type === "function_call") {
                const toolCall: any = {
                    id: item.call_id,
                    type: "function",
                    function: {
                        name: item.name,
                        arguments: typeof item.arguments === "string"
                            ? item.arguments
                            : JSON.stringify(item.arguments ?? {}),
                    },
                };

                if (item.caller?.call_id) {
                    toolCall.caller = { call_id: item.caller.call_id };
                }

                messages.push({
                    role: "assistant",
                    content: null,
                    tool_calls: [toolCall],
                });
                continue;
            }

            if (item?.type === "function_call_output") {
                messages.push({
                    role: "tool",
                    tool_call_id: item.call_id,
                    content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? null),
                });
            }
        }

        return messages;
    }

    private toolsToChatTools(tools: any[]): any[] {
        if (!Array.isArray(tools)) return [];

        return tools
            .filter((tool: any) => tool?.type === "function" && typeof tool?.name === "string")
            .map((tool: any) => {
                const chatTool: any = {
                    type: "function",
                    function: {
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.parameters,
                    },
                };

                if (tool.output_schema !== undefined) {
                    chatTool.output_schema = tool.output_schema;
                }

                if (tool["open-ptc-runtime-function"] !== undefined) {
                    chatTool["open-ptc-runtime-function"] = tool["open-ptc-runtime-function"];
                }

                return chatTool;
            });
    }

    private chatCompletionsToInternalResult(chatResult: any): LlmChatResponse {
        const choice = chatResult?.choices?.[0] ?? {};
        const message = choice?.message ?? {};
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

        const output: any[] = [];

        const hasAssistantMessagePayload =
            message.content !== null && message.content !== undefined ||
            message.reasoning_content !== null && message.reasoning_content !== undefined ||
            message.refusal !== null && message.refusal !== undefined ||
            message.audio !== null && message.audio !== undefined ||
            message.name !== null && message.name !== undefined;

        if (hasAssistantMessagePayload) {
            const assistantMessage: any = {
                type: "message",
                role: "assistant",
                content: message.content ?? null,
            };

            if (message.reasoning_content !== undefined) {
                assistantMessage.reasoning_content = message.reasoning_content;
            }
            if (message.refusal !== undefined) {
                assistantMessage.refusal = message.refusal;
            }
            if (message.name !== undefined) {
                assistantMessage.name = message.name;
            }
            if (message.audio !== undefined) {
                assistantMessage.audio = message.audio;
            }

            output.push(assistantMessage);
        }

        for (const toolCall of toolCalls) {
            const normalizedToolCall: any = {
                type: "function_call",
                id: `fc_${toolCall.id}`,
                call_id: toolCall.id,
                name: toolCall?.function?.name,
                arguments: typeof toolCall?.function?.arguments === "string"
                    ? toolCall.function.arguments
                    : JSON.stringify(toolCall?.function?.arguments ?? {}),
            };

            if (toolCall?.caller?.call_id) {
                normalizedToolCall.caller = { call_id: toolCall.caller.call_id };
            }

            output.push(normalizedToolCall);
        }

        const finishReason = choice?.finish_reason;
        let status: string | undefined = "completed";
        let incompleteDetails: Record<string, unknown> | undefined;

        if (finishReason === "tool_calls") {
            status = "requires_action";
        } else if (finishReason === "length") {
            status = "incomplete";
            incompleteDetails = { reason: "max_tokens" };
        } else if (finishReason === "content_filter") {
            status = "incomplete";
            incompleteDetails = { reason: "content_filter" };
        }

        const choiceMetadata: Record<string, unknown> = {};
        if (typeof choice?.index === "number") {
            choiceMetadata.index = choice.index;
        }
        if (choice?.logprobs !== undefined) {
            choiceMetadata.logprobs = choice.logprobs;
        }
        if (choice?.content_filter_results !== undefined) {
            choiceMetadata.content_filter_results = choice.content_filter_results;
        }

        return {
            id: chatResult?.id,
            model: chatResult?.model,
            created: chatResult?.created,
            output,
            status,
            incomplete_details: incompleteDetails,
            usage: chatResult?.usage,
            choice_metadata: Object.keys(choiceMetadata).length > 0 ? choiceMetadata : undefined,
        };
    }
}

/**
 * Build a Headers object forwarding only content-type and authorization
 * from the incoming request.
 */
export function forwardHeaders(req: { header: (name: string) => string | undefined }): Headers {
    const headers = new Headers();
    headers.set("content-type", "application/json");
    const auth = req.header("authorization");
    if (auth) headers.set("authorization", auth);
    return headers;
}
