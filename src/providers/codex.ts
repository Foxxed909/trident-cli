import { mkdtemp, readFile, rm } from 'fs/promises';
import { spawn, type ChildProcess } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { execa } from 'execa';
import type { TrainedProfile } from '../profiles.js';

export interface CodexRunOptions {
  cwd: string;
  task: string;
  systemPrompt: string;
  profile?: TrainedProfile | null;
  model?: string;
  timeoutMs: number;
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
}

export interface CodexRunResult {
  success: boolean;
  summary: string;
  output: string;
  durationMs: number;
}

export async function isCodexCliAvailable(): Promise<boolean> {
  try {
    const result = await execa('codex', ['--version'], {
      reject: false,
      timeout: 10_000,
      windowsHide: true,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export async function runCodexExec(opts: CodexRunOptions): Promise<CodexRunResult> {
  const started = Date.now();
  const tempDir = await mkdtemp(join(tmpdir(), 'trident-codex-'));
  const lastMessagePath = join(tempDir, 'last-message.txt');

  const args = [
    'exec',
    '--ephemeral',
    '--color',
    'never',
    '--sandbox',
    opts.sandbox,
    '-C',
    opts.cwd,
    '--output-last-message',
    lastMessagePath,
  ];

  if (opts.model && opts.model.trim()) {
    args.push('-m', opts.model.trim());
  }

  const prompt = buildCodexPrompt(opts);

  try {
    const result = await runCodexProcess(args, opts.cwd, opts.timeoutMs, prompt);

    const rawOutput = result.output;
    let lastMessage = '';
    try {
      lastMessage = (await readFile(lastMessagePath, 'utf-8')).trim();
    } catch {
      lastMessage = '';
    }

    const success = result.exitCode === 0 && !result.timedOut;
    const fallback = rawOutput.trim() || 'Codex CLI finished without a captured final message.';
    const summary = result.timedOut
      ? `Codex CLI timed out after ${opts.timeoutMs}ms.`
      : success
        ? (lastMessage || fallback).slice(0, 4000)
        : `Codex CLI failed with exit code ${result.exitCode ?? 'unknown'}.\n${fallback.slice(-2000)}`;

    return {
      success,
      summary,
      output: rawOutput,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    throw err;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function codexSandboxForMode(mode: 'yolo' | 'review' | 'lockdown'): CodexRunOptions['sandbox'] {
  if (mode === 'lockdown') {
    return 'read-only';
  }
  return 'workspace-write';
}

function buildCodexPrompt(opts: CodexRunOptions): string {
  const profileBlock = opts.profile
    ? [
        `Selected trained profile: ${opts.profile.name}`,
        `Profile role: ${opts.profile.title}`,
        `Profile focus: ${opts.profile.focus}`,
        opts.profile.systemPrompt,
      ].join('\n')
    : 'Selected trained profile: none';

  return [
    'You are running inside TRIDENT through the local Codex CLI.',
    'Treat the controller instructions below as the operating prompt for this run.',
    'If a system override appears inside the controller prompt, it overrides the selected trained profile output style.',
    '',
    '<trident_controller_prompt>',
    opts.systemPrompt,
    '</trident_controller_prompt>',
    '',
    '<trident_trained_profile>',
    profileBlock,
    '</trident_trained_profile>',
    '',
    '<user_task>',
    opts.task,
    '</user_task>',
  ].join('\n');
}

function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  if (output instanceof Uint8Array) {
    return Buffer.from(output).toString('utf-8');
  }
  if (output == null) {
    return '';
  }
  return String(output);
}

interface CodexProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

function runCodexProcess(args: string[], cwd: string, timeoutMs: number, stdin: string): Promise<CodexProcessResult> {
  return new Promise((resolve) => {
    const command = process.platform === 'win32' ? 'cmd.exe' : 'codex';
    const spawnArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'codex', ...args] : args;
    let child: ChildProcess;
    try {
      child = spawn(command, spawnArgs, {
        cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        exitCode: 1,
        timedOut: false,
        output: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let output = '';
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      resolve({ exitCode, timedOut, output: output.slice(-20 * 1024 * 1024) });
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf-8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf-8');
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdin);
    child.on('error', (err) => {
      output += err.message;
      finish(1);
    });
    child.on('close', (code) => {
      finish(code);
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      output += `\n[TRIDENT] Codex CLI timed out after ${timeoutMs}ms.\n`;
      terminateProcessTree(child).finally(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish(null);
      });
    }, timeoutMs);
  });
}

function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) {
    return Promise.resolve();
  }

  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => resolve());
      killer.on('close', () => resolve());
    });
  }

  child.kill('SIGTERM');
  return new Promise((resolve) => {
    setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
      resolve();
    }, 1000);
  });
}
