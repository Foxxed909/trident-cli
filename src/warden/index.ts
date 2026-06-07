import chalk from 'chalk';
import inquirer from 'inquirer';
import { appendFile } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
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

export function classifyRisk(call: ToolCall): RiskLevel {
  switch (call.name) {
    case 'read_file':
    case 'list_dir':
    case 'search_codebase':
    case 'web_fetch':
    case 'ask_user':
    case 'final_answer':
      return 'read';

    case 'write_file':
    case 'edit_file':
      return 'write';

    case 'run_command': {
      const cmd = ((call.input.cmd as string) || '').trim();
      if (/(\brm\s+-rf?\b|\bdel\s+\/[sf]\b|\brmdir\b|\bformat\b|\bdrop\s+table\b|\btruncate\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\b)/i.test(cmd)) {
        return 'destructive';
      }
      return 'execute';
    }

    case 'delete_file':
      return 'destructive';

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
  risk: RiskLevel
): Promise<boolean> {
  if (mode === 'yolo') {
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
    return risk !== 'destructive';
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
      return `  file ${chalk.cyan(call.input.path as string)}`;
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
