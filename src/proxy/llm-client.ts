/**
 * LlmClient — Typed wrapper around LiteLLM /v1/responses calls.
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

export class LlmClient {
    constructor(private baseUrl: string) { }

    /** The base URL of the LLM backend (e.g. LiteLLM). */
    get url(): string {
        return this.baseUrl;
    }

    /**
     * Send a chat request to the LLM and return the parsed response.
     */
    async chat(request: LlmChatRequest, headers: Headers): Promise<LlmChatResponse> {
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

        const response = await fetch(`${this.baseUrl}/v1/responses`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
        });

        const result: LlmChatResponse = await response.json();

        log.debug("LLM response status:", result.status);
        log.trace("LLM response:", result);

        const msgs = result.output?.filter((o: any) => o.type === "message") || [];
        if (msgs.length > 0) {
            log.debug("LLM message preview:", msgs[0].content?.slice?.(0, 100) || "[array]");
        }

        return result;
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
