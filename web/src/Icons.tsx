import type { Risk } from './types';

export function TridentMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="tri-g" x1="0" y1="0" x2="32" y2="32">
          <stop offset="0" stopColor="oklch(0.85 0.13 178)" />
          <stop offset="1" stopColor="oklch(0.80 0.09 230)" />
        </linearGradient>
      </defs>
      <path
        d="M16 3v26M16 29l-3.5-3M16 29l3.5-3M6 8v4a10 10 0 0 0 6 9.2M26 8v4a10 10 0 0 1-6 9.2M6 8l-2.4 1.6M6 8l2.4 1.6M26 8l2.4 1.6M26 8l-2.4 1.6M16 3l-2.2 2.2M16 3l2.2 2.2"
        stroke="url(#tri-g)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (name) {
    case 'chat': return <svg {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>;
    case 'plug': return <svg {...p}><path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5" /></svg>;
    case 'send': return <svg {...p}><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" /></svg>;
    case 'menu': return <svg {...p}><path d="M3 12h18M3 6h18M3 18h18" /></svg>;
    case 'read': return <svg {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>;
    case 'write': return <svg {...p}><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>;
    case 'exec': return <svg {...p}><path d="m4 17 6-6-6-6M12 19h8" /></svg>;
    case 'trash': return <svg {...p}><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>;
    case 'search': return <svg {...p}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>;
    case 'globe': return <svg {...p}><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z" /></svg>;
    case 'flag': return <svg {...p}><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7" /></svg>;
    default: return <svg {...p}><circle cx="12" cy="12" r="9" /></svg>;
  }
}

export function toolIconName(tool: string): string {
  if (tool.startsWith('mcp__')) return 'plug';
  if (tool === 'read_file' || tool === 'list_dir') return 'read';
  if (tool === 'search_codebase') return 'search';
  if (tool === 'write_file' || tool === 'edit_file') return 'write';
  if (tool === 'delete_file') return 'trash';
  if (tool === 'run_command') return 'exec';
  if (tool === 'web_fetch') return 'globe';
  if (tool === 'final_answer') return 'flag';
  return 'chat';
}

export function riskIconName(risk: Risk): string {
  return risk === 'read' ? 'read' : risk === 'write' ? 'write' : risk === 'destructive' ? 'trash' : 'exec';
}
