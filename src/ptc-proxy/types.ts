export interface PtcTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  "open-ptc-runtime-function"?: boolean;
}

export interface FunctionCall {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  caller?: { call_id: string };
}

export interface FunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export interface PtcSession {
  id: string;
  runtimeTools: PtcTool[];
  createdAt: number;
  pendingExecutors?: any[];
  executorOutputs?: any[];
  chainOutputs?: any[];
}

export interface ToolCallEvent {
  callId: string;
  toolName: string;
  args: unknown;
}
