import chalk from 'chalk';
import figures from 'figures';
import type { ToolCall, ToolResult } from '../agent/tools.js';
import type { RiskLevel } from '../warden/index.js';
import { classifyRisk } from '../warden/index.js';

// Theme — muted, modern, Codex/Claude-inspired
const TEAL = '#5EEAD4';      // primary accent (calmer than neon cyan)
const AMBER = '#F5C97A';     // secondary accent
const ROSE = '#F87171';      // danger
const SLATE = '#94A3B8';     // dim text
const SEA = '#7DD3FC';       // info

const HR = chalk.hex(SLATE).dim('─');
const VR = chalk.hex(SLATE).dim('│');
const BOX_TL = '╭', BOX_TR = '╮', BOX_BL = '╰', BOX_BR = '╯', BOX_H = '─', BOX_V = '│';

let lastToolStartLines = 0;
let agentTextPrinted = false;

function termWidth(): number {
  return Math.max(60, Math.min(process.stdout.columns || 100, 120));
}

export function printLogo(): void {
  const w = termWidth();
  const banner = [
    '████████╗ ██████╗  ██╗ ██████╗  ███████╗ ███╗   ██╗ ████████╗',
    '╚══██╔══╝ ██╔══██╗ ██║ ██╔══██╗ ██╔════╝ ████╗  ██║ ╚══██╔══╝',
    '   ██║    ██████╔╝ ██║ ██║  ██║ █████╗   ██╔██╗ ██║    ██║   ',
    '   ██║    ██╔══██╗ ██║ ██║  ██║ ██╔══╝   ██║╚██╗██║    ██║   ',
    '   ██║    ██║  ██║ ██║ ██████╔╝ ███████╗ ██║ ╚████║    ██║   ',
    '   ╚═╝    ╚═╝  ╚═╝ ╚═╝ ╚═════╝  ╚══════╝ ╚═╝  ╚═══╝    ╚═╝   ',
  ];
  console.log('');
  for (let i = 0; i < banner.length; i++) {
    const color = i < banner.length / 2 ? TEAL : AMBER;
    console.log('  ' + chalk.hex(color).bold(banner[i]));
  }
  console.log('');
  console.log('  ' + chalk.hex(TEAL)('🔱  ') + chalk.hex(SLATE)('Three Prongs. One Power. ') + chalk.hex(AMBER)('All Yours.'));
  console.log('  ' + chalk.hex(SLATE).dim('─'.repeat(Math.min(w - 4, 56))));
  console.log('');
}

