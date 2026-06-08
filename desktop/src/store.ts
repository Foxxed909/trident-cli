import { create } from 'zustand';
import type {
  Session,
  Message,
  MessageContent,
  TridentConfig,
  ModelInfo,
  PermitRule,
  TaskEvent,
  ToolCall,
  ToolResult,
} from './types';
import { randomId } from './ipc';

export type View = 'chat' | 'history' | 'memory' | 'settings' | 'permits' | 'analytics';

interface AppStore {
  // View / Navigation
  currentView: View;
  setView: (v: View) => void;

  // Sessions
  sessions: Session[];
  activeSessionId: string;
  activeSession: () => Session | undefined;
  newSession: () => void;
  switchSession: (id: string) => void;
  closeSession: (id: string) => void;
  renameSession: (id: string, name: string) => void;

  // Messages (within active session)
  addMessage: (msg: Message) => void;
  updateLastAssistantText: (text: string) => void;
  addToolCall: (tc: ToolCall) => void;
  updateToolCall: (id: string, result: ToolResult, status: 'done' | 'error') => void;
  addThinking: (content: string) => void;
  finalizeStreaming: () => void;

  // Task state
  isRunning: boolean;
  setRunning: (v: boolean) => void;

  // Stats (for active session)
  totalCost: number;
  totalTokens: { input: number; output: number };
  turns: number;
  contextUsed: number;
  contextLimit: number;
  updateCost: (cost: number, tokens: { input: number; output: number }) => void;
  incrementTurns: () => void;
  setContextPressure: (used: number, limit: number) => void;

  // Config
  config: TridentConfig | null;
  setConfig: (cfg: TridentConfig) => void;

  // Models
  models: ModelInfo[];
  setModels: (m: ModelInfo[]) => void;

  // Memory
  memory: string;
  setMemory: (m: string) => void;

  // Permits
  permits: PermitRule[];
  addPermit: (p: PermitRule) => void;
  togglePermit: (id: string) => void;
  removePermit: (id: string) => void;

  // UI state
  fontSize: number;
  increaseFontSize: () => void;
  decreaseFontSize: () => void;
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (v: boolean) => void;
  findOpen: boolean;
  setFindOpen: (v: boolean) => void;
  findQuery: string;
  setFindQuery: (q: string) => void;
  wordWrap: boolean;
  toggleWordWrap: () => void;

  // CWD
  cwd: string;
  setCwd: (cwd: string) => void;

  // Handle incoming task events
  handleTaskEvent: (e: TaskEvent) => void;
}

function makeSession(id: string, name = 'New Session'): Session {
  return {
    id,
    name,
    messages: [],
    totalCost: 0,
    totalTokens: { input: 0, output: 0 },
    turns: 0,
    createdAt: Date.now(),
  };
}

const INITIAL_SESSION_ID = randomId();

