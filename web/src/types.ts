export type Risk = 'read' | 'write' | 'execute' | 'destructive';
export type Mode = 'review' | 'yolo' | 'lockdown';

export interface ToolCallView {
  name: string;
  input: Record<string, unknown>;
}

export interface ToolEntry {
  id: string;
  name: string;
  input: Record<string, unknown>;
  risk: Risk;
  status: 'running' | 'ok' | 'fail';
  durationMs?: number;
  output?: string;
  error?: string;
  expanded?: boolean;
}

export interface ApprovalRequest {
  requestId: string;
  call: ToolCallView;
  risk: Risk;
}

export interface AskRequest {
  requestId: string;
  question: string;
}

export interface TaskResultView {
  success: boolean;
  summary: string;
  turns: number;
  totalCost: number;
  totalTokens: { input: number; output: number };
}

export interface Message {
  id: string;
  role: 'user' | 'agent';
  text: string;
  tools: ToolEntry[];
  streaming?: boolean;
  result?: TaskResultView;
  error?: string;
}

export interface McpServerStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

export interface ServerStatus {
  project: string;
  provider: string;
  model: string;
  mode: Mode;
  userName: string;
  protectedPaths: string[];
  mcpServers: McpServerStatus[];
}
