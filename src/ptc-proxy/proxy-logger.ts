/**
 * Structured logger for PTC-Proxy with level-based filtering.
 *
 * Levels (from most to least verbose):
 *   trace  – Full JSON.stringify dumps of requests/responses
 *   debug  – Detailed flow information (call IDs, item counts, types)
 *   info   – High-level lifecycle events (request received, sandbox started, etc.)
 *   warn   – Warnings
 *   error  – Errors
 *
 * Set via PTC_PROXY_LOG_LEVEL env var (default: "info").
 */

declare const Deno: { env: { get(key: string): string | undefined } } | undefined;

const LEVELS = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 } as const;
type LogLevel = keyof typeof LEVELS;

function getLevel(): LogLevel {
    const env = (typeof Deno !== "undefined" ? Deno.env.get("PTC_PROXY_LOG_LEVEL") : undefined) ?? "info";
    return (env.toLowerCase() as LogLevel) in LEVELS ? (env.toLowerCase() as LogLevel) : "info";
}

const currentLevel = getLevel();

function shouldLog(level: LogLevel): boolean {
    return LEVELS[level] >= LEVELS[currentLevel];
}

function fmt(level: string, ...args: unknown[]): string {
    return `[PROXY][${level.toUpperCase()}] ${args.map(a => typeof a === "string" ? a : JSON.stringify(a, null, 2)).join(" ")}`;
}

export const log = {
    /** Full payload dumps — only enabled at trace level */
    trace: (...args: unknown[]) => { if (shouldLog("trace")) console.log(fmt("trace", ...args)); },

    /** Detailed flow info (call IDs, item counts, types) */
    debug: (...args: unknown[]) => { if (shouldLog("debug")) console.log(fmt("debug", ...args)); },

    /** High-level lifecycle events */
    info: (...args: unknown[]) => { if (shouldLog("info")) console.log(fmt("info", ...args)); },

    warn: (...args: unknown[]) => { if (shouldLog("warn")) console.warn(fmt("warn", ...args)); },

    error: (...args: unknown[]) => { if (shouldLog("error")) console.error(fmt("error", ...args)); },
};