export const useStore = create<AppStore>((set, get) => ({
  currentView: 'chat',
  setView: (v) => set({ currentView: v }),

  sessions: [makeSession(INITIAL_SESSION_ID)],
  activeSessionId: INITIAL_SESSION_ID,

  activeSession: () => {
    const { sessions, activeSessionId } = get();
    return sessions.find(s => s.id === activeSessionId);
  },

  newSession: () => {
    const id = randomId();
    const sess = makeSession(id);
    set(s => ({
      sessions: [...s.sessions, sess],
      activeSessionId: id,
      isRunning: false,
      totalCost: 0,
      totalTokens: { input: 0, output: 0 },
      turns: 0,
      contextUsed: 0,
    }));
  },

  switchSession: (id) => {
    const sess = get().sessions.find(s => s.id === id);
    if (!sess) return;
    set({
      activeSessionId: id,
      isRunning: sess.isRunning || false,
      totalCost: sess.totalCost,
      totalTokens: sess.totalTokens,
      turns: sess.turns,
    });
  },

  closeSession: (id) => {
    const { sessions, activeSessionId } = get();
    if (sessions.length <= 1) return;
    const filtered = sessions.filter(s => s.id !== id);
    const newActive = activeSessionId === id ? filtered[filtered.length - 1].id : activeSessionId;
    set({ sessions: filtered, activeSessionId: newActive });
  },

  renameSession: (id, name) => {
    set(s => ({
      sessions: s.sessions.map(sess => sess.id === id ? { ...sess, name } : sess),
    }));
  },

  addMessage: (msg) => {
    set(s => ({
      sessions: s.sessions.map(sess =>
        sess.id === s.activeSessionId
          ? { ...sess, messages: [...sess.messages, msg] }
          : sess
      ),
    }));
  },

  updateLastAssistantText: (text: string) => {
    set(s => {
      const sessions = s.sessions.map(sess => {
        if (sess.id !== s.activeSessionId) return sess;
        const msgs = [...sess.messages];
        const lastMsg = msgs[msgs.length - 1];
        if (!lastMsg || lastMsg.role !== 'assistant') {
          // Create new assistant message
          const newMsg: Message = {
            id: randomId(),
            role: 'assistant',
            content: [{ type: 'text', text }],
            timestamp: Date.now(),
            streaming: true,
          };
          return { ...sess, messages: [...msgs, newMsg] };
        }
        // Find or create text block
        const content = [...lastMsg.content];
        const textIdx = content.findIndex(c => c.type === 'text');
        if (textIdx >= 0) {
          const existing = content[textIdx] as { type: 'text'; text?: string };
          content[textIdx] = { type: 'text', text: (existing.text ?? '') + text };
        } else {
          content.push({ type: 'text', text });
        }
        msgs[msgs.length - 1] = { ...lastMsg, content, streaming: true };
        return { ...sess, messages: msgs };
      });
      return { sessions };
    });
  },

  addToolCall: (tc: ToolCall) => {
    const toolContent: MessageContent = {
      type: 'tool_call',
      toolCall: tc,
      status: 'running',
    };
    set(s => {
      const sessions = s.sessions.map(sess => {
        if (sess.id !== s.activeSessionId) return sess;
        const msgs = [...sess.messages];
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
          const updated = { ...lastMsg, content: [...lastMsg.content, toolContent] };
          msgs[msgs.length - 1] = updated;
          return { ...sess, messages: msgs };
        }
        const newMsg: Message = {
          id: randomId(),
          role: 'assistant',
          content: [toolContent],
          timestamp: Date.now(),
        };
        return { ...sess, messages: [...msgs, newMsg] };
      });
      return { sessions };
    });
  },

  updateToolCall: (id: string, result: ToolResult, status: 'done' | 'error') => {
    set(s => {
      const sessions = s.sessions.map(sess => {
        if (sess.id !== s.activeSessionId) return sess;
        const msgs = sess.messages.map(msg => {
          const content = msg.content.map(c => {
            if (c.type === 'tool_call' && c.toolCall.id === id) {
              return { ...c, result, status };
            }
            return c;
          });
          return { ...msg, content };
        });
        return { ...sess, messages: msgs };
      });
      return { sessions };
    });
  },

  addThinking: (content: string) => {
    const thinkContent: MessageContent = { type: 'thinking', content };
    set(s => {
      const sessions = s.sessions.map(sess => {
        if (sess.id !== s.activeSessionId) return sess;
        const msgs = [...sess.messages];
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
          const updated = { ...lastMsg, content: [...lastMsg.content, thinkContent] };
          msgs[msgs.length - 1] = updated;
          return { ...sess, messages: msgs };
        }
        const newMsg: Message = {
          id: randomId(),
          role: 'assistant',
          content: [thinkContent],
          timestamp: Date.now(),
        };
        return { ...sess, messages: [...msgs, newMsg] };
      });
      return { sessions };
    });
  },

  finalizeStreaming: () => {
    set(s => {
      const sessions = s.sessions.map(sess => {
        if (sess.id !== s.activeSessionId) return sess;
        const msgs = sess.messages.map(m => ({ ...m, streaming: false }));
        return { ...sess, messages: msgs };
      });
      return { sessions };
    });
  },

  isRunning: false,
  setRunning: (v) => {
    set(s => ({
      isRunning: v,
      sessions: s.sessions.map(sess =>
        sess.id === s.activeSessionId ? { ...sess, isRunning: v } : sess
      ),
    }));
  },

  totalCost: 0,
  totalTokens: { input: 0, output: 0 },
  turns: 0,
  contextUsed: 0,
  contextLimit: 200000,

  updateCost: (cost, tokens) => {
    set(s => ({
      totalCost: cost,
      totalTokens: tokens,
      sessions: s.sessions.map(sess =>
        sess.id === s.activeSessionId
          ? { ...sess, totalCost: cost, totalTokens: tokens }
          : sess
      ),
    }));
  },

  incrementTurns: () => {
    set(s => {
      const turns = s.turns + 1;
      return {
        turns,
        sessions: s.sessions.map(sess =>
          sess.id === s.activeSessionId ? { ...sess, turns } : sess
        ),
      };
    });
  },

  setContextPressure: (used, limit) => set({ contextUsed: used, contextLimit: limit }),

  config: null,
  setConfig: (cfg) => set({ config: cfg }),

  models: [],
  setModels: (m) => set({ models: m }),

  memory: '',
  setMemory: (m) => set({ memory: m }),

  permits: [],
  addPermit: (p) => set(s => ({ permits: [...s.permits, p] })),
  togglePermit: (id) => set(s => ({
    permits: s.permits.map(p => p.id === id ? { ...p, enabled: !p.enabled } : p),
  })),
  removePermit: (id) => set(s => ({ permits: s.permits.filter(p => p.id !== id) })),

  fontSize: 14,
  increaseFontSize: () => set(s => ({ fontSize: Math.min(20, s.fontSize + 1) })),
  decreaseFontSize: () => set(s => ({ fontSize: Math.max(10, s.fontSize - 1) })),
  commandPaletteOpen: false,
  setCommandPaletteOpen: (v) => set({ commandPaletteOpen: v }),
  findOpen: false,
  setFindOpen: (v) => set({ findOpen: v }),
  findQuery: '',
  setFindQuery: (q) => set({ findQuery: q }),
  wordWrap: true,
  toggleWordWrap: () => set(s => ({ wordWrap: !s.wordWrap })),

  cwd: '.',
  setCwd: (cwd) => set({ cwd }),

  handleTaskEvent: (e: TaskEvent) => {
    const store = get();
    switch (e.type) {
      case 'text':
        if (e.content) store.updateLastAssistantText(e.content);
        break;
      case 'thinking':
        if (e.content) store.addThinking(e.content);
        break;
      case 'tool_start':
        if (e.toolId && e.toolName) {
          store.addToolCall({
            id: e.toolId,
            name: e.toolName,
            input: e.toolInput || {},
            riskLevel: e.riskLevel,
            startTime: Date.now(),
          });
        }
        break;
      case 'tool_end':
        if (e.toolId) {
          store.updateToolCall(
            e.toolId,
            {
              id: e.toolId,
              output: e.toolOutput || '',
              error: e.toolError,
              durationMs: e.durationMs,
            },
            e.toolError ? 'error' : 'done'
          );
        }
        break;
      case 'cost_update':
        if (e.cost !== undefined && e.tokens) {
          store.updateCost(e.cost, e.tokens);
        }
        break;
      case 'turn_start':
        store.incrementTurns();
        if (e.turn && e.maxTurns) {
          // context estimate: rough heuristic
          const used = (e.turn / e.maxTurns) * store.contextLimit;
          store.setContextPressure(Math.round(used), store.contextLimit);
        }
        break;
      case 'done':
        store.setRunning(false);
        store.finalizeStreaming();
        if (store.config?.logSessions) {
          window.trident?.showNotification({
            title: 'TRIDENT Task Complete',
            body: `Cost: $${store.totalCost.toFixed(4)} | Turns: ${store.turns}`,
          }).catch(() => {});
        }
        break;
      case 'error':
        store.setRunning(false);
        store.finalizeStreaming();
        break;
    }
  },
}));
