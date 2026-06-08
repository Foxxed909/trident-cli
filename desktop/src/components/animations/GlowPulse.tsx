import React from 'react';
import { motion } from 'framer-motion';

interface GlowPulseProps {
  children: React.ReactNode;
  active?: boolean;
  color?: string;
  intensity?: 'sm' | 'md' | 'lg';
  style?: React.CSSProperties;
  className?: string;
}

export default function GlowPulse({
  children,
  active = true,
  color = 'var(--accent)',
  intensity = 'md',
  style,
  className,
}: GlowPulseProps) {
  const sizes = {
    sm: '0 0 8px',
    md: '0 0 20px',
    lg: '0 0 40px',
  };

  const glowValue = `${sizes[intensity]} ${color}40`;
  const glowBright = `${sizes[intensity]} ${color}80`;

  return (
    <motion.div
      className={className}
      style={style}
      animate={active ? {
        boxShadow: [glowValue, glowBright, glowValue],
      } : { boxShadow: 'none' }}
      transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
    >
      {children}
    </motion.div>
  );
}
