import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore, type View } from '../store';

interface Command {
  id: string;
  icon: string;
  label: string;
  description: string;
  action: () => void;
  keywords?: string[];
}

function useCommands(): Command[] {
  const { setView, newSession, setCommandPaletteOpen } = useStore(s => ({
    setView: s.setView,
    newSession: s.newSession,
    setCommandPaletteOpen: s.setCommandPaletteOpen,
  }));

  const go = (view: View) => {
    setView(view);
    setCommandPaletteOpen(false);
  };

  return [
    { id: 'chat',       icon: '◈', label: 'Go to Chat',     description: 'Open chat view',          action: () => go('chat'),     keywords: ['chat', 'message'] },
    { id: 'history',    icon: '◎', label: 'Go to History',  description: 'View past sessions',      action: () => go('history'),  keywords: ['history', 'sessions', 'past'] },
    { id: 'memory',     icon: '⊠', label: 'Edit Memory',    description: 'Edit TRIDENT.md context', action: () => go('memory'),   keywords: ['memory', 'trident.md', 'context'] },
    { id: 'permits',    icon: '⊞', label: 'Manage Permits', description: 'Configure auto-approvals', action: () => go('permits'),  keywords: ['permits', 'allow', 'approve'] },
    { id: 'settings',   icon: '⊙', label: 'Open Settings',  description: 'Configure TRIDENT',       action: () => go('settings'), keywords: ['settings', 'config', 'model'] },
    { id: 'new-session',icon: '+', label: 'New Session',    description: 'Start a fresh chat',      action: () => { newSession(); go('chat'); }, keywords: ['new', 'session'] },
    { id: 'font-up',    icon: 'A+', label: 'Increase Font',  description: 'Make text larger',       action: () => { useStore.getState().increaseFontSize(); setCommandPaletteOpen(false); }, keywords: ['font', 'size', 'larger'] },
    { id: 'font-down',  icon: 'A-', label: 'Decrease Font',  description: 'Make text smaller',     action: () => { useStore.getState().decreaseFontSize(); setCommandPaletteOpen(false); }, keywords: ['font', 'size', 'smaller'] },
    { id: 'word-wrap',  icon: '↵', label: 'Toggle Word Wrap', description: 'Toggle line wrapping',  action: () => { useStore.getState().toggleWordWrap(); setCommandPaletteOpen(false); }, keywords: ['wrap', 'line'] },
    { id: 'abort',      icon: '■', label: 'Abort Task',    description: 'Stop current running task', action: () => { window.trident?.abortTask(); useStore.getState().setRunning(false); setCommandPaletteOpen(false); }, keywords: ['abort', 'stop', 'cancel'] },
  ];
}

export default function CommandPalette() {
  const open = useStore(s => s.commandPaletteOpen);
  const setOpen = useStore(s => s.setCommandPaletteOpen);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const commands = useCommands();

  const filtered = query.trim()
    ? commands.filter(c => {
        const q = query.toLowerCase();
        return (
          c.label.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q) ||
          c.keywords?.some(k => k.includes(q))
        );
      })
    : commands;

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const execute = useCallback((cmd: Command) => {
    cmd.action();
    setOpen(false);
  }, [setOpen]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected(s => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected(s => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[selected]) execute(filtered[selected]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }, [filtered, selected, execute, setOpen]);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setOpen(false)}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0,0,0,0.7)',
              zIndex: 999,
              backdropFilter: 'blur(4px)',
            }}
          />

          {/* Palette */}
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: -20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -20 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            style={{
              position: 'fixed',
              top: '15%',
              left: '50%',
              transform: 'translateX(-50%)',
              width: '520px',
              maxWidth: 'calc(100vw - 40px)',
              background: 'var(--surface)',
              border: '1px solid var(--accent)',
              borderRadius: 'var(--radius-lg)',
              boxShadow: '0 0 60px rgba(220, 38, 38, 0.3), 0 24px 80px rgba(0,0,0,0.8)',
              zIndex: 1000,
              overflow: 'hidden',
            }}
          >
            {/* Search input */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '12px 16px',
              borderBottom: '1px solid var(--border)',
            }}>
              <span style={{ color: 'var(--accent)', fontSize: '16px', flexShrink: 0 }}>⌘</span>
              <input
                ref={inputRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a command..."
                style={{
                  flex: 1,
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text)',
                  fontSize: '15px',
                  outline: 'none',
                  fontFamily: 'var(--font-sans)',
                }}
              />
              <kbd style={{
                fontSize: '10px',
                color: 'var(--text-dim)',
                background: 'var(--surface2)',
                border: '1px solid var(--border)',
                borderRadius: '4px',
                padding: '2px 6px',
                fontFamily: 'var(--font-mono)',
                flexShrink: 0,
              }}>
                ESC
              </kbd>
            </div>

            {/* Command list */}
            <div style={{ maxHeight: '340px', overflowY: 'auto' }}>
              {filtered.length === 0 ? (
                <div style={{
                  padding: '20px',
                  textAlign: 'center',
                  color: 'var(--text-dim)',
                  fontSize: '13px',
                  fontFamily: 'var(--font-mono)',
                }}>
                  No commands found
                </div>
              ) : (
                filtered.map((cmd, i) => (
                  <motion.div
                    key={cmd.id}
                    onClick={() => execute(cmd)}
                    onMouseEnter={() => setSelected(i)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      padding: '10px 16px',
                      cursor: 'pointer',
                      background: i === selected ? 'var(--accent)18' : 'transparent',
                      borderLeft: i === selected ? '3px solid var(--accent)' : '3px solid transparent',
                    }}
                  >
                    <span style={{
                      fontSize: '16px',
                      color: i === selected ? 'var(--accent)' : 'var(--text-dim)',
                      width: '20px',
                      flexShrink: 0,
                    }}>
                      {cmd.icon}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: '13px',
                        color: i === selected ? 'var(--text)' : 'var(--text-muted)',
                        fontWeight: i === selected ? 600 : 400,
                      }}>
                        {cmd.label}
                      </div>
                      <div style={{
                        fontSize: '11px',
                        color: 'var(--text-dim)',
                        fontFamily: 'var(--font-mono)',
                      }}>
                        {cmd.description}
                      </div>
                    </div>
                    {i === selected && (
                      <kbd style={{
                        fontSize: '10px',
                        color: 'var(--text-dim)',
                        background: 'var(--surface2)',
                        border: '1px solid var(--border)',
                        borderRadius: '4px',
                        padding: '2px 6px',
                        fontFamily: 'var(--font-mono)',
                      }}>
                        ↵
                      </kbd>
                    )}
                  </motion.div>
                ))
              )}
            </div>

            {/* Footer hint */}
            <div style={{
              padding: '8px 16px',
              borderTop: '1px solid var(--border)',
              display: 'flex',
              gap: '16px',
              fontSize: '10px',
              color: 'var(--text-dim)',
              fontFamily: 'var(--font-mono)',
            }}>
              <span><span style={{ color: 'var(--accent)' }}>↑↓</span> navigate</span>
              <span><span style={{ color: 'var(--accent)' }}>↵</span> select</span>
              <span><span style={{ color: 'var(--accent)' }}>esc</span> close</span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
