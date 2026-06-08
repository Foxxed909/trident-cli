import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore } from '../../store';
import type { PermitRule } from '../../types';
import { randomId } from '../../ipc';

const TOOL_EXAMPLES = [
  'read_file', 'write_file', 'edit_file', 'run_command',
  'delete_file', 'web_search', 'github_api', '*',
];

export default function Permits() {
  const permits = useStore(s => s.permits);
  const { addPermit, togglePermit, removePermit } = useStore(s => ({
    addPermit: s.addPermit,
    togglePermit: s.togglePermit,
    removePermit: s.removePermit,
  }));

  const [toolInput, setToolInput] = useState('');
  const [patternInput, setPatternInput] = useState('');
  const [descInput, setDescInput] = useState('');
  const [adding, setAdding] = useState(false);

  const persistPermits = (updated: typeof permits) => {
    window.trident?.setPermits(updated).catch(() => {});
  };

  const handleAdd = () => {
    if (!toolInput.trim()) return;
    const rule = {
      id: randomId(),
      toolPattern: toolInput.trim(),
      pathPattern: patternInput.trim() || undefined,
      description: descInput.trim() || undefined,
      enabled: true,
    };
    addPermit(rule);
    persistPermits([...permits, rule]);
    setToolInput('');
    setPatternInput('');
    setDescInput('');
    setAdding(false);
  };

  const handleToggle = (id: string) => {
    togglePermit(id);
    const updated = permits.map(p => p.id === id ? { ...p, enabled: !p.enabled } : p);
    persistPermits(updated);
  };

  const handleRemove = (id: string) => {
    removePermit(id);
    persistPermits(permits.filter(p => p.id !== id));
  };

  const riskColors: Record<string, string> = {
    read_file: 'var(--teal)',
    list_dir: 'var(--teal)',
    search_codebase: 'var(--teal)',
    write_file: 'var(--warning)',
    edit_file: 'var(--warning)',
    run_command: 'var(--purple)',
    delete_file: 'var(--error)',
    '*': 'var(--text-dim)',
  };

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '20px 24px' }}>
      {/* Header */}
      <div style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text)', margin: 0 }}>Permit Rules</h2>
        <p style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '4px', fontFamily: 'var(--font-mono)' }}>
          Auto-approve tool calls matching these rules — no confirmation prompt
        </p>
      </div>

      {/* Rules list */}
      <div style={{ marginBottom: '20px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {permits.length === 0 && (
          <div style={{
            padding: '24px',
            textAlign: 'center',
            color: 'var(--text-dim)',
            fontFamily: 'var(--font-mono)',
            fontSize: '12px',
            background: 'var(--surface)',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--border)',
          }}>
            No permit rules configured. TRIDENT will ask before every tool call.
          </div>
        )}
        <AnimatePresence>
          {permits.map((rule) => {
            const color = riskColors[rule.toolPattern] || 'var(--text-dim)';
            return (
              <motion.div
                key={rule.id}
                layout
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '10px 14px',
                  background: 'var(--surface)',
                  border: `1px solid ${rule.enabled ? color + '44' : 'var(--border)'}`,
                  borderLeft: `3px solid ${rule.enabled ? color : 'var(--border)'}`,
                  borderRadius: 'var(--radius)',
                  opacity: rule.enabled ? 1 : 0.5,
                }}
              >
                {/* Toggle */}
                <label className="toggle" style={{ flexShrink: 0 }}>
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={() => handleToggle(rule.id)}
                  />
                  <span className="toggle-slider" />
                </label>

                {/* Content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <code style={{
                      fontSize: '12px',
                      color,
                      background: `${color}15`,
                      padding: '1px 6px',
                      borderRadius: '3px',
                      border: `1px solid ${color}30`,
                    }}>
                      {rule.toolPattern}
                    </code>
                    {rule.pathPattern && (
                      <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                        pattern: <code style={{ color: 'var(--text-muted)' }}>{rule.pathPattern}</code>
                      </span>
                    )}
                  </div>
                  {rule.description && (
                    <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '3px' }}>
                      {rule.description}
                    </div>
                  )}
                </div>

                {/* Remove */}
                <button
                  onClick={() => handleRemove(rule.id)}
                  style={{ color: 'var(--text-dim)', fontSize: '16px', flexShrink: 0 }}
                  onMouseEnter={e => (e.currentTarget.style.color = 'var(--error)')}
                  onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
                  title="Remove rule"
                >
                  ×
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {/* Add new rule */}
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
      }}>
        <button
          onClick={() => setAdding(!adding)}
          style={{
            width: '100%',
            padding: '10px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            color: 'var(--accent)',
            fontSize: '12px',
            fontFamily: 'var(--font-mono)',
            fontWeight: 700,
            textAlign: 'left',
          }}
        >
          <span>{adding ? '▼' : '▶'}</span>
          ADD PERMIT RULE
        </button>

        <AnimatePresence>
          {adding && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              style={{ overflow: 'hidden' }}
            >
              <div style={{ padding: '12px 14px 14px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div>
                  <label style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', display: 'block', marginBottom: '4px' }}>
                    Tool name (or * for any)
                  </label>
                  <input
                    value={toolInput}
                    onChange={e => setToolInput(e.target.value)}
                    placeholder="run_command"
                    list="tool-examples"
                    style={{ width: '100%' }}
                  />
                  <datalist id="tool-examples">
                    {TOOL_EXAMPLES.map(t => <option key={t} value={t} />)}
                  </datalist>
                </div>
                <div>
                  <label style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', display: 'block', marginBottom: '4px' }}>
                    Pattern (optional substring match on inputs)
                  </label>
                  <input
                    value={patternInput}
                    onChange={e => setPatternInput(e.target.value)}
                    placeholder="npm run test"
                    style={{ width: '100%' }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', display: 'block', marginBottom: '4px' }}>
                    Description (optional)
                  </label>
                  <input
                    value={descInput}
                    onChange={e => setDescInput(e.target.value)}
                    placeholder="Allow npm test commands"
                    style={{ width: '100%' }}
                  />
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <motion.button
                    onClick={handleAdd}
                    disabled={!toolInput.trim()}
                    whileHover={toolInput.trim() ? { scale: 1.02 } : {}}
                    whileTap={toolInput.trim() ? { scale: 0.98 } : {}}
                    style={{
                      flex: 1,
                      padding: '8px',
                      background: toolInput.trim() ? 'var(--accent)' : 'var(--surface2)',
                      border: '1px solid var(--accent)',
                      borderRadius: 'var(--radius)',
                      color: 'white',
                      fontSize: '12px',
                      fontWeight: 700,
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    ADD
                  </motion.button>
                  <button
                    onClick={() => setAdding(false)}
                    style={{
                      padding: '8px 16px',
                      background: 'var(--surface2)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius)',
                      color: 'var(--text-dim)',
                      fontSize: '12px',
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
