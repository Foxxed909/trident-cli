import React, { useEffect, useState } from 'react';

interface TypeWriterProps {
  text: string;
  speed?: number;
  onComplete?: () => void;
  className?: string;
  style?: React.CSSProperties;
}

export default function TypeWriter({
  text,
  speed = 30,
  onComplete,
  className,
  style,
}: TypeWriterProps) {
  const [displayed, setDisplayed] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    setDisplayed('');
    setDone(false);
    let i = 0;
    const interval = setInterval(() => {
      if (i >= text.length) {
        clearInterval(interval);
        setDone(true);
        onComplete?.();
        return;
      }
      setDisplayed(text.slice(0, i + 1));
      i++;
    }, speed);
    return () => clearInterval(interval);
  }, [text, speed]);

  return (
    <span className={className} style={style}>
      {displayed}
      {!done && (
        <span
          style={{
            display: 'inline-block',
            width: '2px',
            height: '1em',
            background: 'var(--accent)',
            marginLeft: '2px',
            verticalAlign: 'text-bottom',
            animation: 'cursor-blink 1s step-end infinite',
          }}
        />
      )}
    </span>
  );
}
