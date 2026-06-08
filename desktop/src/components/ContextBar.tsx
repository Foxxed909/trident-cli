import React from 'react';
import { motion } from 'framer-motion';
import { useStore } from '../store';
import { formatTokens } from '../ipc';

export default function ContextBar() {
  const contextUsed = useStore(s => s.contextUsed);
  const contextLimit = useStore(s => s.contextLimit);

  const pct = contextLimit > 0 ? Math.min(100, (contextUsed / contextLimit) * 100) : 0;

  const color =
    pct > 90 ? 'var(--error)' :
    pct > 75 ? 'var(--warning)' :
    pct > 50 ? 'var(--amber)' :
    'var(--teal)';

  return (
    <div
      style={{
        height: 'var(--contextbar-h)',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        paddingLeft: '12px',
        paddingRight: '12px',
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          fontSize: '10px',
          color: 'var(--text-dim)',
          fontFamily: 'var(--font-mono)',
          flexShrink: 0,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        ctx
      </span>

      {/* Bar */}
      <div
        style={{
          flex: 1,
          height: '4px',
          background: 'var(--border)',
          borderRadius: '2px',
          overflow: 'hidden',
        }}
      >
        <motion.div
          style={{
            height: '100%',
            background: color,
            borderRadius: '2px',
            transformOrigin: 'left',
            boxShadow: pct > 50 ? `0 0 6px ${color}` : 'none',
          }}
          animate={{ width: `${pct}%` }}
          transition={{ type: 'spring', stiffness: 100, damping: 20 }}
        />
      </div>

      <span style={{
        fontSize: '10px',
        fontFamily: 'var(--font-mono)',
        color,
        flexShrink: 0,
        minWidth: '60px',
        textAlign: 'right',
      }}>
        {pct.toFixed(1)}%
        {contextUsed > 0 && (
          <span style={{ color: 'var(--text-dim)', marginLeft: '4px' }}>
            {formatTokens(contextUsed)}/{formatTokens(contextLimit)}
          </span>
        )}
      </span>
    </div>
  );
}
