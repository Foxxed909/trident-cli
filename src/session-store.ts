import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import type { ChatMessage } from './providers/anthropic.js';

export interface SessionState {
  cwd: string;
  savedAt: string;
  history: ChatMessage[];
  taskHistory: Array<{ task: string; summary: string; cost: number }>;
  lastTask: string | null;
}

function sessionFilePath(): string {
  return join(homedir(), '.trident', 'sessions', 'last.json');
}

/** Persist the current conversation so `trident --continue` can resume it. */
export async function saveSessionState(state: SessionState): Promise<void> {
  try {
    mkdirSync(join(homedir(), '.trident', 'sessions'), { recursive: true });
    await writeFile(sessionFilePath(), JSON.stringify(state), 'utf-8');
  } catch {
    // Resume is best-effort; never fail a task over it.
  }
}

/** Load the previous conversation for this directory, or null if none/other dir. */
export async function loadSessionState(cwd: string): Promise<SessionState | null> {
  try {
    const raw = await readFile(sessionFilePath(), 'utf-8');
    const state = JSON.parse(raw) as SessionState;
    if (!state || state.cwd !== cwd || !Array.isArray(state.history)) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}
