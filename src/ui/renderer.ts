import chalk from 'chalk';
import figures from 'figures';
import type { ToolCall, ToolResult } from '../agent/tools.js';
import type { RiskLevel } from '../warden/index.js';
import { classifyRisk } from '../warden/index.js';
import { SLASH_COMMAND_GROUPS } from './commands.js';

const TEAL = '#5EEAD4';
const AMBER = '#F5C97A';
const ROSE = '#F87171';
const SLATE = '#94A3B8';
const SEA = '#7DD3FC';

const BOX_TL = '+';
const BOX_TR = '+';
const BOX_BL = '+';
const BOX_BR = '+';
const BOX_H = '-';
const BOX_V = '|';

let lastToolStartLines = 0;
let agentTextPrinted = false;

function termWidth(): number {
  return Math.max(60, Math.min(process.stdout.columns || 100, 120));
}

export function printLogo(): void {
  const w = termWidth();
  const banner = [
    'TTTTTT  RRRR   III  DDDD   EEEEE  N   N  TTTTT',
    '  TT    R   R   I   D   D  E      NN  N    T  ',
    '  TT    RRRR    I   D   D  EEE    N N N    T  ',
    '  TT    R  R    I   D   D  E      N  NN    T  ',
    '  TT    R   R  III  DDDD   EEEEE  N   N    T  ',
  ];

  console.log('');
  for (let i = 0; i < banner.length; i++) {
    const color = i < banner.length / 2 ? TEAL : AMBER;
    console.log('  ' + chalk.hex(color).bold(banner[i]));
  }
  console.log('');
  console.log('  ' + chalk.hex(TEAL)('TRIDENT  ') + chalk.hex(SLATE)('Three Prongs. One Power. ') + chalk.hex(AMBER)('All Yours.'));
  console.log('  ' + chalk.hex(SLATE).dim('-'.repeat(Math.min(w - 4, 56))));
  console.log('');
}

export function printSessionHeader(opts: {
  model: string;
  mode: string;
  provider: string;
  project: string;
  hasTridentMd: boolean;
  profile?: string;
}): void {
  const w = termWidth();
  const modeColor =
    opts.mode === 'yolo' ? chalk.hex(ROSE) :
    opts.mode === 'lockdown' ? chalk.hex(AMBER) :
    chalk.hex(TEAL);

  const providerLabel = opts.provider === 'openrouter'
    ? chalk.hex(AMBER)(opts.provider)
    : chalk.hex(TEAL)(opts.provider);

  const lines = [
    `${chalk.hex(SLATE)('project')}  ${chalk.white(opts.project)}`,
    `${chalk.hex(SLATE)('model  ')}  ${chalk.white(opts.model)} ${chalk.hex(SLATE)('via')} ${providerLabel}`,
    `${chalk.hex(SLATE)('mode   ')}  ${modeColor.bold(opts.mode.toUpperCase())}`,
    `${chalk.hex(SLATE)('profile')}  ${opts.profile ? chalk.hex(TEAL)(opts.profile) : chalk.hex(SLATE)('none')}`,
    `${chalk.hex(SLATE)('memory ')}  ${opts.hasTridentMd ? chalk.hex(TEAL)('TRIDENT.md loaded') : chalk.hex(AMBER)('no TRIDENT.md (run: trident init)')}`,
  ];

  const inner = Math.min(w - 4, 80);
  const top = chalk.hex(SLATE).dim(BOX_TL + BOX_H.repeat(inner) + BOX_TR);
  const bot = chalk.hex(SLATE).dim(BOX_BL + BOX_H.repeat(inner) + BOX_BR);
  console.log('  ' + top);
  for (const line of lines) {
    console.log('  ' + chalk.hex(SLATE).dim(BOX_V) + ' ' + padLine(line, inner - 2) + ' ' + chalk.hex(SLATE).dim(BOX_V));
  }
  console.log('  ' + bot);
  console.log('');
}

