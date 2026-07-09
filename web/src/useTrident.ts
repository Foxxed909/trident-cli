import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ApprovalRequest, AskRequest, Message, Mode, Risk, ServerStatus, TaskResultView, ToolCallView,
} from './types';

type Conn = 'connecting' | 'live' | 'dead';

const RISK_FALLBACK: Risk = 'execute';

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Single-connection client for `trident serve`. Owns the message list, the live
 * approval/ask requests, and the derived connection + status state.
 */
export function useTrident() {
  const [conn, setConn] = useState<Conn>('connecting');
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [mode, setMode] = useState<Mode>('review');
  const [messages, setMessages] = useState<Message[]>([]);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [ask, setAsk] = useState<AskRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessionCost, setSessionCost] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const activeMsgId = useRef<string | null>(null);

  const patchAgent = useCallback((fn: (m: Message) => Message) => {
    setMessages((prev) => {
      const id = activeMsgId.current;
      if (!id) return prev;
      return prev.map((m) => (m.id === id ? fn(m) : m));
    });
  }, []);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const open = (): void => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => setConn('live');
      ws.onclose = () => {
        if (closed) return;
        setConn('dead');
        retry = setTimeout(open, 1500);
      };
      ws.onerror = () => ws.close();

      ws.onmessage = (ev) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(ev.data as string); } catch { return; }
        handle(msg);
      };
    };

    const handle = (msg: Record<string, unknown>): void => {
      switch (msg.type) {
        case 'hello': {
          const payload = msg.payload as ServerStatus;
          setStatus(payload);
          setMode(payload.mode);
          break;
        }
        case 'mode':
          setMode(msg.mode as Mode);
          break;
        case 'text':
          patchAgent((m) => ({ ...m, text: m.text + (msg.text as string) }));
          break;
        case 'tool_start': {
          const call = msg.call as ToolCallView;
          patchAgent((m) => ({
            ...m,
            tools: [...m.tools, {
              id: uid(),
              name: call.name,
              input: call.input,
              risk: guessRisk(call.name, call.input),
              status: 'running',
            }],
          }));
          break;
        }
        case 'tool_end': {
          patchAgent((m) => {
            const tools = [...m.tools];
            for (let i = tools.length - 1; i >= 0; i--) {
              if (tools[i].name === msg.name && tools[i].status === 'running') {
                tools[i] = {
                  ...tools[i],
                  status: (msg.success as boolean) ? 'ok' : 'fail',
                  durationMs: msg.duration_ms as number,
                  output: msg.outputPreview as string,
                  error: msg.error as string | undefined,
                };
                break;
              }
            }
            return { ...m, tools };
          });
          break;
        }
        case 'approval_request':
          setApproval({
            requestId: msg.requestId as string,
            call: msg.call as ToolCallView,
            risk: (msg.risk as Risk) || RISK_FALLBACK,
          });
          break;
        case 'ask_user':
          setAsk({ requestId: msg.requestId as string, question: msg.question as string });
          break;
        case 'task_result': {
          const result = msg.result as TaskResultView;
          patchAgent((m) => ({ ...m, streaming: false, result }));
          setSessionCost(msg.sessionCost as number);
          setBusy(false);
          activeMsgId.current = null;
          break;
        }
        case 'task_error':
          patchAgent((m) => ({ ...m, streaming: false, error: msg.message as string }));
          setBusy(false);
          activeMsgId.current = null;
          break;
      }
    };

    open();
    return () => { closed = true; clearTimeout(retry); wsRef.current?.close(); };
  }, [patchAgent]);

  const send = useCallback((obj: Record<string, unknown>) => {
    wsRef.current?.send(JSON.stringify(obj));
  }, []);

  const runTask = useCallback((task: string) => {
    if (busy || conn !== 'live') return;
    const taskId = uid();
    const agentId = uid();
    activeMsgId.current = agentId;
    setBusy(true);
    setMessages((prev) => [
      ...prev,
      { id: uid(), role: 'user', text: task, tools: [] },
      { id: agentId, role: 'agent', text: '', tools: [], streaming: true },
    ]);
    send({ type: 'task', id: taskId, task });
  }, [busy, conn, send]);

  const respondApproval = useCallback((approved: boolean, always?: boolean) => {
    if (!approval) return;
    if (always) send({ type: 'answer', requestId: `always:${approval.requestId}` });
    send({ type: 'approve', requestId: approval.requestId, approved });
    setApproval(null);
  }, [approval, send]);

  const respondAsk = useCallback((text: string) => {
    if (!ask) return;
    send({ type: 'answer', requestId: ask.requestId, text });
    setAsk(null);
  }, [ask, send]);

  const changeMode = useCallback((next: Mode) => {
    setMode(next);
    send({ type: 'set_mode', mode: next });
  }, [send]);

  const newChat = useCallback(() => {
    if (busy) return;
    setMessages([]);
    setApproval(null);
    setAsk(null);
    activeMsgId.current = null;
  }, [busy]);

  return {
    conn, status, mode, messages, approval, ask, busy, sessionCost,
    runTask, respondApproval, respondAsk, changeMode, newChat,
  };
}

/** Client-side risk guess mirroring the warden, for immediate chip coloring. */
function guessRisk(name: string, input: Record<string, unknown>): Risk {
  if (name.startsWith('mcp__')) return 'execute';
  if (['read_file', 'list_dir', 'search_codebase', 'ask_user', 'final_answer'].includes(name)) return 'read';
  if (name === 'web_fetch') return 'execute';
  if (name === 'write_file' || name === 'edit_file') return 'write';
  if (name === 'delete_file') return 'destructive';
  if (name === 'run_command') {
    const cmd = String(input.cmd || '');
    if (/\brm\s+-\w*[rf]|\bmkfs\b|\bdd\s+\S*of=|\bgit\s+reset\s+--hard\b|--force/i.test(cmd)) return 'destructive';
    return 'execute';
  }
  return 'execute';
}
