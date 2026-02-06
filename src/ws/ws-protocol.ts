// Client -> Server Messages

export interface ClientToolDescriptor {
  name: string;
  description?: string;
  inputSchema: object;
  outputSchema?: object;
}

export interface RegisterToolsMessage {
  type: "register_tools";
  tools: ClientToolDescriptor[];
}

export interface GetSignaturesMessage {
  type: "get_signatures";
  serverNames?: string[];
  toolNames?: string[];
}

export interface ExecuteCodeMessage {
  type: "execute_code";
  executionId: string;
  code: string;
}

export interface ToolResultMessage {
  type: "tool_result";
  callId: string;
  result?: unknown;
  error?: string;
}

export type ClientMessage =
  | RegisterToolsMessage
  | GetSignaturesMessage
  | ExecuteCodeMessage
  | ToolResultMessage;

// Server -> Client Messages

export interface SuccessMessage {
  type: "success";
  message?: string;
}

export interface SignaturesMessage {
  type: "signatures";
  content: string;
}

export interface ToolCallMessage {
  type: "tool_call";
  callId: string;
  toolName: string;
  args: unknown;
}

export interface ExecutionResultMessage {
  type: "execution_result";
  executionId: string;
  success: boolean;
  output?: string;
  error?: string;
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export type ServerMessage =
  | SuccessMessage
  | SignaturesMessage
  | ToolCallMessage
  | ExecutionResultMessage
  | ErrorMessage;

export const WS_CONFIG = {
  TOOL_CALL_TIMEOUT_MS: 60000,
};
