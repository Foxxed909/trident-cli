import React from 'react';
import { useStore } from '../../store';

interface StreamingTextProps {
  text: string;
  streaming?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

// Simple markdown-ish renderer
function renderMarkdown(text: string, wordWrap: boolean): React.ReactNode[] {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      elements.push(
        <pre
          key={key++}
          style={{
            background: 'var(--surface2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: '12px 16px',
            overflowX: 'auto',
            fontFamily: 'var(--font-mono)',
            fontSize: '13px',
            lineHeight: '1.6',
            margin: '8px 0',
            whiteSpace: wordWrap ? 'pre-wrap' : 'pre',
          }}
        >
          {lang && (
            <div style={{ color: 'var(--text-dim)', fontSize: '11px', marginBottom: '6px' }}>
              {lang}
            </div>
          )}
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      i++;
      continue;
    }

    // Heading
    const headMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headMatch) {
      const level = headMatch[1].length;
      const fontSize = level === 1 ? '1.3em' : level === 2 ? '1.15em' : '1em';
      elements.push(
        <div
          key={key++}
          style={{
            fontSize,
            fontWeight: 700,
            color: 'var(--text)',
            margin: '12px 0 4px',
            borderBottom: level === 1 ? '1px solid var(--border)' : 'none',
            paddingBottom: level === 1 ? '6px' : 0,
          }}
        >
          {renderInline(headMatch[2])}
        </div>
      );
      i++;
      continue;
    }

    // Horizontal rule
    if (line.match(/^---+$/)) {
      elements.push(
        <hr key={key++} style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '12px 0' }} />
      );
      i++;
      continue;
    }

    // List item
    if (line.match(/^[-*+]\s+/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^[-*+]\s+/)) {
        items.push(lines[i].replace(/^[-*+]\s+/, ''));
        i++;
      }
      elements.push(
        <ul key={key++} style={{ paddingLeft: '20px', margin: '6px 0' }}>
          {items.map((item, idx) => (
            <li key={idx} style={{ margin: '2px 0', color: 'var(--text)' }}>
              {renderInline(item)}
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // Numbered list
    if (line.match(/^\d+\.\s+/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^\d+\.\s+/)) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i++;
      }
      elements.push(
        <ol key={key++} style={{ paddingLeft: '20px', margin: '6px 0' }}>
          {items.map((item, idx) => (
            <li key={idx} style={{ margin: '2px 0', color: 'var(--text)' }}>
              {renderInline(item)}
            </li>
          ))}
        </ol>
      );
      continue;
    }

    // Empty line
    if (!line.trim()) {
      elements.push(<div key={key++} style={{ height: '6px' }} />);
      i++;
      continue;
    }

    // Paragraph
    elements.push(
      <p key={key++} style={{ margin: '3px 0', lineHeight: '1.6' }}>
        {renderInline(line)}
      </p>
    );
    i++;
  }

  return elements;
}

function renderInline(text: string): React.ReactNode {
  // Handle bold, italic, code
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Bold
    const boldMatch = remaining.match(/^(.*?)\*\*(.+?)\*\*(.*)/s);
    if (boldMatch && boldMatch[1] !== undefined) {
      if (boldMatch[1]) parts.push(<span key={key++}>{boldMatch[1]}</span>);
      parts.push(<strong key={key++} style={{ color: 'var(--text)', fontWeight: 700 }}>{boldMatch[2]}</strong>);
      remaining = boldMatch[3];
      continue;
    }

    // Inline code
    const codeMatch = remaining.match(/^(.*?)`(.+?)`(.*)/s);
    if (codeMatch && codeMatch[1] !== undefined) {
      if (codeMatch[1]) parts.push(<span key={key++}>{codeMatch[1]}</span>);
      parts.push(
        <code
          key={key++}
          style={{
            background: 'var(--surface2)',
            border: '1px solid var(--border)',
            borderRadius: '3px',
            padding: '1px 5px',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.875em',
            color: 'var(--teal)',
          }}
        >
          {codeMatch[2]}
        </code>
      );
      remaining = codeMatch[3];
      continue;
    }

    parts.push(<span key={key++}>{remaining}</span>);
    break;
  }

  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

export default function StreamingText({ text, streaming = false, className, style }: StreamingTextProps) {
  const wordWrap = useStore(s => s.wordWrap);
  const rendered = renderMarkdown(text || '', wordWrap);

  return (
    <div
      className={`selectable ${className || ''}`}
      style={{ ...style }}
    >
      {rendered}
      {streaming && (
        <span
          style={{
            display: 'inline-block',
            width: '8px',
            height: '14px',
            background: 'var(--accent)',
            marginLeft: '2px',
            verticalAlign: 'text-bottom',
            animation: 'cursor-blink 0.8s step-end infinite',
            borderRadius: '1px',
          }}
        />
      )}
    </div>
  );
}