export function printSessionHeader(opts: {
  model: string;
  mode: string;
  provider: string;
  project: string;
  hasTridentMd: boolean;
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

// Visible-length padding (strips ANSI)
function padLine(s: string, width: number): string {
  // eslint-disable-next-line no-control-regex
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

  const line = `  ${icon} ${chalk.bold.white(call.name)} ${chalk.hex(SLATE).dim('·')} ${chalk.hex(SLATE).dim(risk)}` +
    (inputPreview ? `\n     ${chalk.hex(SLATE).dim('└')} ${chalk.hex(SLATE)(inputPreview)}` : '');

  console.log(line);
  lastToolStartLines = inputPreview ? 2 : 1;
}

export function printToolEnd(call: ToolCall, result: ToolResult): void {
  // Move up and clear lines we wrote in printToolStart for a clean redraw.
  if (lastToolStartLines > 0) {
    process.stdout.write(`\x1b[${lastToolStartLines}A`); // cursor up
    process.stdout.write('\x1b[0J'); // clear from cursor down
    lastToolStartLines = 0;
  }

  const status = result.success
    ? chalk.hex(TEAL)(figures.tick)
    : chalk.hex(ROSE)(figures.cross);
  const name = chalk.bold.white(call.name);
  const dur = chalk.hex(SLATE).dim(`${result.duration_ms}ms`);
  const inputPreview = formatToolPreview(call);

  if (result.success) {
    const out = result.output ? firstLine(result.output, 80) : '';
    const detail = inputPreview ? chalk.hex(SLATE)(inputPreview) : '';
    console.log(`  ${status} ${name} ${chalk.hex(SLATE).dim('·')} ${detail} ${dur}`);
    if (out && shouldShowOutput(call)) {
      console.log(`     ${chalk.hex(SLATE).dim('└')} ${chalk.hex(SLATE)(out)}`);
    }
  } else {
    const errMsg = result.error || 'failed';
    console.log(`  ${status} ${name} ${chalk.hex(SLATE).dim('·')} ${chalk.hex(ROSE)(errMsg)} ${dur}`);
    if (inputPreview) {
      console.log(`     ${chalk.hex(SLATE).dim('└')} ${chalk.hex(SLATE).dim(inputPreview)}`);
    }
  }
}

function shouldShowOutput(call: ToolCall): boolean {
  return call.name === 'read_file' || call.name === 'list_dir' || call.name === 'search_codebase' || call.name === 'run_command';
}

function firstLine(s: string, max: number): string {
  const line = s.split('\n').find(l => l.trim().length > 0) || '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

function riskIcon(risk: RiskLevel): string {
  switch (risk) {
    case 'read': return chalk.hex(SEA)('◇');
    case 'write': return chalk.hex(AMBER)('◆');
    case 'execute': return chalk.hex(TEAL)('▶');
    case 'destructive': return chalk.hex(ROSE)('✱');
  }
}

export function printAgentText(text: string): void {
  agentTextPrinted = true;
  process.stdout.write(chalk.white(text));
}

export function printSectionHeader(title: string): void {
  agentTextPrinted = false;
  console.log('');
  console.log('  ' + chalk.hex(TEAL).bold('▍ ') + chalk.bold.white(title));
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
  process.stdout.write(
    `\r  ${chalk.hex(SLATE).dim('·')} ${chalk.hex(AMBER)(costStr)}  ${chalk.hex(SLATE).dim(tokenStr)}      `
  );
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
  console.log('  ' + chalk.hex(TEAL).bold('🔱 task complete'));
  console.log('  ' + chalk.hex(TEAL).dim(BOX_H.repeat(w)));
  console.log('');

  // Wrap summary nicely
  const wrapped = wrapText(result.summary, w - 2);
  for (const line of wrapped) console.log('  ' + chalk.white(line));

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
  for (const w of words) {
    if ((current + ' ' + w).trim().length > width) {
      if (current) lines.push(current);
      current = w;
    } else {
      current = (current + ' ' + w).trim();
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [text];
}

export function printPrompt(): void {
  process.stdout.write('\n' + chalk.hex(TEAL).bold('🔱 ') + chalk.hex(SLATE)('› '));
}

export function printWelcome(): void {
  console.log(chalk.hex(SLATE)('  ready · type a task or '), chalk.white('/help'), chalk.hex(SLATE)('for commands'));
  console.log('');
}

export function printSlashHelp(): void {
  console.log('');
  console.log('  ' + chalk.hex(TEAL).bold('Slash commands') + chalk.hex(SLATE).dim('  (press / + Enter for interactive menu)'));

  const groups: Array<{ label: string; cmds: [string, string][] }> = [
    {
      label: 'Session',
      cmds: [
        ['/help',            'show this help'],
        ['/status',          'show model / provider / mode / cost'],
        ['/cost',            'show running cost & token totals'],
        ['/history',         'show tasks run this session'],
        ['/clear',           'clear the screen'],
        ['/exit',            'quit (or Ctrl+C)'],
      ],
    },
    {
      label: 'Agent',
      cmds: [
        ['/retry',           're-run the last task'],
        ['/undo',            'revert last file write or edit'],
        ['/save [file]',     'save session transcript to a file'],
        ['/compact',         'summarise & trim session history'],
      ],
    },
    {
      label: 'Project',
      cmds: [
        ['/init',            'generate TRIDENT.md for the current project'],
        ['/context',         'show current TRIDENT.md contents'],
        ['/tree',            'show project file tree'],
        ['/cwd',             'show working directory'],
      ],
    },
    {
      label: 'Config',
      cmds: [
        ['/model <name>',    'switch model (slash in name → OpenRouter)'],
        ['/provider <name>', 'switch provider — anthropic | openrouter'],
        ['/mode <name>',     'switch approval mode — yolo | review | lockdown'],
        ['/yolo',            'shortcut for /mode yolo'],
        ['/safe',            'shortcut for /mode review'],
        ['/lock',            'shortcut for /mode lockdown'],
        ['/budget [usd]',    'show or set spend budget (e.g. /budget 1.00)'],
        ['/models',          'list available models'],
        ['/sessions',        'list past session log files'],
        ['/version',         'show TRIDENT CLI version'],
      ],
    },
  ];

  const allCmds = groups.flatMap(g => g.cmds);
  const pad = Math.max(...allCmds.map(c => c[0].length));

  for (const { label, cmds } of groups) {
    console.log('');
    console.log('  ' + chalk.hex(AMBER).dim(label));
    for (const [c, d] of cmds) {
      console.log('    ' + chalk.hex(TEAL)(c.padEnd(pad + 2)) + chalk.hex(SLATE)(d));
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
  tokens: { input: number; output: number };
  turns: number;
}): void {
  console.log('');
  console.log('  ' + chalk.hex(TEAL).bold('Session status'));
  const total = opts.tokens.input + opts.tokens.output;
  const rows: [string, string][] = [
    ['provider', opts.provider],
    ['model',    opts.model],
    ['mode',     opts.mode],
    ['turns',    String(opts.turns)],
    ['tokens',   `${total.toLocaleString()} (in: ${opts.tokens.input.toLocaleString()}, out: ${opts.tokens.output.toLocaleString()})`],
    ['cost',     '$' + opts.cost.toFixed(4)],
  ];
  for (const [k, v] of rows) {
    console.log('    ' + chalk.hex(SLATE)(k.padEnd(10)) + chalk.white(v));
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
    case 'list_dir':    return (call.input.path as string) + (call.input.recursive ? ' (recursive)' : '');
    case 'search_codebase': return `"${truncate(call.input.query as string, 60)}"`;
    case 'web_fetch':   return call.input.url as string;
    case 'ask_user':    return `"${truncate(call.input.question as string, 60)}"`;
    case 'final_answer': return '';
    default: return '';
  }
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Re-export theme for use elsewhere
export const theme = { TEAL, AMBER, ROSE, SLATE, SEA };
