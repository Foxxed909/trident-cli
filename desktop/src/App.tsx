import React, { useEffect, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from './store';

import TitleBar from './components/TitleBar';
import Sidebar from './components/Sidebar';
import StatusBar from './components/StatusBar';
import ChatView from './components/Chat/ChatView';
import Settings from './components/panels/Settings';
import History from './components/panels/History';
import Memory from './components/panels/Memory';
import Permits from './components/panels/Permits';
import CommandPalette from './components/CommandPalette';
import Particles from './components/animations/Particles';

export default function App() {
  const currentView = useStore(s => s.currentView);
  const commandPaletteOpen = useStore(s => s.commandPaletteOpen);
  const setCommandPaletteOpen = useStore(s => s.setCommandPaletteOpen);
  const { setConfig, setModels, setCwd } = useStore(s => ({
    setConfig: s.setConfig,
    setModels: s.setModels,
    setCwd: s.setCwd,
  }));

  // Bootstrap: load config, models, cwd
  useEffect(() => {
    Promise.all([
      window.trident?.getConfig(),
      window.trident?.listModels(),
      window.trident?.getCwd(),
    ]).then(([cfg, models, cwd]) => {
      if (cfg) setConfig(cfg);
      if (models) setModels(models);
      if (cwd) setCwd(cwd);
    }).catch(() => {});
  }, [setConfig, setModels, setCwd]);

  // Global keyboard shortcuts
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Cmd/Ctrl+K — command palette
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      setCommandPaletteOpen(!commandPaletteOpen);
      return;
    }
    // Escape — close palette
    if (e.key === 'Escape' && commandPaletteOpen) {
      setCommandPaletteOpen(false);
    }
    // Cmd/Ctrl+= / + — font up
    if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      useStore.getState().increaseFontSize();
    }
    // Cmd/Ctrl+- — font down
    if ((e.metaKey || e.ctrlKey) && e.key === '-') {
      e.preventDefault();
      useStore.getState().decreaseFontSize();
    }
  }, [commandPaletteOpen, setCommandPaletteOpen]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const panelVariants = {
    initial: { opacity: 0, x: 12 },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: -12 },
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100vw',
        height: '100vh',
        background: 'var(--bg)',
        color: 'var(--text)',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* Ambient background particles — subtle behind everything */}
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0, opacity: 0.4 }}>
        <Particles count={30} />
      </div>

      {/* Custom titlebar */}
      <TitleBar />

      {/* Main layout: sidebar + content */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative', zIndex: 1 }}>
        <Sidebar />

        {/* Content area */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
          <AnimatePresence mode="wait">
            {currentView === 'chat' && (
              <motion.div
                key="chat"
                variants={panelVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={{ duration: 0.15 }}
                style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
              >
                <ChatView />
              </motion.div>
            )}

            {currentView === 'history' && (
              <motion.div
                key="history"
                variants={panelVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={{ duration: 0.15 }}
                style={{ flex: 1, overflow: 'hidden' }}
              >
                <PanelShell title="History">
                  <History />
                </PanelShell>
              </motion.div>
            )}

            {currentView === 'memory' && (
              <motion.div
                key="memory"
                variants={panelVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={{ duration: 0.15 }}
                style={{ flex: 1, overflow: 'hidden' }}
              >
                <PanelShell title="Memory">
                  <Memory />
                </PanelShell>
              </motion.div>
            )}

            {currentView === 'permits' && (
              <motion.div
                key="permits"
                variants={panelVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={{ duration: 0.15 }}
                style={{ flex: 1, overflow: 'hidden' }}
              >
                <PanelShell title="Permits">
                  <Permits />
                </PanelShell>
              </motion.div>
            )}

            {currentView === 'settings' && (
              <motion.div
                key="settings"
                variants={panelVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={{ duration: 0.15 }}
                style={{ flex: 1, overflow: 'hidden' }}
              >
                <PanelShell title="Settings">
                  <Settings />
                </PanelShell>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Status bar — bottom */}
      <StatusBar />

      {/* Command palette overlay */}
      <CommandPalette />
    </div>
  );
}

function PanelShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{
        padding: '0 16px',
        height: '36px',
        display: 'flex',
        alignItems: 'center',
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface)',
        flexShrink: 0,
      }}>
        <span style={{
          fontSize: '11px',
          fontFamily: 'var(--font-mono)',
          fontWeight: 700,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
        }}>
          {title}
        </span>
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  );
}
