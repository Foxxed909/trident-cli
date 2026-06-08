import React from 'react';
import { useStore } from '../store';
import { formatCost, formatTokens } from '../ipc';

export default function StatusBar() {
  const isRunning = useStore(s => s.isRunning);
  const totalCost = useStore(s => s.totalCost);
  const totalTokens = useStore(s => s.totalTokens);
  const turns = useStore(s => s.turns);
  const config = useStore(s => s.config);
  const cwd = useStore(s => s.cwd);

  const budgetUsedPct = config?.budgetUsd && totalCost > 0
    ? Math.min(100, (totalCost / config.budgetUsd) * 100)
    : null;

  return (
    <div
      style={{
        height: 'var(--statusbar-h)',
        display: 'flex',
        alignItems: 'center',
        paddingLeft: '12px',
        paddingRight: '12px',
        gap: '16px',
        background: 'var(--bg)',
        borderTop: '1px solid var(--border)',
        flexShrink: 0,
        fontSize: '11px',
        fontFamily: 'var(--font-mono)',
        color: 'var(--text-dim)',
        userSelect: 'none',
      }}
    >
      {/* Status dot */}
      <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
        <span
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: isRunning ? 'var(--warning)' : 'var(--success)',
            display: 'inline-block',
            animation: isRunning ? 'pulse-opacity 1s ease-in-out infinite' : 'none',
          }}
        />
        <span style={{ color: isRunning ? 'var(--warning)' : 'var(--success)' }}>
          {isRunning ? 'RUNNING' : 'IDLE'}
        </span>
      </span>

      <span style={{ color: 'var(--border)' }}>│</span>

      {/* CWD */}
      <span
        style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={cwd}
      >
        {cwd}
      </span>

      <span style={{ color: 'var(--border)' }}>│</span>

      {/* Turns */}
      <span>
        <span style={{ color: 'var(--text-muted)' }}>turns </span>
        <span style={{ color: 'var(--text)' }}>{turns}</span>
        {config?.maxTurns && (
          <span style={{ color: 'var(--text-dim)' }}>/{config.maxTurns}</span>
        )}
      </span>

      <span style={{ color: 'var(--border)' }}>│</span>

      {/* Tokens */}
      <span>
        <span style={{ color: 'var(--text-muted)' }}>in </span>
        <span style={{ color: 'var(--teal)' }}>{formatTokens(totalTokens.input)}</span>
        <span style={{ color: 'var(--text-dim)' }}> / </span>
        <span style={{ color: 'var(--text-muted)' }}>out </span>
        <span style={{ color: 'var(--amber)' }}>{formatTokens(totalTokens.output)}</span>
      </span>

      <span style={{ color: 'var(--border)' }}>│</span>

      {/* Cost */}
      <span>
        <span style={{ color: 'var(--text-muted)' }}>cost </span>
        <span style={{ color: totalCost > 0.1 ? 'var(--warning)' : 'var(--text)' }}>
          {formatCost(totalCost)}
        </span>
        {budgetUsedPct !== null && (
          <span style={{ color: budgetUsedPct > 80 ? 'var(--error)' : 'var(--text-dim)' }}>
            {' '}({budgetUsedPct.toFixed(0)}% budget)
          </span>
        )}
      </span>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Model */}
      <span style={{ color: 'var(--text-dim)' }}>
        {config?.model || 'claude-sonnet-4-6'}
      </span>

      <span style={{ color: 'var(--border)' }}>│</span>

      {/* Mode */}
      <span style={{
        color: config?.mode === 'yolo' ? 'var(--error)' :
               config?.mode === 'lockdown' ? 'var(--teal)' : 'var(--warning)',
        fontWeight: 700,
        textTransform: 'uppercase',
      }}>
        {config?.mode || 'review'}
      </span>
    </div>
  );
}
