import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { ToolCall, ToolResult } from '../../types';
import { getRiskColor, getRiskLabel, getToolIcon, extractPreview, formatDuration } from '../../ipc';

interface ToolCardProps {
  toolCall: ToolCall;
  result?: ToolResult;
  status: 'running' | 'done' | 'error';
}

export default function ToolCard({ toolCall, result, status }: ToolCardProps) {
  const [expanded, setExpanded] = useState(false);
  const riskColor = getRiskColor(toolCall.riskLevel);
  const riskLabel = getRiskLabel(toolCall.riskLevel);
  const icon = getToolIcon(toolCall.name);
  const preview = extractPreview(toolCall.input);
  const duration = result?.durationMs;

  const statusColor =
    status === 'running' ? 'var(--warning)' :
    status === 'error' ? 'var(--error)' :
    'var(--success)';

  const statusIcon = status === 'running' ? '⟳' : status === 'error' ? '✗' : '✓';

  return (
    <motion.div
      initial={{ x: -20, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: -20, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      style={{
        background: 'var(--surface)',
        border: `1px solid ${riskColor}40`,
        borderLeft: `3px solid ${riskColor}`,
        borderRadius: 'var(--radius)',
        margin: '4px 0',
        overflow: 'hidden',
        fontSize: '12px',
        fontFamily: 'var(--font-mono)',
      }}
    >
      {/* Header Row */}
      <div
        onClick={() => status !== 'running' && setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '7px 10px',
          cursor: status !== 'running' ? 'pointer' : 'default',
          userSelect: 'none',
        }}
      >
        {/* Risk badge */}
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '18px',
            height: '18px',
            borderRadius: '3px',
            background: `${riskColor}20`,
            color: riskColor,
            fontSize: '10px',
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {riskLabel}
        </span>

        {/* Tool icon + name */}
        <span style={{ color: riskColor, flexShrink: 0 }}>{icon}</span>
        <span style={{ color: 'var(--text)', fontWeight: 600, flexShrink: 0 }}>
          {toolCall.name}
        </span>

        {/* Preview */}
        {preview && (
          <span
            style={{
              color: 'var(--text-muted)',
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            → {preview}
          </span>
        )}

        {/* Status */}
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0, marginLeft: 'auto' }}>
          {status === 'running' && (
            <motion.span
              style={{ color: statusColor, display: 'inline-block' }}
              animate={{ rotate: 360 }}
              transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
            >
              ⟳
            </motion.span>
          )}
          {status !== 'running' && (
            <motion.span
              key={status}
              initial={{ scale: 0.5 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 400, damping: 20 }}
              style={{ color: statusColor }}
            >
              {statusIcon}
            </motion.span>
          )}
          {duration && (
            <span style={{ color: 'var(--text-dim)', fontSize: '11px' }}>
              {formatDuration(duration)}
            </span>
          )}
          {status !== 'running' && (
            <span style={{ color: 'var(--text-dim)', fontSize: '10px' }}>
              {expanded ? '▲' : '▼'}
            </span>
          )}
        </span>
      </div>

      {/* Expanded Section */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            key="expanded"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div
              style={{
                padding: '8px 10px 10px',
                borderTop: '1px solid var(--border)',
              }}
            >
              {/* Input */}
              <div style={{ marginBottom: '8px' }}>
                <div style={{ color: 'var(--text-dim)', fontSize: '10px', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Input
                </div>
                <pre
                  style={{
                    background: 'var(--bg)',
                    border: '1px solid var(--border)',
                    borderRadius: '4px',
                    padding: '6px 8px',
                    fontSize: '11px',
                    overflowX: 'auto',
                    color: 'var(--text-muted)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    maxHeight: '120px',
                  }}
                >
                  {JSON.stringify(toolCall.input, null, 2)}
                </pre>
              </div>

              {/* Output */}
              {result && (
                <div>
                  <div style={{ color: 'var(--text-dim)', fontSize: '10px', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Output
                  </div>
                  <pre
                    style={{
                      background: 'var(--bg)',
                      border: `1px solid ${result.error ? 'var(--error)' : 'var(--border)'}`,
                      borderRadius: '4px',
                      padding: '6px 8px',
                      fontSize: '11px',
                      overflowX: 'auto',
                      color: result.error ? 'var(--error)' : 'var(--text-muted)',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      maxHeight: '200px',
                    }}
                  >
                    {result.error || result.output || '(empty)'}
                  </pre>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Running pulse bar */}
      {status === 'running' && (
        <motion.div
          style={{
            height: '2px',
            background: `linear-gradient(90deg, transparent, ${riskColor}, transparent)`,
          }}
          animate={{ x: ['-100%', '200%'] }}
          transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
        />
      )}
    </motion.div>
  );
}
