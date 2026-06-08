import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import type { HistorySession } from '../../types';
import { formatDate, formatCost } from '../../ipc';

export default function History() {
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<HistorySession | null>(null);

  const loadSessions = () => {
    setLoading(true);
    window.trident?.listSessions().then(s => {
      setSessions(s);
      setLoading(false);
    }).catch(() => setLoading(false));
  };

  useEffect(() => {
    loadSessions();
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-dim)' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px' }}>Loading...</span>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-dim)', gap: '12px' }}>
        <span style={{ fontSize: '32px', opacity: 0.3 }}>◎</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px' }}>No sessions recorded yet</span>
        <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>Sessions are saved to ~/.trident/logs/</span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Session list */}
      <div style={{
        width: '240px',
        borderRight: '1px solid var(--border)',
        overflowY: 'auto',
        flexShrink: 0,
      }}>
        <div style={{
          padding: '12px 16px 8px',
          fontSize: '10px',
          fontFamily: 'var(--font-mono)',
          fontWeight: 700,
          color: 'var(--accent)',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>Session History ({sessions.length})</span>
          <button
            onClick={loadSessions}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-dim)',
              cursor: 'pointer',
              fontSize: '12px',
              padding: '0 4px',
            }}
            title="Refresh"
          >
            ↺
          </button>
        </div>
        {sessions.map((sess) => (
          <motion.div
            key={sess.id}
            onClick={() => setSelected(sess)}
            whileHover={{ background: 'var(--surface)' }}
            style={{
              padding: '10px 16px',
              borderBottom: '1px solid var(--border)',
              cursor: 'pointer',
              background: selected?.id === sess.id ? 'var(--surface)' : 'transparent',
              borderLeft: selected?.id === sess.id ? '3px solid var(--accent)' : '3px solid transparent',
            }}
          >
            <div style={{
              fontSize: '12px',
              fontFamily: 'var(--font-mono)',
              color: 'var(--text)',
              marginBottom: '4px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {sess.task || sess.id}
            </div>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '10px',
              color: 'var(--text-dim)',
            }}>
              <span>{sess.mtime ? formatDate(sess.mtime) : '—'}</span>
              {sess.totalCost !== undefined && (
                <span style={{ color: 'var(--teal)' }}>{formatCost(sess.totalCost)}</span>
              )}
            </div>
            {sess.turns !== undefined && (
              <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '2px' }}>
                {sess.turns} turns
              </div>
            )}
          </motion.div>
        ))}
      </div>

      {/* Detail panel */}
      <div style={{ flex: 1, padding: '24px', overflowY: 'auto' }}>
        {selected ? (
          <div>
            <div style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
              color: 'var(--text-dim)',
              marginBottom: '16px',
            }}>
              <div style={{ color: 'var(--text)', fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>
                {selected.task || selected.id}
              </div>
              {selected.mtime && <div>Date: {formatDate(selected.mtime)}</div>}
              {selected.turns !== undefined && <div>Turns: {selected.turns}</div>}
              {selected.totalCost !== undefined && <div>Cost: {formatCost(selected.totalCost)}</div>}
              {selected.file && <div style={{ marginTop: '8px', wordBreak: 'break-all' }}>File: {selected.file}</div>}
            </div>
          </div>
        ) : (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'var(--text-dim)',
            fontSize: '13px',
            fontFamily: 'var(--font-mono)',
          }}>
            Select a session to view details
          </div>
        )}
      </div>
    </div>
  );
}
