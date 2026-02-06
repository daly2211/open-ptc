// Shared Tool Types
// Common interfaces used by both MCP and WebSocket tool systems

// Base tool definition interface shared between MCP and WebSocket tools.
// Used for signature generation and common operations.
export interface BaseToolDefinition {
  referenceName: string;
  toolName: string;
  cleanToolName: string;
  description?: string;
  inputSchema: object;
  outputSchema?: object | null;
  guardFunction: (value: unknown) => boolean;
}

// Cleans up a string to be a valid TypeScript/JavaScript variable name.
// Replaces invalid characters with underscores and removes leading/trailing underscores.
export function cleanupVariableName(name: string): string {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}
