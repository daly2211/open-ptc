/**
 * Pure utility functions for PTC-Proxy request/response transformation.
 */

import { callToSession } from "./session-store.ts";
import { log } from "./proxy-logger.ts";

// ─── Input helpers ───────────────────────────────────────────────────────────

/**
 * Find a pending runtime tool result in the input.
 * Only matches function_call_output items whose call_id is tracked in callToSession.
 */
export function findToolResult(input: any[]): any | null {
    return input?.find(
        (item: any) => item.type === "function_call_output" && callToSession.has(item.call_id)
    ) || null;
}

/**
 * Strip internal runtime tool traces from input before forwarding to the LLM.
 *
 * Removes:
 * - Internal runtime tool calls (calls made by code_executor sandbox)
 * - Internal runtime tool outputs
 *
 * Keeps:
 * - code_executor calls and outputs
 * - reasoning, messages, etc.
 */
export function stripInternalFields(input: any[]): any[] {
    if (!Array.isArray(input)) return input;

    log.debug("stripInternalFields: input items:", input.length);
    log.trace("stripInternalFields: input types:", input.map(summarizeItem).join(", "));

    // First pass: collect code_executor call_ids and internal runtime call ids
    const codeExecutorCallIds = new Set<string>();
    const internalRuntimeCallIds = new Set<string>();

    for (const item of input) {
        if (item.type === "function_call" && item.name === "code_executor") {
            codeExecutorCallIds.add(item.call_id);
        }
        if (item.type === "function_call" && item.caller?.call_id) {
            if (codeExecutorCallIds.has(item.caller.call_id)) {
                internalRuntimeCallIds.add(item.call_id);
            }
        }
    }

    // Second pass: remove internal runtime tool traces only
    const filtered = input.filter((item) => {
        if (item.type === "function_call" && internalRuntimeCallIds.has(item.call_id)) return false;
        if (item.type === "function_call_output" && internalRuntimeCallIds.has(item.call_id)) return false;
        return true;
    });

    log.debug("stripInternalFields: output items:", filtered.length);
    log.trace("stripInternalFields: output types:", filtered.map(summarizeItem).join(", "));

    return filtered;
}

/**
 * Filter internal runtime calls and their outputs from an output array.
 */
export function filterInternalRuntimeCalls(output: any[], sessionId: string): any[] {
    log.debug("filterInternalRuntimeCalls: sessionId:", sessionId?.slice(0, 8));
    log.trace("filterInternalRuntimeCalls: input:", output.map(summarizeItem).join(", "));

    const internalCallIds = new Set<string>();

    for (const item of output) {
        if (item.type === "function_call" && item.caller?.call_id === sessionId) {
            log.debug("filterInternalRuntimeCalls: found internal call:", item.name, item.call_id?.slice(0, 8));
            internalCallIds.add(item.call_id);
        }
    }

    const filtered = output.filter((item) => {
        if (item.type === "function_call" && item.name === "code_executor") return false;
        if (item.type === "function_call" && item.caller?.call_id === sessionId) return false;
        if (item.type === "function_call_output" && internalCallIds.has(item.call_id)) return false;
        return true;
    });

    log.trace("filterInternalRuntimeCalls: output:", filtered.map(summarizeItem).join(", "));
    return filtered;
}

// ─── Tool categorization ─────────────────────────────────────────────────────

import type { PtcTool } from "./types.ts";
import { buildReplTool, stripPtcFields } from "./repl-tool-builder.ts";
import type { McpToolDefinition } from "@/mcp/mcp-registry.ts";

export interface CategorizedTools {
    runtimeTools: PtcTool[];
    normalTools: PtcTool[];
}

/**
 * Split raw PTC tools into runtime tools (sandbox-only) and normal tools (forwarded to LLM).
 */
export function categorizeTools(tools: PtcTool[]): CategorizedTools {
    return {
        runtimeTools: tools.filter(t => t["open-ptc-runtime-function"]),
        normalTools: tools.filter(t => !t["open-ptc-runtime-function"]),
    };
}

/**
 * Build the final tools array to send to the LLM.
 * If there are runtime tools, merges a synthetic `code_executor` tool.
 */
export async function buildLlmTools(
    categorized: CategorizedTools,
    mcpTools: McpToolDefinition[]
): Promise<any[]> {
    const { runtimeTools, normalTools } = categorized;

    if (runtimeTools.length > 0) {
        const replTool = await buildReplTool(runtimeTools, mcpTools);
        return [...normalTools.map(stripPtcFields), replTool];
    }

    return normalTools.map(stripPtcFields);
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/** Compact one-line summary of an output/input item for logs. */
export function summarizeItem(o: any): string {
    return `${o.type}${o.name ? "(" + o.name + ")" : ""}${o.call_id ? ":" + o.call_id?.slice(0, 8) : ""}`;
}
