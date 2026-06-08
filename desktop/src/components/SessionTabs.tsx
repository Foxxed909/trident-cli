import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore } from '../store';
import { truncate } from '../ipc';

export default function SessionTabs() {
  const sessions = useStore(s => s.sessions);
  const activeSessionId = useStore(s => s.activeSessionId);
  const { newSession, switchSession, closeSession, renameSession } = useStore(s => ({
    newSession: s.newSession,
    switchSession: s.switchSession,
    closeSession: s.closeSession,
    renameSession: s.renameSession,
  }));

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const startEdit = (id: string, name: string) => {
    setEditingId(id);
    setEditValue(name);
  };

  const commitEdit = () => {
    if (editingId && editValue.trim()) {
      renameSession(editingId, editValue.trim());
    }
    setEditingId(null);
  };

  return (
    <div
      style={{
        height: 'var(--tab-h)',
        display: 'flex',
        alignItems: 'stretch',
        background: 'var(--bg)',
        borderBottom: '1px solid var(--border)',
        overflowX: 'auto',
        flexShrink: 0,
      }}
    >
      <AnimatePresence initial={false}>
        {sessions.map((sess) => {
          const active = sess.id === activeSessionId;
          return (
            <motion.div
              key={sess.id}
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 'auto', opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.15 }}
              style={{
                display: 'flex',
                alignItems: 'center',
                borderRight: '1px solid var(--border)',
                borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                background: active ? 'var(--surface)' : 'transparent',
                minWidth: '100px',
                maxWidth: '160px',
                cursor: 'pointer',
                flexShrink: 0,
                overflow: 'hidden',
              }}
              onClick={() => switchSession(sess.id)}
            >
              {editingId === sess.id ? (
                <input
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitEdit();
                    if (e.key === 'Escape') setEditingId(null);
                    e.stopPropagation();
                  }}
                  autoFocus
                  onClick={e => e.stopPropagation()}
                  style={{
                    flex: 1,
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text)',
                    fontSize: '12px',
                    fontFamily: 'var(--font-mono)',
                    padding: '0 8px',
                    outline: 'none',
                  }}
                />
              ) : (
                <span
                  onDoubleClick={(e) => { e.stopPropagation(); startEdit(sess.id, sess.name); }}
                  style={{
                    flex: 1,
                    fontSize: '12px',
                    fontFamily: 'var(--font-mono)',
                    color: active ? 'var(--text)' : 'var(--text-dim)',
                    padding: '0 8px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={`${sess.name} (double-click to rename)`}
                >
                  {truncate(sess.name, 16)}
                </span>
              )}

              {/* Running indicator */}
              {sess.isRunning && (
                <span style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  background: 'var(--warning)',
                  animation: 'pulse-opacity 1s ease-in-out infinite',
                  flexShrink: 0,
                  marginRight: '4px',
                }} />
              )}

              {/* Close button */}
              {sessions.length > 1 && (
                <button
                  onClick={(e) => { e.stopPropagation(); closeSession(sess.id); }}
                  style={{
                    width: '18px',
                    height: '18px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: '3px',
                    color: 'var(--text-dim)',
                    fontSize: '12px',
                    marginRight: '4px',
                    flexShrink: 0,
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface2)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  title="Close session"
                >
                  ×
                </button>
              )}
            </motion.div>
          );
        })}
      </AnimatePresence>

      {/* New session button */}
      <motion.button
        onClick={newSession}
        whileHover={{ background: 'var(--surface)' }}
        style={{
          width: '36px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-dim)',
          fontSize: '18px',
          flexShrink: 0,
          borderRight: '1px solid var(--border)',
        }}
        title="New session"
      >
        +
      </motion.button>
    </div>
  );
}
