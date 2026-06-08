import chalk from 'chalk';
import figures from 'figures';
import type { ToolCall, ToolResult } from '../agent/tools.js';
import type { RiskLevel } from '../warden/index.js';
import { classifyRisk } from '../warden/index.js';

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
  return call.name === 'read_file'
    || call.name === 'list_dir'
    || call.name === 'search_codebase'
    || call.name === 'run_command'
    || call.name === 'web_search'
    || call.name === 'github_api'
    || call.name === 'read_notebook'
    || call.name === 'read_pdf'
    || call.name === 'read_image'
    || call.name === 'spawn_agent'
    || call.name === 'edit_notebook_cell';
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

export function printCostUpdate(cost: number, tokens: { input: number; output: number }): void {
  const costStr = `$${cost.toFixed(4)}`;
  const tokenStr = `${(tokens.input + tokens.output).toLocaleString()} tok`;
  process.stdout.write(`\r  ${chalk.hex(SLATE).dim('-')} ${chalk.hex(AMBER)(costStr)}  ${chalk.hex(SLATE).dim(tokenStr)}      `);
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

export function printWelcome(): void {
  console.log(chalk.hex(SLATE)('  ready - type a task or '), chalk.white('/help'), chalk.hex(SLATE)(' for commands'));
  console.log(chalk.hex(SLATE)('  tip: '), chalk.white('@path/to/file'), chalk.hex(SLATE)(' inlines file content into your prompt'));
  console.log('');
}

export function printSlashHelp(): void {
  console.log('');
  console.log('  ' + chalk.hex(TEAL).bold('Slash commands') + chalk.hex(SLATE).dim('  (press / then Enter for the menu)'));

  const groups: Array<{ label: string; cmds: [string, string][] }> = [
    {
      label: 'Session',
      cmds: [
        ['/help', 'show this help'],
        ['/status', 'show model / provider / mode / cost'],
        ['/cost [breakdown]', 'show cost totals (breakdown = per-turn table)'],
        ['/history', 'show tasks run this session'],
        ['/clear', 'clear the screen'],
        ['/exit', 'quit (or Ctrl+C)'],
      ],
    },
    {
      label: 'Agent',
      cmds: [
        ['/retry', 're-run the last task'],
        ['/undo', 'revert last file write or edit'],
        ['/snapshot [label]', 'git stash current state as a named snapshot'],
        ['/resume <n>', 'load past session as context (n = number from /sessions)'],
        ['/replay <n>', 're-execute approved tool calls from a past session'],
        ['/save [file]', 'save session transcript to a file'],
        ['/compact', 'AI-summarise and trim session history'],
        ['/budget [usd|clear]', 'show, set, or clear the session budget'],
        ['/profile [name|clear]', 'show or switch trained profile'],
        ['/profiles', 'list trained profiles'],
        ['/override [text|clear]', 'show or set system override'],
        ['/memory', 'show persistent agent memory'],
        ['/forget', 'clear all agent memory'],
        ['/plan [on|off]', 'toggle plan-before-act mode'],
        ['/queue [add|list|run|clear]', 'manage sequential task queue'],
        ['/autotest [on|off]', 'run tests after each file write'],
        ['/autoformat [on|off]', 'format files after each write'],
      ],
    },
    {
      label: 'Project',
      cmds: [
        ['/search [--regex] <q>', 'quick codebase search (--regex for regex mode)'],
        ['/git [args]', 'run a git command in the project root (default: status)'],
        ['/diff [file]', 'show git diff for working tree or a specific file'],
        ['/pin <file>', 'pin a file into system prompt (always in AI context)'],
        ['/unpin <file|all>', 'unpin a file or clear all pinned files'],
        ['/pinned', 'list currently pinned files'],
        ['/init', 'generate TRIDENT.md for the current project'],
        ['/context', 'show current TRIDENT.md contents'],
        ['/tree', 'show project file tree'],
        ['/cwd', 'show working directory'],
      ],
    },
    {
      label: 'Config',
      cmds: [
        ['/model <name>', 'switch model (slash in name -> OpenRouter)'],
        ['/provider <name>', 'switch provider - anthropic | openrouter | codex'],
        ['/mode <name>', 'switch approval mode - yolo | review | lockdown'],
        ['/yolo', 'shortcut for /mode yolo'],
        ['/safe', 'shortcut for /mode review'],
        ['/lock', 'shortcut for /mode lockdown'],
        ['/models', 'list available models'],
        ['/sessions', 'list past session log files'],
      ],
    },
    {
      label: 'MCP',
      cmds: [
        ['/mcp-list', 'list connected MCP tools'],
        ['/mcp-call <tool> <json>', 'call an MCP tool manually'],
      ],
    },
    {
      label: 'Permits',
      cmds: [
        ['/permits', 'list auto-approval permit rules'],
        ['/permit <tool> [pattern]', 'add a permit rule for a tool'],
      ],
    },
    {
      label: 'PR Watch',
      cmds: [
        ['/pr-watch <owner/repo#n>', 'watch a GitHub PR for changes'],
        ['/pr-unwatch', 'stop all PR watchers'],
      ],
    },
  ];

  const allCmds = groups.flatMap((g) => g.cmds);
  const pad = Math.max(...allCmds.map((c) => c[0].length));

  for (const { label, cmds } of groups) {
    console.log('');
    console.log('  ' + chalk.hex(AMBER).dim(label));
    for (const [cmd, description] of cmds) {
      console.log('    ' + chalk.hex(TEAL)(cmd.padEnd(pad + 2)) + chalk.hex(SLATE)(description));
    }
  }

  console.log('');
  console.log('  ' + chalk.hex(SLATE).dim('Plain text without a leading "/" is sent as a task to the agent.'));
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
  pinnedCount?: number;
  contextUsedTokens?: number;
  contextLimitTokens?: number;
  planMode?: boolean;
}): void {
  console.log('');
  console.log('  ' + chalk.hex(TEAL).bold('Session status'));
  const total = opts.tokens.input + opts.tokens.output;
  const rows: [string, string][] = [
    ['provider', opts.provider],
    ['model', opts.model],
    ['profile', opts.profile || 'none'],
    ['plan', opts.planMode ? chalk.hex(TEAL)('ON') : chalk.hex(SLATE)('off')],
    ['override', opts.systemOverrideActive ? 'active' : 'none'],
    ['pinned', opts.pinnedCount ? `${opts.pinnedCount} file(s)` : 'none'],
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

  if (opts.contextUsedTokens !== undefined && opts.contextLimitTokens && opts.contextLimitTokens > 0) {
    const pct = Math.min(1, opts.contextUsedTokens / opts.contextLimitTokens);
    const barWidth = 20;
    const filled = Math.round(pct * barWidth);
    const empty = barWidth - filled;
    const barColor = pct >= 0.9 ? ROSE : pct >= 0.7 ? AMBER : TEAL;
    const bar = chalk.hex(barColor)('█'.repeat(filled)) + chalk.hex(SLATE)('░'.repeat(empty));
    const pctStr = `${Math.round(pct * 100)}%`;
    console.log('    ' + chalk.hex(SLATE)('context   ') + '[' + bar + '] ' + chalk.hex(barColor)(pctStr));
  }

  console.log('');
}

function formatToolPreview(call: ToolCall): string {
  switch (call.name) {
    case 'run_command': return `$ ${truncate(call.input.cmd as string, 80)}`;
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'delete_file':
    case 'git_blame':
    case 'read_notebook':
    case 'read_pdf':
    case 'read_image': return call.input.path as string;
    case 'edit_notebook_cell': return `${call.input.path as string} [cell ${call.input.cell_index}]`;
    case 'list_dir': return (call.input.path as string) + (call.input.recursive ? ' (recursive)' : '');
    case 'search_codebase':
    case 'web_search': return `"${truncate((call.input.query as string), 60)}"`;
    case 'web_fetch': return call.input.url as string;
    case 'ask_user': return `"${truncate(call.input.question as string, 60)}"`;
    case 'memory_update': return truncate(call.input.fact as string, 60);
    case 'github_api': return `${call.input.method || 'GET'} ${truncate(call.input.endpoint as string, 60)}`;
    case 'final_answer': return '';
    case 'spawn_agent': return `task: ${truncate(call.input.task as string, 60)}`;
    default: return '';
  }
}

function truncate(s: string, max: number): string {
  if (!s) {
    return '';
  }
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

export const theme = { TEAL, AMBER, ROSE, SLATE, SEA };
