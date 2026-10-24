import { createHash } from 'crypto';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { mkdirSync, realpathSync } from 'fs';
import { readFile, readdir, writeFile } from 'fs/promises';
import type { ChatMessage } from './providers/anthropic.js';

export interface SessionState {
  cwd: string;
  savedAt: string;
  history: ChatMessage[];
  taskHistory: Array<{ task: string; summary: string; cost: number }>;
  lastTask: string | null;
  name?: string;
}

export interface SessionMetadata {
  name: string;
  savedAt: string;
  taskCount: number;
  lastTask: string | null;
}

function canonicalCwd(cwd: string): string {
  try { return realpathSync(cwd); } catch { return resolve(cwd); }
}

function workspaceKey(cwd: string): string {
  return createHash('sha256').update(canonicalCwd(cwd)).digest('hex').slice(0, 24);
}

function sessionNameKey(name: string): string {
  return createHash('sha256').update(name.trim().toLowerCase()).digest('hex').slice(0, 12);
}

export function sessionFilePath(cwd: string, name?: string): string {
  const base = workspaceKey(cwd);
  const suffix = name?.trim() ? `--${sessionNameKey(name)}` : '';
  return join(homedir(), '.trident', 'sessions', `${base}${suffix}.json`);
}

function legacySessionFilePath(): string {
  return join(homedir(), '.trident', 'sessions', 'last.json');
}

/** Persist conversation state independently for each workspace and optional name. */
export async function saveSessionState(state: SessionState, name?: string): Promise<void> {
  try {
    const dir = join(homedir(), '.trident', 'sessions');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const normalizedName = name?.trim() || state.name?.trim() || undefined;
    const stored: SessionState = { ...state, name: normalizedName };
    await writeFile(sessionFilePath(state.cwd, normalizedName), JSON.stringify(stored), { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Resume is best-effort; never fail a task over it.
  }
}

/** Load a workspace's default or named conversation. */
export async function loadSessionState(cwd: string, name?: string): Promise<SessionState | null> {
  const expected = canonicalCwd(cwd);
  const candidates = name?.trim()
    ? [sessionFilePath(cwd, name)]
    : [sessionFilePath(cwd), legacySessionFilePath()];

  for (const path of candidates) {
    try {
      const raw = await readFile(path, 'utf-8');
      const state = JSON.parse(raw) as SessionState;
      if (!state || canonicalCwd(state.cwd) !== expected || !Array.isArray(state.history)) continue;
      if (name?.trim() && (state.name || '').toLowerCase() !== name.trim().toLowerCase()) continue;
      return state;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

export async function listSessionStates(cwd: string): Promise<SessionMetadata[]> {
  const dir = join(homedir(), '.trident', 'sessions');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const expected = canonicalCwd(cwd);
  const sessions: SessionMetadata[] = [];
  for (const file of names.filter((name) => name.endsWith('.json'))) {
    try {
      const state = JSON.parse(await readFile(join(dir, file), 'utf-8')) as SessionState;
      if (!state || canonicalCwd(state.cwd) !== expected || !Array.isArray(state.taskHistory)) continue;
      sessions.push({
        name: state.name?.trim() || 'default',
        savedAt: state.savedAt || '',
        taskCount: state.taskHistory.length,
        lastTask: state.lastTask ?? null,
      });
    } catch {
      // Ignore stale/corrupt session files.
    }
  }

  return sessions.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.name.localeCompare(b.name));
}