function padLine(s: string, width: number): string {
  const visibleLen = s.replace(/\x1b\[[0-9;]*m/g, '').length;
  const pad = Math.max(0, width - visibleLen);
  return s + ' '.repeat(pad);
}

export function printToolStart(call: ToolCall): void {
  if (agentTextPrinted) {
    process.stdout.write('\n');
    agentTextPrinted = false;
  }

  const risk = classifyRisk(call);
  const icon = riskIcon(risk);
  const inputPreview = formatToolPreview(call);
  const line = `  ${icon} ${chalk.bold.white(call.name)} ${chalk.hex(SLATE).dim('-')} ${chalk.hex(SLATE).dim(risk)}`
    + (inputPreview ? `\n     ${chalk.hex(SLATE).dim('->')} ${chalk.hex(SLATE)(inputPreview)}` : '');

  console.log(line);
  lastToolStartLines = inputPreview ? 2 : 1;
}

/**
 * Call when output has been printed between printToolStart and printToolEnd
 * (diff previews, approval prompts) so printToolEnd does not rewind the cursor
 * over lines that no longer belong to the tool-start banner.
 */
export function resetToolLineTracking(): void {
  lastToolStartLines = 0;
}

export function printToolEnd(call: ToolCall, result: ToolResult): void {
  if (lastToolStartLines > 0) {
    process.stdout.write(`\x1b[${lastToolStartLines}A`);
    process.stdout.write('\x1b[0J');
    lastToolStartLines = 0;
  }

  const status = result.success ? chalk.hex(TEAL)(figures.tick) : chalk.hex(ROSE)(figures.cross);
  const name = chalk.bold.white(call.name);
  const dur = chalk.hex(SLATE).dim(`${result.duration_ms}ms`);
  const inputPreview = formatToolPreview(call);

  if (result.success) {
    const out = result.output ? firstLine(result.output, 80) : '';
    const detail = inputPreview ? chalk.hex(SLATE)(inputPreview) : '';
    console.log(`  ${status} ${name} ${chalk.hex(SLATE).dim('-')} ${detail} ${dur}`);
    if (out && shouldShowOutput(call)) {
      console.log(`     ${chalk.hex(SLATE).dim('->')} ${chalk.hex(SLATE)(out)}`);
    }
    return;
  }

  const errMsg = result.error || 'failed';
  console.log(`  ${status} ${name} ${chalk.hex(SLATE).dim('-')} ${chalk.hex(ROSE)(errMsg)} ${dur}`);
  if (inputPreview) {
    console.log(`     ${chalk.hex(SLATE).dim('->')} ${chalk.hex(SLATE).dim(inputPreview)}`);
  }
}

function shouldShowOutput(call: ToolCall): boolean {
  return call.name === 'read_file' || call.name === 'list_dir' || call.name === 'search_codebase' || call.name === 'run_command';
}

function firstLine(s: string, max: number): string {
  const line = s.split('\n').find((l) => l.trim().length > 0) || '';
  return line.length > max ? line.slice(0, max - 3) + '...' : line;
}

function riskIcon(risk: RiskLevel): string {
  switch (risk) {
    case 'read': return chalk.hex(SEA)('[R]');
    case 'write': return chalk.hex(AMBER)('[W]');
    case 'execute': return chalk.hex(TEAL)('[X]');
    case 'destructive': return chalk.hex(ROSE)('[!]');
  }
}

export function printAgentText(text: string): void {
  agentTextPrinted = true;
  process.stdout.write(chalk.white(text));
}

export function printSectionHeader(title: string): void {
  agentTextPrinted = false;
  console.log('');
  console.log('  ' + chalk.hex(TEAL).bold('> ') + chalk.bold.white(title));
  console.log('');
}

export function printSuccess(message: string): void {
  console.log('');
  console.log(`  ${chalk.hex(TEAL)(figures.tick)} ${chalk.bold(message)}`);
}

export function printError(message: string): void {
  console.log(`  ${chalk.hex(ROSE)(figures.cross)} ${chalk.hex(ROSE)(message)}`);
}

export function printInfo(message: string): void {
  console.log(`  ${chalk.hex(SEA)(figures.info)} ${chalk.hex(SLATE)(message)}`);
}

export function printWarn(message: string): void {
  console.log(`  ${chalk.hex(AMBER)(figures.warning)} ${chalk.hex(AMBER)(message)}`);
}

export function printFinalSummary(result: {
  summary: string;
  turns: number;
  totalCost: number;
  totalTokens: { input: number; output: number };
}): void {
  console.log('');
  console.log('');
  const w = Math.min(termWidth() - 4, 80);
  console.log('  ' + chalk.hex(TEAL).dim(BOX_H.repeat(w)));
  console.log('  ' + chalk.hex(TEAL).bold('task complete'));
  console.log('  ' + chalk.hex(TEAL).dim(BOX_H.repeat(w)));
  console.log('');

  const wrapped = wrapText(result.summary, w - 2);
  for (const line of wrapped) {
    console.log('  ' + chalk.white(line));
  }

  console.log('');
  const stats = [
    `${chalk.hex(SLATE)('turns')}  ${chalk.white(result.turns)}`,
    `${chalk.hex(SLATE)('tokens')} ${chalk.white((result.totalTokens.input + result.totalTokens.output).toLocaleString())}`,
    `${chalk.hex(SLATE)('cost')}   ${chalk.hex(AMBER)('$' + result.totalCost.toFixed(4))}`,
  ];
  console.log('  ' + stats.join('   '));
  console.log('');
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if ((current + ' ' + word).trim().length > width) {
      if (current) {
        lines.push(current);
      }
      current = word;
    } else {
      current = (current + ' ' + word).trim();
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines.length ? lines : [text];
}

export function printPrompt(): void {
  process.stdout.write('\n' + chalk.hex(TEAL).bold('TRIDENT ') + chalk.hex(SLATE)('> '));
}

export function printWelcome(userName?: string): void {
  const greeting = userName && userName.trim() && userName.trim() !== 'Operator'
    ? `ready, ${userName.trim()} - type a task or `
    : 'ready - type a task or ';
  console.log(chalk.hex(SLATE)('  ' + greeting), chalk.white('/help'), chalk.hex(SLATE)(' for commands'));
  console.log('');
}

export function printSlashHelp(): void {
  console.log('');
  console.log('  ' + chalk.hex(TEAL).bold('Slash commands') + chalk.hex(SLATE).dim('  (press / then Enter for the menu)'));

  const display = (cmd: { cmd: string; args?: string }): string =>
    cmd.args ? `${cmd.cmd} ${cmd.args}` : cmd.cmd;

  const allCmds = SLASH_COMMAND_GROUPS.flatMap((g) => g.commands);
  const pad = Math.max(...allCmds.map((c) => display(c).length));

  for (const { label, commands } of SLASH_COMMAND_GROUPS) {
    console.log('');
    console.log('  ' + chalk.hex(AMBER).dim(label));
    for (const command of commands) {
      console.log('    ' + chalk.hex(TEAL)(display(command).padEnd(pad + 2)) + chalk.hex(SLATE)(command.desc));
    }
  }

  console.log('');
  console.log('  ' + chalk.hex(SLATE).dim('Plain text without a leading "/" is sent as a task to the agent.'));
  console.log('  ' + chalk.hex(SLATE).dim('Prefix with "!" to run a shell command directly (e.g. !npm test).'));
  console.log('  ' + chalk.hex(SLATE).dim('Mention files with @path to inline their contents into the task.'));
  console.log('  ' + chalk.hex(SLATE).dim('Custom commands: .trident/commands/<name>.md becomes /<name>.'));
  console.log('');
}

export function printStatus(opts: {
  model: string;
  provider: string;
  mode: string;
  cost: number;
  budgetUsd?: number;
  budgetRemainingUsd?: number;
  tokens: { input: number; output: number };
  turns: number;
  profile?: string;
  systemOverrideActive?: boolean;
}): void {
  console.log('');
  console.log('  ' + chalk.hex(TEAL).bold('Session status'));
  const total = opts.tokens.input + opts.tokens.output;
  const rows: [string, string][] = [
    ['provider', opts.provider],
    ['model', opts.model],
    ['profile', opts.profile || 'none'],
    ['override', opts.systemOverrideActive ? 'active' : 'none'],
    ['mode', opts.mode],
    ['turns', String(opts.turns)],
    ['tokens', `${total.toLocaleString()} (in: ${opts.tokens.input.toLocaleString()}, out: ${opts.tokens.output.toLocaleString()})`],
    ['cost', '$' + opts.cost.toFixed(4)],
  ];

  if (opts.budgetUsd !== undefined) {
    rows.push(['budget', '$' + opts.budgetUsd.toFixed(2)]);
  }

  if (opts.budgetRemainingUsd !== undefined) {
    rows.push(['remaining', '$' + opts.budgetRemainingUsd.toFixed(4)]);
  }

  for (const [key, value] of rows) {
    console.log('    ' + chalk.hex(SLATE)(key.padEnd(10)) + chalk.white(value));
  }
  console.log('');
}

function formatToolPreview(call: ToolCall): string {
  switch (call.name) {
    case 'run_command': return `$ ${truncate(call.input.cmd as string, 80)}`;
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'delete_file': return call.input.path as string;
    case 'list_dir': return (call.input.path as string) + (call.input.recursive ? ' (recursive)' : '');
    case 'search_codebase': return `"${truncate(call.input.query as string, 60)}"`;
    case 'web_fetch': return call.input.url as string;
    case 'ask_user': return `"${truncate(call.input.question as string, 60)}"`;
    case 'final_answer': return '';
    default:
      if (call.name.startsWith('mcp__')) {
        return truncate(JSON.stringify(call.input), 80);
      }
      return '';
  }
}

function truncate(s: string, max: number): string {
  if (!s) {
    return '';
  }
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}
