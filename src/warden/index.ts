import chalk from 'chalk';
import inquirer from 'inquirer';
import { appendFile, readFile } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execa } from 'execa';
import type { ToolCall } from '../agent/tools.js';

export type ApprovalMode = 'yolo' | 'review' | 'lockdown';
export type RiskLevel = 'read' | 'write' | 'execute' | 'destructive';

export interface ActionLog {
  timestamp: string;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  result: { success: boolean; output: string; error?: string };
  approved: boolean;
  riskLevel: RiskLevel;
}

export interface PermitRule {
  tool: string;           // tool name or '*' for any
  pattern?: string;       // regex to match against the serialized input
  description?: string;   // human-readable label
}

export async function loadPermitRules(): Promise<PermitRule[]> {
  const { homedir } = await import('os');
  const { readFile } = await import('fs/promises');
  const { join } = await import('path');
  const { existsSync } = await import('fs');
  const path = join(homedir(), '.trident', 'allow.json');
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as PermitRule[];
  } catch { return []; }
}

export async function savePermitRule(rule: PermitRule): Promise<void> {
  const { homedir } = await import('os');
  const { readFile, writeFile, mkdir } = await import('fs/promises');
  const { join } = await import('path');
  const dir = join(homedir(), '.trident');
  const path = join(dir, 'allow.json');
  await mkdir(dir, { recursive: true });
  let rules: PermitRule[] = [];
  try { rules = JSON.parse(await readFile(path, 'utf-8')); } catch {}
  rules.push(rule);
  await writeFile(path, JSON.stringify(rules, null, 2), 'utf-8');
}

export function matchesPermitRule(call: ToolCall, rules: PermitRule[]): boolean {
  const inputStr = JSON.stringify(call.input);
  for (const rule of rules) {
    if (rule.tool !== '*' && rule.tool !== call.name) continue;
    if (!rule.pattern) return true;
    try {
      if (new RegExp(rule.pattern).test(inputStr)) return true;
    } catch {}
  }
  return false;
}

export function classifyRisk(call: ToolCall): RiskLevel {
  switch (call.name) {
    case 'read_file':
    case 'list_dir':
    case 'search_codebase':
    case 'web_fetch':
    case 'web_search':
    case 'git_blame':
    case 'ask_user':
    case 'final_answer':
    case 'read_notebook':
    case 'read_pdf':
    case 'read_image':
      return 'read';

    case 'write_file':
    case 'edit_file':
    case 'move_file':
    case 'memory_update':
    case 'edit_notebook_cell':
      return 'write';

    case 'github_api':
      return 'execute';

    case 'run_command': {
      const cmd = ((call.input.cmd as string) || '').trim();
      if (/(\brm\s+-rf?\b|\bdel\s+\/[sf]\b|\brmdir\b|\bformat\b|\bdrop\s+table\b|\btruncate\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\b)/i.test(cmd)) {
        return 'destructive';
      }
      return 'execute';
    }

    case 'delete_file':
      return 'destructive';

    case 'spawn_agent':
      return 'execute';

    default:
      return 'execute';
  }
}

export function getRiskColor(level: RiskLevel): string {
  switch (level) {
    case 'read': return chalk.green(level.toUpperCase());
    case 'write': return chalk.yellow(level.toUpperCase());
    case 'execute': return chalk.magenta(level.toUpperCase());
    case 'destructive': return chalk.red(level.toUpperCase());
  }
}

export function getRiskEmoji(level: RiskLevel): string {
  switch (level) {
    case 'read': return '[R]';
    case 'write': return '[W]';
    case 'execute': return '[X]';
    case 'destructive': return '[!]';
  }
}

export async function requestApproval(
  call: ToolCall,
  mode: ApprovalMode,
  risk: RiskLevel,
  permitRules?: PermitRule[]
): Promise<boolean> {
  if (mode === 'yolo') return true;

  if (permitRules && permitRules.length > 0 && matchesPermitRule(call, permitRules)) {
    console.log(chalk.dim(`  [permit] auto-approved ${call.name} (matched allow rule)`));
    return true;
  }

  if (mode === 'lockdown') {
    return promptUser(call, risk);
  }

  if (mode === 'review') {
    if (risk === 'read') {
      return true;
    }
    return promptUser(call, risk);
  }

  return true;
}

