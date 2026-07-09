import { useEffect, useRef, useState } from 'react';
import type { ApprovalRequest, AskRequest, Message, Mode, ToolEntry } from './types';
import { Icon, TridentMark, toolIconName } from './Icons';

function argPreview(name: string, input: Record<string, unknown>): string {
  if (name === 'run_command') return `$ ${String(input.cmd ?? '')}`;
  if (['read_file', 'write_file', 'edit_file', 'delete_file'].includes(name)) return String(input.path ?? '');
  if (name === 'list_dir') return String(input.path ?? '');
  if (name === 'search_codebase') return `"${String(input.query ?? '')}"`;
  if (name === 'web_fetch') return String(input.url ?? '');
  if (name === 'ask_user') return String(input.question ?? '');
  if (name === 'final_answer') return '';
  return JSON.stringify(input);
}

export function ToolRow({ tool }: { tool: ToolEntry }) {
  const [open, setOpen] = useState(false);
  const hasOutput = !!(tool.output || tool.error);
  return (
    <div className="tool">
      <button className="tool-head" onClick={() => hasOutput && setOpen((o) => !o)} aria-expanded={open}>
        <span className={`tool-icon risk-${tool.risk}`}><Icon name={toolIconName(tool.name)} size={13} /></span>
        <span className="tool-name">{tool.name}</span>
        <span className="tool-arg">{argPreview(tool.name, tool.input)}</span>
        <span className={`risk-chip risk-${tool.risk}`}>{tool.risk}</span>
        {tool.durationMs !== undefined && <span className="dur">{tool.durationMs}ms</span>}
        <span className="tool-status">
          {tool.status === 'running' && <span className="spinner" />}
          {tool.status === 'ok' && <span className="tick"><Check /></span>}
          {tool.status === 'fail' && <span className="cross">✕</span>}
        </span>
      </button>
      {open && hasOutput && (
        <div className={`tool-out ${tool.error ? 'err' : ''}`}>{tool.error || tool.output}</div>
      )}
    </div>
  );
}

// small inline check (stroke-based) so the tick reads crisp
function Check() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
  );
}

export function MessageView({ msg }: { msg: Message }) {
  return (
    <div className={`msg ${msg.role}`}>
      <div className={`avatar ${msg.role}`}>{msg.role === 'user' ? 'YOU' : <TridentMark className="brand-mark" />}</div>
      <div className="msg-body">
        <div className="msg-role">{msg.role === 'user' ? 'You' : 'Trident'}</div>
        {msg.text && (
          <div className={`msg-text ${msg.streaming && !msg.tools.length ? 'cursor-blink' : ''}`}>{msg.text}</div>
        )}
        {msg.tools.length > 0 && (
          <div className="tools">{msg.tools.map((t) => <ToolRow key={t.id} tool={t} />)}</div>
        )}
        {msg.result && (
          <div className="task-foot">
            <span className="stat">✓ done</span>
            <span className="stat">{msg.result.turns} turns</span>
            <span className="stat">{(msg.result.totalTokens.input + msg.result.totalTokens.output).toLocaleString()} tok</span>
            <span className="stat cost">${msg.result.totalCost.toFixed(4)}</span>
          </div>
        )}
        {msg.error && <div className="tool-out err" style={{ marginTop: 10, borderRadius: 8, border: '1px solid oklch(0.70 0.17 18 / 0.4)' }}>{msg.error}</div>}
      </div>
    </div>
  );
}
export { Check };

export function ApprovalCard({ req, onRespond }: {
  req: ApprovalRequest;
  onRespond: (approved: boolean, always?: boolean) => void;
}) {
  const detail = argPreview(req.call.name, req.call.input) || JSON.stringify(req.call.input, null, 2);
  const isCmd = req.call.name === 'run_command';
  return (
    <div className={`approval ${req.risk}`}>
      <div className="approval-head">
        <span className={`risk-chip risk-${req.risk}`}>{req.risk}</span>
        <span className="approval-title">Allow <code style={{ fontFamily: 'var(--font-mono)' }}>{req.call.name}</code>?</span>
      </div>
      <div className="approval-detail">{detail}</div>
      <div className="approval-actions">
        <button className="btn btn-primary" onClick={() => onRespond(true)}>Approve</button>
        {isCmd && req.risk !== 'destructive' && (
          <button className="btn btn-ghost" onClick={() => onRespond(true, true)}>Approve &amp; always allow</button>
        )}
        <button className="btn btn-danger" onClick={() => onRespond(false)}>Deny</button>
      </div>
    </div>
  );
}

export function AskCard({ req, onRespond }: { req: AskRequest; onRespond: (text: string) => void }) {
  const [val, setVal] = useState('');
  return (
    <div className="approval execute">
      <div className="approval-head">
        <span className="risk-chip risk-read">question</span>
        <span className="approval-title">{req.question}</span>
      </div>
      <div className="approval-actions" style={{ flexWrap: 'nowrap' }}>
        <input
          autoFocus
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && val.trim()) onRespond(val.trim()); }}
          placeholder="Type your answer…"
          style={{
            flex: 1, background: 'var(--bg-deep)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm)', color: 'var(--ink)', padding: '8px 11px',
            fontFamily: 'var(--font-mono)', fontSize: '0.8rem', outline: 'none',
          }}
        />
        <button className="btn btn-primary" onClick={() => val.trim() && onRespond(val.trim())}>Send</button>
      </div>
    </div>
  );
}

export function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const modes: Mode[] = ['review', 'yolo', 'lockdown'];
  return (
    <div className="mode-switch" role="group" aria-label="Approval mode">
      {modes.map((m) => (
        <button key={m} data-mode={m} data-active={mode === m} onClick={() => onChange(m)}>{m}</button>
      ))}
    </div>
  );
}

export function Composer({ disabled, busy, onSend }: {
  disabled: boolean; busy: boolean; onSend: (task: string) => void;
}) {
  const [val, setVal] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  }, [val]);

  const submit = () => {
    const t = val.trim();
    if (!t || disabled || busy) return;
    onSend(t);
    setVal('');
  };

  return (
    <div className="composer">
      <div className="composer-inner">
        <div className="prompt">
          <button className="plus" title="New chat" aria-label="New chat">+</button>
          <textarea
            ref={ref}
            rows={1}
            value={val}
            placeholder={busy ? 'Trident is working…' : 'Describe a task, or paste an error…'}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
            disabled={disabled}
          />
          <button className="send" onClick={submit} disabled={disabled || busy || !val.trim()} aria-label="Send">
            <Icon name="send" size={16} />
          </button>
        </div>
        <div className="composer-hint">
          <span><kbd>Enter</kbd> send</span>
          <span><kbd>Shift</kbd>+<kbd>Enter</kbd> newline</span>
          <span style={{ marginLeft: 'auto' }}>@file to attach · !cmd to run</span>
        </div>
      </div>
    </div>
  );
}
