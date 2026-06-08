import React from 'react';
import { useStore } from '../store';

export default function TitleBar() {
  const isRunning = useStore(s => s.isRunning);

  return (
    <div
      className="titlebar-drag"
      style={{
        height: 'var(--titlebar-h)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingLeft: '16px',
        paddingRight: '8px',
        background: 'var(--bg)',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
        position: 'relative',
      }}
    >
      {/* Logo */}
      <div className="titlebar-no-drag" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path d="M12 2L4 8v8l8 6 8-6V8L12 2z" stroke="var(--accent)" strokeWidth="1.5" fill="var(--accent)" fillOpacity="0.15" />
          <path d="M12 2v20M4 8l8 4 8-4" stroke="var(--accent)" strokeWidth="1.5" />
        </svg>
        <span style={{
          fontSize: '13px',
          fontWeight: 700,
          letterSpacing: '0.15em',
          color: 'var(--accent)',
          fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase',
        }}>
          TRIDENT
        </span>
        {isRunning && (
          <span style={{
            fontSize: '10px',
            color: 'var(--warning)',
            fontFamily: 'var(--font-mono)',
            animation: 'pulse-opacity 1.5s ease-in-out infinite',
          }}>
            ● RUNNING
          </span>
        )}
      </div>

      {/* Window controls — right side, no-drag */}
      <div className="titlebar-no-drag" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        {['minimize', 'maximize', 'close'].map((action) => {
          const colors: Record<string, string> = {
            minimize: 'var(--warning)',
            maximize: 'var(--success)',
            close: 'var(--error)',
          };
          const symbols: Record<string, string> = {
            minimize: '−',
            maximize: '□',
            close: '×',
          };
          const handlers: Record<string, () => void> = {
            minimize: () => window.trident?.minimize(),
            maximize: () => window.trident?.maximize(),
            close: () => window.trident?.close(),
          };
          return (
            <button
              key={action}
              onClick={handlers[action]}
              style={{
                width: '22px',
                height: '22px',
                borderRadius: '50%',
                background: `${colors[action]}22`,
                border: `1px solid ${colors[action]}44`,
                color: colors[action],
                fontSize: action === 'close' ? '14px' : '12px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'background 0.15s, border-color 0.15s',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLElement).style.background = `${colors[action]}44`;
                (e.currentTarget as HTMLElement).style.borderColor = `${colors[action]}88`;
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLElement).style.background = `${colors[action]}22`;
                (e.currentTarget as HTMLElement).style.borderColor = `${colors[action]}44`;
              }}
              title={action}
            >
              {symbols[action]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
