import chalk from 'chalk';
import inquirer from 'inquirer';
import { appendFile } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { ToolCall } from '../agent/tools.js';
import { getRawConfig, setConfig } from '../config.js';

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
  // MCP tools run external code with unknown side effects; treat as execute
  // so review mode always asks.
  if (call.name.startsWith('mcp__')) {
    return 'execute';
  }

  switch (call.name) {
    case 'read_file':
    case 'list_dir':
    case 'search_codebase':
    case 'ask_user':
    case 'final_answer':
      return 'read';

    // web_fetch sends data to arbitrary URLs (exfiltration/SSRF channel), so it
    // must not be auto-approved in review mode.
    case 'web_fetch':
      return 'execute';

    case 'write_file':
    case 'edit_file':
      return 'write';

    case 'run_command': {
      const cmd = ((call.input.cmd as string) || '').trim();
      const destructivePatterns = [
        /\brm\s+(-\w+\s+)*-\w*[rf]/i,          // rm -rf, rm -fr, rm -r -f, sudo rm -rf via word boundary
        /\brm\s+--(recursive|force)\b/i,
        /\bdel\s+\/[sf]\b/i,
        /\brmdir\b/i,
        /\bformat\b/i,
        /\bmkfs\b/i,
        /\bdd\s+\S*of=/i,
        /\bdrop\s+table\b/i,
        /\btruncate\b/i,
        /\bgit\s+reset\s+--hard\b/i,
        /\bgit\s+clean\b/i,
        /\bgit\s+push\s+.*--force\b/i,
        /\bshutdown\b|\breboot\b/i,
      ];
      if (destructivePatterns.some((p) => p.test(cmd))) {
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

const SHELL_CONTROL_RE = /(?:&&|\|\||[;|<>`]|\$\(|\r|\n)/;

function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, ' ');
}

function canPersistCommand(cmd: string): boolean {
  return cmd.length > 0 && !SHELL_CONTROL_RE.test(cmd);
}

/**
 * Persistent approvals are exact-command matches only. Compound commands with
 * shell control operators are never eligible for persistent auto-approval.
 */
export function commandMatchesAllowlist(cmd: string, allowlist: string[]): boolean {
  const normalized = normalizeCommand(cmd);
  if (!canPersistCommand(normalized)) return false;
  return allowlist.some((rule) => normalizeCommand(rule) === normalized);
}

function getAllowedCommands(): string[] {
  const raw = getRawConfig().allowedCommands;
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

/** Persist the exact normalized command, never a broad prefix. */
function allowlistRuleFor(cmd: string): string {
  return normalizeCommand(cmd);
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
    if (
      call.name === 'run_command' &&
      risk !== 'destructive' &&
      commandMatchesAllowlist((call.input.cmd as string) || '', getAllowedCommands())
    ) {
      return true;
    }
    return promptUser(call, risk);
  }

  return true;
}

async function promptUser(call: ToolCall, risk: RiskLevel): Promise<boolean> {
  if (!process.stdin.isTTY) {
    // Without a terminal nobody can approve, so deny rather than assume
    // consent. Piped/CI usage should opt in explicitly with --mode yolo.
    return false;
  }

  console.log('');
  console.log(chalk.dim('-'.repeat(60)));
  console.log(`  ${getRiskEmoji(risk)} ${getRiskColor(risk)} ${chalk.bold(call.name)}`);

  const preview = formatInputPreview(call);
  if (preview) {
    console.log(chalk.dim(preview));
  }
  console.log(chalk.dim('-'.repeat(60)));

  if (call.name === 'run_command' && risk !== 'destructive') {
    const rule = allowlistRuleFor((call.input.cmd as string) || '');
    const choices = [
      { name: 'Yes, once', value: 'yes' },
      ...(canPersistCommand(rule)
        ? [{ name: `Yes, and always allow exactly "${rule}"`, value: 'always' }]
        : []),
      { name: 'No', value: 'no' },
    ];
    const { choice } = await inquirer.prompt([
      {
        type: 'list',
        name: 'choice',
        message: chalk.cyan('Allow this command?'),
        choices,
        default: 'yes',
      },
    ]);

    if (choice === 'always') {
      const allowed = getAllowedCommands();
      if (!allowed.includes(rule)) {
        setConfig('allowedCommands', [...allowed, rule]);
      }
      console.log(chalk.dim(`  Saved: "${rule}" is now auto-approved in review mode.`));
    }
    return choice !== 'no';
  }

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

const SENSITIVE_KEY_RE = /(api[-_]?key|token|secret|password|authorization|cookie|credential)/i;
const SECRET_TEXT_PATTERNS: RegExp[] = [
  /\bsk-(?:ant-|or-)?[A-Za-z0-9._-]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
];

function redactText(text: string): string {
  let out = text;
  for (const pattern of SECRET_TEXT_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out;
}

function sanitizeLogValue(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY_RE.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactText(value).slice(0, 4000);
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => sanitizeLogValue(v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeLogValue(v, k)])
    );
  }
  return value;
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
        mkdirSync(logDir, { recursive: true, mode: 0o700 });
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
      input: sanitizeLogValue(entry.input) as Record<string, unknown>,
      result: {
        ...entry.result,
        output: redactText(entry.result.output || '').slice(0, 4000),
        error: entry.result.error ? redactText(entry.result.error).slice(0, 1000) : undefined,
      },
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
    };

    try {
      await appendFile(this.logPath, JSON.stringify(full) + '\n', { encoding: 'utf-8', mode: 0o600 });
    } catch {
      // Logging is non-fatal.
    }
  }
}
