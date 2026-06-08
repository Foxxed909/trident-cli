import React, { useRef, useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore } from '../../store';
import GlowPulse from '../animations/GlowPulse';

interface InputBarProps {
  onSubmit: (text: string) => void;
  disabled?: boolean;
}

const FILE_SUGGESTIONS = [
  'src/index.ts',
  'src/agent/loop.ts',
  'src/config.ts',
  'package.json',
  'tsconfig.json',
  'README.md',
];

export default function InputBar({ onSubmit, disabled }: InputBarProps) {
  const [value, setValue] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [atQuery, setAtQuery] = useState('');
  const [hovering, setHovering] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isRunning = useStore(s => s.isRunning);
  const config = useStore(s => s.config);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }, [value]);

  // Focus on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setValue(val);

    // Detect @ references
    const atIdx = val.lastIndexOf('@');
    if (atIdx >= 0 && atIdx === val.length - 1) {
      setShowSuggestions(true);
      setAtQuery('');
    } else if (atIdx >= 0 && val.slice(atIdx).includes('@') && !val.slice(atIdx + 1).includes(' ')) {
      setAtQuery(val.slice(atIdx + 1));
      setShowSuggestions(true);
    } else {
      setShowSuggestions(false);
    }
  }, []);

  const handleSend = useCallback(() => {
    const text = value.trim();
    if (!text || isRunning) return;
    setValue('');
    setShowSuggestions(false);
    onSubmit(text);
  }, [value, isRunning, onSubmit]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !showSuggestions) {
      e.preventDefault();
      handleSend();
      return;
    }
    if (e.key === 'Escape') {
      setShowSuggestions(false);
    }
  }, [showSuggestions, handleSend]);

  const insertSuggestion = useCallback((file: string) => {
    const atIdx = value.lastIndexOf('@');
    const newVal = value.slice(0, atIdx) + `@${file} `;
    setValue(newVal);
    setShowSuggestions(false);
    textareaRef.current?.focus();
  }, [value]);

  const handleAbort = useCallback(() => {
    window.trident?.abortTask();
    useStore.getState().setRunning(false);
  }, []);

  // Drag & Drop
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    const paths = files.map(f => `@${f.name}`).join(' ');
    setValue(v => v + (v ? ' ' : '') + paths + ' ');
    textareaRef.current?.focus();
  }, []);

  const filteredSuggestions = FILE_SUGGESTIONS.filter(f =>
    f.toLowerCase().includes(atQuery.toLowerCase())
  );

  const modeColors: Record<string, string> = {
    yolo: 'var(--error)',
    review: 'var(--warning)',
    lockdown: 'var(--teal)',
  };
  const mode = config?.mode || 'review';

  return (
    <div
      style={{
        padding: '12px 16px 14px',
        borderTop: '1px solid var(--border)',
        background: 'var(--surface)',
        position: 'relative',
      }}
      onDragOver={e => e.preventDefault()}
      onDrop={handleDrop}
    >
      {/* File @ suggestions */}
      <AnimatePresence>
        {showSuggestions && filteredSuggestions.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            style={{
              position: 'absolute',
              bottom: '100%',
              left: '16px',
              right: '16px',
              marginBottom: '4px',
              background: 'var(--surface2)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              overflow: 'hidden',
              zIndex: 100,
            }}
          >
            {filteredSuggestions.map((f, i) => (
              <button
                key={i}
                onClick={() => insertSuggestion(f)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '7px 12px',
                  color: 'var(--text)',
                  fontSize: '13px',
                  fontFamily: 'var(--font-mono)',
                  borderBottom: i < filteredSuggestions.length - 1 ? '1px solid var(--border)' : 'none',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <span style={{ color: 'var(--accent)', marginRight: '6px' }}>@</span>
                {f}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Mode indicator + model pill */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <span
          style={{
            fontSize: '10px',
            fontFamily: 'var(--font-mono)',
            fontWeight: 700,
            color: modeColors[mode] || 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            background: `${modeColors[mode] || 'var(--border)'}15`,
            padding: '2px 6px',
            borderRadius: '3px',
            border: `1px solid ${modeColors[mode] || 'var(--border)'}40`,
          }}
        >
          {mode}
        </span>
        <span
          style={{
            fontSize: '11px',
            color: 'var(--text-dim)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {config?.model || 'claude-sonnet-4-6'}
        </span>
        <span style={{ color: 'var(--text-dim)', fontSize: '10px' }}>
          /
        </span>
        <span style={{ fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
          {config?.provider || 'anthropic'}
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: '10px', color: 'var(--text-dim)' }}>
          @ for files · Shift+Enter for newline
        </span>
      </div>

      {/* Input area */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: '10px',
        }}
      >
        <div
          style={{
            flex: 1,
            position: 'relative',
            borderRadius: 'var(--radius)',
            border: `1px solid ${hovering ? 'var(--accent)' : 'var(--border)'}`,
            transition: 'border-color 0.15s ease',
            boxShadow: hovering ? 'var(--glow-sm)' : 'none',
          }}
        >
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onFocus={() => setHovering(true)}
            onBlur={() => setHovering(false)}
            disabled={isRunning}
            placeholder={isRunning ? 'Task running...' : 'Describe a task for TRIDENT to execute...'}
            style={{
              display: 'block',
              width: '100%',
              minHeight: '44px',
              maxHeight: '200px',
              padding: '10px 14px',
              background: 'var(--surface2)',
              color: isRunning ? 'var(--text-dim)' : 'var(--text)',
              fontSize: '14px',
              lineHeight: '1.5',
              resize: 'none',
              border: 'none',
              borderRadius: 'var(--radius)',
              outline: 'none',
              fontFamily: 'var(--font-sans)',
              userSelect: 'text',
            }}
          />
        </div>

        {/* Send / Abort button */}
        {isRunning ? (
          <GlowPulse active color="var(--error)" intensity="md">
            <button
              onClick={handleAbort}
              style={{
                width: '44px',
                height: '44px',
                borderRadius: 'var(--radius)',
                background: 'var(--surface2)',
                border: '1px solid var(--error)',
                color: 'var(--error)',
                fontSize: '18px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
              title="Abort task (Esc)"
            >
              ■
            </button>
          </GlowPulse>
        ) : (
          <motion.button
            onClick={handleSend}
            disabled={!value.trim() || disabled}
            whileHover={value.trim() ? { scale: 1.05 } : {}}
            whileTap={value.trim() ? { scale: 0.95 } : {}}
            style={{
              width: '44px',
              height: '44px',
              borderRadius: 'var(--radius)',
              background: value.trim() ? 'var(--accent)' : 'var(--surface2)',
              border: `1px solid ${value.trim() ? 'var(--accent)' : 'var(--border)'}`,
              color: value.trim() ? 'white' : 'var(--text-dim)',
              fontSize: '18px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              transition: 'all 0.15s ease',
              boxShadow: value.trim() ? '0 0 20px rgba(220, 38, 38, 0.4)' : 'none',
            }}
            title="Send (Enter)"
          >
            ▶
          </motion.button>
        )}
      </div>
    </div>
  );
}
