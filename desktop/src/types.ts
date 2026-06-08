// ─── Core Types ────────────────────────────────────────────────────────────────

export type Provider = 'anthropic' | 'openrouter' | 'vertex' | 'bedrock' | 'codex';
export type ApprovalMode = 'yolo' | 'review' | 'lockdown';
export type RiskLevel = 'read' | 'write' | 'execute' | 'destructive' | 'unknown';
export type MessageRole = 'user' | 'assistant' | 'system';
export type TaskEventType =
  | 'text'
  | 'tool_start'
  | 'tool_end'
  | 'thinking'
  | 'cost_update'
  | 'turn_start'
  | 'turn_end'
  | 'error'
  | 'done'
  | 'approval_request';

export interface TridentConfig {
  model: string;
  provider: Provider;
  mode: ApprovalMode;
  maxTurns: number;
  budgetUsd?: number | null;
  logSessions: boolean;
  onboarded: boolean;
  userName: string;
  profile?: string | null;
  systemOverride: string;
  codexModel: string;
  codexTimeoutMs: number;
  autoFormat?: boolean;
  autoTest?: boolean;
  testCommand?: string;
  thinking?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  riskLevel?: RiskLevel;
  startTime?: number;
}

export interface ToolResult {
  id: string;
  output: string;
  error?: string;
  durationMs?: number;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCall: ToolCall; result?: ToolResult; status: 'running' | 'done' | 'error' }
  | { type: 'thinking'; content: string };

export interface Message {
  id: string;
  role: MessageRole;
  content: MessageContent[];
  timestamp: number;
  streaming?: boolean;
}

export interface TaskEvent {
  type: TaskEventType;
  content?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolId?: string;
  toolOutput?: string;
  toolError?: string;
  durationMs?: number;
  riskLevel?: RiskLevel;
  cost?: number;
  tokens?: { input: number; output: number };
  turn?: number;
  maxTurns?: number;
  exitCode?: number;
  question?: string;
}

export interface Session {
  id: string;
  name: string;
  messages: Message[];
  totalCost: number;
  totalTokens: { input: number; output: number };
  turns: number;
  createdAt: number;
  cwd?: string;
  isRunning?: boolean;
}

export interface HistorySession {
  id: string;
  file?: string;
  mtime?: string;
  task?: string;
  totalCost?: number;
  turns?: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: Provider;
}

export interface PermitRule {
  id: string;
  toolPattern: string;
  pathPattern?: string;
  description?: string;
  enabled: boolean;
}

export interface FileTreeNode {
  name: string;
  type: 'file' | 'dir';
  path: string;
  children?: FileTreeNode[];
}

// Global window type augmentation
declare global {
  interface Window {
    trident: {
      runTask: (task: string, opts?: Record<string, unknown>) => Promise<{ exitCode: number }>;
      abortTask: () => void;
      onTaskEvent: (cb: (e: TaskEvent) => void) => ((_: unknown, e: TaskEvent) => void);
      offTaskEvent: (listener: ((_: unknown, e: TaskEvent) => void)) => void;
      getConfig: () => Promise<TridentConfig>;
      setConfig: (cfg: Partial<TridentConfig>) => Promise<{ ok: boolean }>;
      listSessions: () => Promise<HistorySession[]>;
      getMemory: () => Promise<string>;
      setMemory: (content: string) => Promise<{ ok: boolean }>;
      listModels: () => Promise<ModelInfo[]>;
      shellGit: (args: string[]) => Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>;
      readFile: (path: string) => Promise<{ ok: boolean; content?: string; error?: string }>;
      getProjectTree: (cwd?: string) => Promise<{ ok: boolean; tree?: FileTreeNode[]; error?: string }>;
      openExternal: (url: string) => Promise<void>;
      showNotification: (opts: { title: string; body: string }) => Promise<void>;
      getCwd: () => Promise<string>;
      minimize: () => void;
      maximize: () => void;
      close: () => void;
      platform: string;
    };
  }
}
