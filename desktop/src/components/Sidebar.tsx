import React from 'react';
import { motion } from 'framer-motion';
import { useStore, type View } from '../store';

interface NavItem {
  view: View;
  icon: string;
  label: string;
  title: string;
}

const NAV_ITEMS: NavItem[] = [
  { view: 'chat',     icon: '◈',  label: 'CHAT',    title: 'Chat' },
  { view: 'history',  icon: '◎',  label: 'HIST',    title: 'History' },
  { view: 'memory',   icon: '⊠',  label: 'MEM',     title: 'Memory / TRIDENT.md' },
  { view: 'permits',  icon: '⊞',  label: 'PRMT',    title: 'Permit Rules' },
  { view: 'settings', icon: '⊙',  label: 'CFG',     title: 'Settings' },
];

export default function Sidebar() {
  const currentView = useStore(s => s.currentView);
  const setView = useStore(s => s.setView);
  const isRunning = useStore(s => s.isRunning);

  return (
    <div
      style={{
        width: 'var(--sidebar-w)',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        background: 'var(--bg)',
        borderRight: '1px solid var(--border)',
        flexShrink: 0,
        paddingTop: '8px',
        paddingBottom: '8px',
        gap: '2px',
      }}
    >
      {NAV_ITEMS.map((item) => {
        const active = currentView === item.view;
        return (
          <motion.button
            key={item.view}
            onClick={() => setView(item.view)}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            title={item.title}
            style={{
              width: '44px',
              height: '44px',
              borderRadius: 'var(--radius)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '2px',
              background: active ? 'var(--accent)18' : 'transparent',
              border: `1px solid ${active ? 'var(--accent)' : 'transparent'}`,
              color: active ? 'var(--accent)' : 'var(--text-dim)',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
              boxShadow: active ? '0 0 12px var(--accent-glow)' : 'none',
            }}
          >
            <span style={{ fontSize: '16px', lineHeight: 1 }}>{item.icon}</span>
            <span style={{
              fontSize: '8px',
              fontFamily: 'var(--font-mono)',
              letterSpacing: '0.06em',
              fontWeight: 700,
            }}>
              {item.label}
            </span>
          </motion.button>
        );
      })}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Running indicator */}
      {isRunning && (
        <div
          style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: 'var(--warning)',
            animation: 'pulse-opacity 1s ease-in-out infinite',
            marginBottom: '4px',
          }}
          title="Task running"
        />
      )}

      {/* Version */}
      <span style={{
        fontSize: '9px',
        color: 'var(--text-dim)',
        fontFamily: 'var(--font-mono)',
        writingMode: 'vertical-lr',
        transform: 'rotate(180deg)',
        letterSpacing: '0.05em',
        paddingBottom: '4px',
      }}>
        v1.0
      </span>
    </div>
  );
}
