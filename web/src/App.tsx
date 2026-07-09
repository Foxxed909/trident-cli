import { useEffect, useRef, useState } from 'react';
import { useTrident } from './useTrident';
import { TridentMark, Icon } from './Icons';
import { ApprovalCard, AskCard, Composer, MessageView, ModeSwitch } from './components';
import type { McpServerStatus } from './types';

type View = 'chat' | 'connections';

const EXAMPLES = [
  { k: 'refactor', t: 'Extract the config validation into its own module and add tests' },
  { k: 'debug', t: 'The build fails on Windows — find why and fix it' },
  { k: 'review', t: 'Audit src/agent for path-traversal and injection risks' },
  { k: 'feature', t: 'Add a --json flag to the status command' },
];

export function App() {
  const t = useTrident();
  const [collapsed, setCollapsed] = useState(false);
  const [view, setView] = useState<View>('chat');
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [t.messages, t.approval, t.ask]);

  const chats = t.messages.length > 0
    ? [{ id: 'current', title: firstUserLine(t.messages) }]
    : [];

  return (
    <div className={`app ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <div className="bg-field" aria-hidden="true" />
      <div className="bg-grid" aria-hidden="true" />

      <aside className="sidebar">
        <div className="brand">
          <TridentMark className="brand-mark" />
          <span className="brand-name">TRI<span className="accent">DENT</span></span>
        </div>

        <button className="new-chat" onClick={() => { t.newChat(); setView('chat'); }}>
          <span className="plus">+</span>
          <span>New chat</span>
        </button>

        <div className="side-section">
          <div className="side-label">
            <Icon name="chat" size={13} /> <span>Chats</span>
            <span className="count">{chats.length}</span>
          </div>
          <div className="chat-list">
            {chats.length === 0 && !collapsed && (
              <div style={{ padding: '6px 10px', fontSize: '0.76rem', color: 'var(--ink-faint)' }}>No chats yet</div>
            )}
            {chats.map((c) => (
              <button key={c.id} className={`nav-item ${view === 'chat' ? 'active' : ''}`} onClick={() => setView('chat')}>
                <Icon name="chat" size={14} />
                <span>{c.title}</span>
              </button>
            ))}
          </div>

          <div className="side-label">
            <Icon name="plug" size={13} /> <span>Connections</span>
            <span className="count">{t.status?.mcpServers.length ?? 0}</span>
          </div>
          <div className="chat-list">
            <button className={`nav-item ${view === 'connections' ? 'active' : ''}`} onClick={() => setView('connections')}>
              <Icon name="plug" size={14} />
              <span>MCP servers</span>
            </button>
            {(t.status?.mcpServers ?? []).map((s) => (
              <button key={s.name} className="nav-item" onClick={() => setView('connections')}>
                <span className={`dot ${s.connected ? 'ok' : 'off'}`} />
                <span>{s.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="side-foot">
          <span className={`conn-status ${t.conn === 'live' ? 'live' : 'dead'}`}><span className="dot" /></span>
          <span className="who">{t.status?.userName || 'Operator'}</span>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="icon-btn" onClick={() => setCollapsed((c) => !c)} aria-label="Toggle sidebar">
            <Icon name="menu" size={18} />
          </button>
          <span className="topbar-title">{view === 'connections' ? 'Connections' : (t.status?.project ?? 'TRIDENT')}</span>
          <div className="topbar-meta">
            <span className="chip"><span className="swatch" style={{ background: 'var(--teal)' }} />{t.status?.model ?? '…'}</span>
            {t.sessionCost > 0 && <span className="chip" style={{ color: 'var(--amber)' }}>${t.sessionCost.toFixed(4)}</span>}
            <ModeSwitch mode={t.mode} onChange={t.changeMode} />
            <span className={`conn-status ${t.conn === 'live' ? 'live' : 'dead'}`} title={t.conn}>
              <span className="dot" />{t.conn === 'live' ? 'live' : t.conn === 'connecting' ? '…' : 'offline'}
            </span>
          </div>
        </header>

        {view === 'connections' ? (
          <ConnectionsView servers={t.status?.mcpServers ?? []} />
        ) : (
          <>
            <div className="stream" ref={streamRef}>
              {t.messages.length === 0 ? (
                <Welcome name={t.status?.userName} onPick={t.runTask} disabled={t.conn !== 'live'} />
              ) : (
                <div className="stream-inner">
                  {t.messages.map((m) => <MessageView key={m.id} msg={m} />)}
                  {t.approval && <ApprovalCard req={t.approval} onRespond={t.respondApproval} />}
                  {t.ask && <AskCard req={t.ask} onRespond={t.respondAsk} />}
                </div>
              )}
            </div>
            <Composer disabled={t.conn !== 'live'} busy={t.busy} onSend={t.runTask} />
          </>
        )}
      </main>
    </div>
  );
}

function Welcome({ name, onPick, disabled }: { name?: string; onPick: (t: string) => void; disabled: boolean }) {
  return (
    <div className="welcome">
      <TridentMark className="welcome-mark" />
      <h1>Welcome back{name ? `, ${name}` : ''}. <span className="accent">Forge</span> something.</h1>
      <p className="sub">Three prongs, one power. Describe a task and Trident builds, understands, and guards your codebase — live, in your own repo.</p>
      <div className="examples">
        {EXAMPLES.map((e) => (
          <button key={e.k} className="example" onClick={() => !disabled && onPick(e.t)} disabled={disabled}>
            <span className="k">{e.k}</span>
            <span className="t">{e.t}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ConnectionsView({ servers }: { servers: McpServerStatus[] }) {
  return (
    <div className="stream">
      <div className="stream-inner">
        <h2 className="section-title">Connections</h2>
        <p className="section-lead">MCP servers configured in <code style={{ fontFamily: 'var(--font-mono)' }}>.trident/mcp.json</code> and exposed to the agent as tools.</p>
        {servers.length === 0 ? (
          <div className="conn-card">
            <span className="conn-icon"><Icon name="plug" size={18} /></span>
            <div>
              <div className="conn-name">No connections yet</div>
              <div className="conn-sub">Add servers to .trident/mcp.json, then restart trident serve</div>
            </div>
          </div>
        ) : (
          <div className="conn-grid">
            {servers.map((s) => (
              <div key={s.name} className="conn-card">
                <span className="conn-icon"><Icon name="plug" size={18} /></span>
                <div>
                  <div className="conn-name">{s.name}</div>
                  <div className="conn-sub">{s.connected ? `${s.toolCount} tool(s) available` : (s.error || 'failed to connect')}</div>
                </div>
                <span className={`conn-badge risk-chip ${s.connected ? 'risk-execute' : 'risk-destructive'}`}>
                  {s.connected ? 'connected' : 'offline'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function firstUserLine(messages: { role: string; text: string }[]): string {
  const first = messages.find((m) => m.role === 'user');
  const line = (first?.text ?? 'Chat').split('\n')[0];
  return line.length > 30 ? line.slice(0, 30) + '…' : line;
}
