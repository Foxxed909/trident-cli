// IPC helpers for the renderer process

export function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function formatCost(cost: number): string {
  if (cost < 0.001) return `$${(cost * 1000).toFixed(3)}m`;
  return `$${cost.toFixed(4)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatDate(ts: number | string): string {
  const d = new Date(ts);
  return d.toLocaleString();
}

export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}

export function getRiskColor(risk?: string): string {
  switch (risk) {
    case 'read': return 'var(--teal)';
    case 'write': return 'var(--warning)';
    case 'execute': return '#A855F7';
    case 'destructive': return 'var(--error)';
    default: return 'var(--text-muted)';
  }
}

export function getRiskLabel(risk?: string): string {
  switch (risk) {
    case 'read': return 'R';
    case 'write': return 'W';
    case 'execute': return 'X';
    case 'destructive': return '!';
    default: return '?';
  }
}

export function getToolIcon(toolName: string): string {
  const name = toolName.toLowerCase();
  if (name.includes('read') || name.includes('list') || name.includes('search')) return '◎';
  if (name.includes('write') || name.includes('edit') || name.includes('create')) return '✎';
  if (name.includes('exec') || name.includes('run') || name.includes('bash')) return '▶';
  if (name.includes('delete') || name.includes('remove')) return '✗';
  if (name.includes('git')) return '⎇';
  return '◆';
}

export function extractPreview(input: Record<string, unknown>): string {
  // Try common key names
  for (const key of ['path', 'file_path', 'command', 'query', 'pattern', 'url', 'content']) {
    if (input[key] && typeof input[key] === 'string') {
      return truncate(input[key] as string, 80);
    }
  }
  try {
    return truncate(JSON.stringify(input), 80);
  } catch {
    return '';
  }
}
