import React, { useState } from 'react';
import { motion } from 'framer-motion';
import type { Message, MessageContent } from '../../types';
import StreamingText from './StreamingText';
import ToolCard from './ToolCard';

interface MessageBubbleProps {
  message: Message;
  fontSize: number;
}

function ThinkingBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        margin: '4px 0',
        overflow: 'hidden',
        fontSize: '12px',
      }}
    >
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          width: '100%',
          padding: '7px 10px',
          background: 'none',
          cursor: 'pointer',
          color: 'var(--text-dim)',
          fontSize: '11px',
        }}
      >
        <span style={{ color: 'var(--purple)' }}>◈</span>
        <span style={{ fontStyle: 'italic' }}>Extended Thinking</span>
        <span style={{ marginLeft: 'auto' }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div
          style={{
            padding: '8px 10px',
            borderTop: '1px solid var(--border)',
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
            fontSize: '12px',
            whiteSpace: 'pre-wrap',
            maxHeight: '300px',
            overflowY: 'auto',
          }}
        >
          {content}
        </div>
      )}
    </div>
  );
}

function renderContentBlock(block: MessageContent, idx: number) {
  if (block.type === 'text') {
    return (
      <StreamingText
        key={idx}
        text={block.text}
        streaming={false}
        style={{ lineHeight: '1.6' }}
      />
    );
  }
  if (block.type === 'tool_call') {
    return (
      <ToolCard
        key={block.toolCall.id}
        toolCall={block.toolCall}
        result={block.result}
        status={block.status}
      />
    );
  }
  if (block.type === 'thinking') {
    return <ThinkingBlock key={idx} content={block.content} />;
  }
  return null;
}

export default function MessageBubble({ message, fontSize }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const streaming = message.streaming;

  // Get the last text block for streaming cursor
  const lastTextBlock = isUser ? null :
    [...message.content].reverse().find(c => c.type === 'text');
  const isStreamingText = streaming && lastTextBlock?.type === 'text';

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start',
        padding: '4px 0',
      }}
    >
      {/* Role label */}
      <div
        style={{
          fontSize: '10px',
          color: 'var(--text-dim)',
          marginBottom: '4px',
          paddingLeft: isUser ? 0 : '4px',
          paddingRight: isUser ? '4px' : 0,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          fontFamily: 'var(--font-mono)',
        }}
      >
        {isUser ? 'YOU' : 'TRIDENT'}
      </div>

      {isUser ? (
        /* User bubble */
        <div
          style={{
            background: 'linear-gradient(135deg, var(--accent-dark) 0%, #3D0A0A 100%)',
            border: '1px solid var(--accent)',
            borderRadius: '12px 12px 4px 12px',
            padding: '10px 14px',
            maxWidth: '80%',
            fontSize: `${fontSize}px`,
            lineHeight: '1.6',
            color: 'var(--text)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            userSelect: 'text',
            boxShadow: '0 0 20px rgba(220, 38, 38, 0.15)',
          }}
        >
          {message.content.map((block, i) => {
            if (block.type === 'text') return <span key={i}>{block.text}</span>;
            return null;
          })}
        </div>
      ) : (
        /* Assistant bubble */
        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderLeft: streaming ? '3px solid var(--accent)' : '3px solid var(--border)',
            borderRadius: '4px 12px 12px 12px',
            padding: '10px 14px',
            maxWidth: '95%',
            width: '95%',
            fontSize: `${fontSize}px`,
            lineHeight: '1.6',
            transition: 'border-left-color 0.3s ease',
          }}
        >
          {message.content.map((block, i) => {
            if (block.type === 'text' && isStreamingText && block === lastTextBlock) {
              return (
                <StreamingText
                  key={i}
                  text={block.text}
                  streaming={true}
                  style={{ lineHeight: '1.6' }}
                />
              );
            }
            return renderContentBlock(block, i);
          })}
        </div>
      )}

      {/* Timestamp */}
      <div
        style={{
          fontSize: '10px',
          color: 'var(--text-dim)',
          marginTop: '3px',
          paddingLeft: isUser ? 0 : '4px',
          paddingRight: isUser ? '4px' : 0,
        }}
      >
        {new Date(message.timestamp).toLocaleTimeString()}
      </div>
    </motion.div>
  );
}
