import React, { useEffect, useRef, useCallback } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useStore } from '../../store';
import MessageBubble from './MessageBubble';
import InputBar from './InputBar';
import ContextBar from '../ContextBar';
import SessionTabs from '../SessionTabs';

export default function ChatView() {
  const activeSession = useStore(s => s.activeSession());
  const isRunning = useStore(s => s.isRunning);
  const fontSize = useStore(s => s.fontSize);
  const config = useStore(s => s.config);
  const cwd = useStore(s => s.cwd);
  const { setRunning, handleTaskEvent } = useStore(s => ({
    setRunning: s.setRunning,
    handleTaskEvent: s.handleTaskEvent,
  }));

  const scrollRef = useRef<HTMLDivElement>(null);
  const listenerRef = useRef<((_: unknown, e: unknown) => void) | null>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [activeSession?.messages]);

  // Wire up task event listener
  useEffect(() => {
    const listener = window.trident?.onTaskEvent((e) => {
      handleTaskEvent(e);
    }) as ((_: unknown, e: unknown) => void) | null;
    if (listener) listenerRef.current = listener;
    return () => {
      if (listenerRef.current) {
        window.trident?.offTaskEvent(listenerRef.current);
        listenerRef.current = null;
      }
    };
  }, [handleTaskEvent]);

  const handleSubmit = useCallback(async (text: string) => {
    if (isRunning) return;

    const { addMessage } = useStore.getState();
    addMessage({
      id: Math.random().toString(36).slice(2),
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: Date.now(),
    });

    setRunning(true);

    await window.trident?.runTask(text, {
      model: config?.model,
      provider: config?.provider,
      mode: config?.mode,
      maxTurns: config?.maxTurns,
      budget: config?.budgetUsd ?? undefined,
      thinking: config?.thinking || false,
      cwd,
    }).catch(() => {
      setRunning(false);
    });
  }, [isRunning, config, cwd, setRunning]);

  const messages = activeSession?.messages ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <SessionTabs />
      <ContextBar />

      {/* Messages */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '16px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
        }}
      >
        {messages.length === 0 && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '16px',
              color: 'var(--text-dim)',
              userSelect: 'none',
              paddingBottom: '80px',
            }}
          >
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.3 }}>
              <path d="M12 2L4 8v8l8 6 8-6V8L12 2z" stroke="var(--accent)" strokeWidth="1.5" fill="var(--accent)" fillOpacity="0.15" />
              <path d="M12 2v20M4 8l8 4 8-4" stroke="var(--accent)" strokeWidth="1.5" />
            </svg>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '16px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '8px' }}>
                TRIDENT
              </div>
              <div style={{ fontSize: '12px', fontFamily: 'var(--font-mono)', lineHeight: 1.8 }}>
                <div>FORGE · ORACLE · WARDEN</div>
                <div style={{ marginTop: '8px', color: 'var(--text-dim)' }}>
                  Describe a task to begin
                </div>
              </div>
            </div>
            <div style={{
              display: 'flex',
              gap: '24px',
              fontSize: '11px',
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-dim)',
              marginTop: '8px',
            }}>
              {[
                ['Cmd+K', 'palette'],
                ['@file', 'reference'],
                ['Shift+↵', 'newline'],
              ].map(([key, desc]) => (
                <span key={key}>
                  <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{key}</span>
                  <span style={{ marginLeft: '4px' }}>{desc}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        <AnimatePresence initial={false}>
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} fontSize={fontSize} />
          ))}
        </AnimatePresence>

        {/* Typing indicator while running with no new message yet */}
        {isRunning && messages.length > 0 && !messages[messages.length - 1]?.streaming && (
          <div style={{ display: 'flex', gap: '4px', padding: '8px 4px', alignItems: 'center' }}>
            {[0, 1, 2].map(i => (
              <span
                key={i}
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  background: 'var(--accent)',
                  display: 'inline-block',
                  animation: `typing-dots 1.2s ease-in-out infinite`,
                  animationDelay: `${i * 0.2}s`,
                }}
              />
            ))}
          </div>
        )}
      </div>

      <InputBar onSubmit={handleSubmit} />
    </div>
  );
}