async function promptUser(call: ToolCall, risk: RiskLevel): Promise<boolean> {
  if (!process.stdin.isTTY) {
    const decision = risk !== 'destructive';
    const label = decision ? chalk.yellow('auto-approved') : chalk.red('auto-rejected');
    console.warn(`  [WARDEN] non-TTY: ${label} ${getRiskColor(risk)} ${chalk.bold(call.name)}`);
    return decision;
  }

  console.log('');
  console.log(chalk.dim('-'.repeat(60)));
  console.log(`  ${getRiskEmoji(risk)} ${getRiskColor(risk)} ${chalk.bold(call.name)}`);

  const preview = formatInputPreview(call);
  if (preview) {
    console.log(chalk.dim(preview));
  }
  console.log(chalk.dim('-'.repeat(60)));

  const { approved } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'approved',
      message: chalk.cyan('Allow this action?'),
      default: risk !== 'destructive',
    },
  ]);

  return approved;
}

function formatInputPreview(call: ToolCall): string {
  switch (call.name) {
    case 'run_command':
      return `  $ ${chalk.yellow(call.input.cmd as string)}`;
    case 'write_file':
    case 'edit_file':
    case 'delete_file':
    case 'read_file':
    case 'git_blame':
    case 'read_notebook':
    case 'edit_notebook_cell':
    case 'read_pdf':
    case 'read_image':
      return `  file ${chalk.cyan(call.input.path as string)}`;
    case 'move_file':
      return `  ${chalk.cyan(call.input.source as string)} → ${chalk.cyan(call.input.destination as string)}`;
    case 'memory_update':
      return `  fact: ${chalk.cyan(String(call.input.fact || '').slice(0, 60))}`;
    case 'web_search':
      return `  query: ${chalk.cyan(String(call.input.query || '').slice(0, 60))}`;
    case 'github_api':
      return `  ${call.input.method || 'GET'} ${chalk.cyan(String(call.input.endpoint || call.input.path || '').slice(0, 60))}`;
    case 'spawn_agent':
      return `  task: ${chalk.cyan((call.input.task as string || '').slice(0, 80))}`;
    default:
      return '';
  }
}

export class SessionLogger {
  private logPath: string;
  private sessionId: string;
  private enabled: boolean;

  constructor(sessionId: string, enabled = true) {
    this.sessionId = sessionId;
    this.enabled = enabled;
    const logDir = join(homedir(), '.trident', 'logs');
    this.logPath = join(logDir, `${sessionId}.jsonl`);

    if (!this.enabled) {
      return;
    }

    if (!existsSync(logDir)) {
      try {
        mkdirSync(logDir, { recursive: true });
      } catch {
        // Logging is non-fatal.
      }
    }
  }

  async log(entry: Omit<ActionLog, 'timestamp' | 'sessionId'>): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const full: ActionLog = {
      ...entry,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
    };

    try {
      await appendFile(this.logPath, JSON.stringify(full) + '\n', 'utf-8');
    } catch {
      // Logging is non-fatal.
    }
  }
}

export interface HooksConfig {
  before_tool?: Record<string, string>; // toolName -> shell command
  after_tool?: Record<string, string>;  // toolName -> shell command
  on_task_start?: string;  // shell command run at start of each task
  on_task_end?: string;    // shell command run at end of each task
}

export async function loadHooks(cwd: string): Promise<HooksConfig> {
  const hooksPath = join(cwd, '.trident', 'hooks.json');
  if (!existsSync(hooksPath)) return {};
  try {
    const content = await readFile(hooksPath, 'utf-8');
    return JSON.parse(content) as HooksConfig;
  } catch { return {}; }
}

export async function runHook(cmd: string, cwd: string): Promise<void> {
  if (!cmd) return;
  const isWindows = process.platform === 'win32';
  try {
    await execa(isWindows ? 'cmd' : 'bash', [isWindows ? '/c' : '-c', cmd], { cwd, timeout: 10000, reject: false });
  } catch {}
}
