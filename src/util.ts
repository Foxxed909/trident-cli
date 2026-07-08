import { existsSync, readFileSync, statSync } from 'fs';
import { resolveWorkspacePath } from './agent/tools.js';

const MENTION_MAX_BYTES = 48_000;

/**
 * Expand @path mentions in a task by inlining the referenced files' contents,
 * so the agent does not need extra read_file turns for context the user
 * already pointed at. Non-existent paths are left untouched.
 */
export function expandFileMentions(task: string, cwd: string): string {
  const mentions = [...task.matchAll(/@([A-Za-z0-9_][A-Za-z0-9_.\/\\-]*)/g)].map((m) => m[1]);
  const seen = new Set<string>();
  const blocks: string[] = [];

  for (const mention of mentions) {
    if (seen.has(mention)) {
      continue;
    }
    seen.add(mention);
    try {
      const abs = resolveWorkspacePath(cwd, mention);
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        continue;
      }
      const content = readFileSync(abs, 'utf-8');
      if (content.length > MENTION_MAX_BYTES) {
        blocks.push(`[@${mention} was mentioned but is larger than ${MENTION_MAX_BYTES} bytes; read it with read_file instead.]`);
      } else {
        blocks.push(`Content of @${mention}:\n\`\`\`\n${content}\n\`\`\``);
      }
    } catch {
      continue;
    }
  }

  return blocks.length > 0 ? `${task}\n\n${blocks.join('\n\n')}` : task;
}

export function formatEnvAssignment(key: string, value: string): string {
  if (process.platform === 'win32') {
    return `$env:${key}="${value}"`;
  }
  return `export ${key}=${value}`;
}

export function shellProfileHint(): string {
  if (process.platform === 'win32') {
    return 'your PowerShell profile or system environment settings';
  }
  return 'your shell profile (~/.bashrc, ~/.zshrc, etc.)';
}
