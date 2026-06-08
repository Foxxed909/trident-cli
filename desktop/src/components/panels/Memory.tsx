import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useStore } from '../../store';

export default function Memory() {
  const memory = useStore(s => s.memory);
  const setMemory = useStore(s => s.setMemory);
  const [value, setValue] = useState(memory);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    window.trident?.getMemory().then(m => {
      setValue(m);
      setMemory(m);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await window.trident?.setMemory(value);
      setMemory(value);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const lineCount = value.split('\n').length;
  const charCount = value.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '20px 24px 16px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
        <div>
          <h2 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text)', margin: 0 }}>Memory / TRIDENT.md</h2>
          <p style={{ fontSize: '11px', color: 'var(--text-dim)', margin: '4px 0 0', fontFamily: 'var(--font-mono)' }}>
            Project-level AI context and instructions
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
            {lineCount} lines · {charCount} chars
          </span>
          <motion.button
            onClick={save}
            disabled={saving}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            style={{
              padding: '6px 16px',
              background: saved ? 'var(--success)' : 'var(--accent)',
              border: 'none',
              borderRadius: 'var(--radius)',
              color: 'white',
              fontSize: '12px',
              fontWeight: 700,
              fontFamily: 'var(--font-mono)',
              boxShadow: saved ? '0 0 12px rgba(16, 185, 129, 0.4)' : '0 0 12px rgba(220, 38, 38, 0.3)',
              transition: 'all 0.3s ease',
            }}
          >
            {saving ? '...' : saved ? '✓ Saved' : 'Save'}
          </motion.button>
        </div>
      </div>

      {/* Tips */}
      <div style={{
        display: 'flex',
        gap: '16px',
        marginBottom: '12px',
        padding: '8px 12px',
        background: 'var(--surface)',
        borderRadius: 'var(--radius)',
        border: '1px solid var(--border)',
        fontSize: '11px',
        color: 'var(--text-dim)',
        fontFamily: 'var(--font-mono)',
      }}>
        <span><span style={{ color: 'var(--accent)' }}>##</span> Project context</span>
        <span><span style={{ color: 'var(--accent)' }}>##</span> Do Not Touch</span>
        <span><span style={{ color: 'var(--accent)' }}>##</span> Context for AI</span>
        <span style={{ marginLeft: 'auto', color: 'var(--text-dim)' }}>Loaded into every session's system prompt</span>
      </div>

      {/* Editor */}
      {loading ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)' }}>
          Loading...
        </div>
      ) : (
        <textarea
          value={value}
          onChange={e => setValue(e.target.value)}
          spellCheck={false}
          style={{
            flex: 1,
            resize: 'none',
            background: 'var(--surface2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--text)',
            fontFamily: 'var(--font-mono)',
            fontSize: '13px',
            lineHeight: '1.6',
            padding: '12px 16px',
            outline: 'none',
            userSelect: 'text',
            transition: 'border-color 0.15s ease',
          }}
          onFocus={e => (e.target.style.borderColor = 'var(--accent)')}
          onBlur={e => (e.target.style.borderColor = 'var(--border)')}
          placeholder={'# TRIDENT.md\n\n## Project Context\nDescribe your project here...\n\n## Do Not Touch\n(paths TRIDENT should never modify)\n\n## Context for AI\n(conventions, rules, patterns)'}
        />
      )}

      {/* Keyboard hint */}
      <div style={{ marginTop: '8px', fontSize: '10px', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
        Changes take effect on the next session
      </div>
    </div>
  );
}
