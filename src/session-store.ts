import { createHash } from 'crypto';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { mkdirSync, realpathSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import type { ChatMessage } from './providers/anthropic.js';

export interface SessionState {
  cwd: string;
  savedAt: string;
  history: ChatMessage[];
  taskHistory: Array<{ task: string; summary: string; cost: number }>;
  lastTask: string | null;
}

function canonicalCwd(cwd: string): string {
  try { return realpathSync(cwd); } catch { return resolve(cwd); }
}

export function sessionFilePath(cwd: string): string {
  const key = createHash('sha256').update(canonicalCwd(cwd)).digest('hex').slice(0, 24);
  return join(homedir(), '.trident', 'sessions', `${key}.json`);
}

function legacySessionFilePath(): string {
  return join(homedir(), '.trident', 'sessions', 'last.json');
}

/** Persist conversation state independently for each workspace. */
export async function saveSessionState(state: SessionState): Promise<void> {
  try {
    const dir = join(homedir(), '.trident', 'sessions');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    await writeFile(sessionFilePath(state.cwd), JSON.stringify(state), { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Resume is best-effort; never fail a task over it.
  }
}

/** Load this workspace's previous conversation, with legacy fallback. */
export async function loadSessionState(cwd: string): Promise<SessionState | null> {
  const expected = canonicalCwd(cwd);
  for (const path of [sessionFilePath(cwd), legacySessionFilePath()]) {
    try {
      const raw = await readFile(path, 'utf-8');
      const state = JSON.parse(raw) as SessionState;
      if (!state || canonicalCwd(state.cwd) !== expected || !Array.isArray(state.history)) continue;
      return state;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}
