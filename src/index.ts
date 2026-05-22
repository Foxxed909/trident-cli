#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import { execa } from 'execa';

import { getConfig, setConfig, getConfigPath, ConfigSchema } from './config.js';
import type { TridentConfig } from './config.js';
import { runOnboarding } from './ui/onboarding.js';
import { loadOrCreateContext, generateTridentMd, buildSystemPrompt, generateProjectTree } from './oracle/index.js';
import { runAgentLoop, type ProviderName } from './agent/loop.js';
import { listOpenRouterModels } from './providers/openrouter.js';
import { readFile as fsReadFile, writeFile as fsWriteFile, unlink as fsUnlink } from 'fs/promises';
import { resolve as pathResolve } from 'path';
import {
  printLogo,
  printSessionHeader,
  printToolStart,
  printToolEnd,
  printAgentText,
  printSectionHeader,
  printSuccess,
  printError,
  printInfo,
  printWarn,
  printFinalSummary,
  printPrompt,
  printWelcome,
  printSlashHelp,
  printStatus,
} from './ui/renderer.js';

const program = new Command();

program
  .name('trident')
  .description('🔱 TRIDENT — All-Powerful Agentic AI Coding CLI')
  .version('1.0.0');

// ─── MAIN INTERACTIVE / ONE-SHOT COMMAND ─────────────────────────────────────
program
  .argument('[task]', 'Task to execute (omit for interactive mode)')
  .option('-m, --model <model>', 'Model to use')
  .option('-p, --provider <provider>', 'Provider: anthropic | openrouter')
  .option('--mode <mode>', 'Approval mode: yolo | review | lockdown')
  .option('--max-turns <n>', 'Max agent loop iterations', '50')
  .option('--budget <usd>', 'Max budget in USD')
  .action(async (task?: string, opts?: {
    model?: string;
    provider?: string;
    mode?: string;
    maxTurns?: string;
    budget?: string;
  }) => {
    await runTrident(task, opts);
  });

// ─── SUBCOMMANDS ──────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Generate TRIDENT.md for the current project')
  .action(async () => {
    printLogo();
    printInfo('Scanning project...');
    const cwd = process.cwd();
    const ctx = await loadOrCreateContext(cwd);
    await generateTridentMd(ctx, cwd);
    printSuccess('Generated TRIDENT.md — edit it to customize AI behavior.');
  });

program
  .command('models')
  .description('List available models for each provider')
  .action(() => {
    console.log(chalk.hex('#00D4FF').bold('\n🔱 TRIDENT — Available Models\n'));

    console.log(chalk.bold('  ANTHROPIC (--provider anthropic)'));
    const anthropicModels = [
      ['claude-opus-4-7',           '$15 / $75 per M tokens'],
      ['claude-sonnet-4-6',         '$3  / $15 per M tokens'],
      ['claude-haiku-4-5-20251001', '$0.25 / $1.25 per M tokens'],
    ];
    for (const [m, p] of anthropicModels) {
      console.log(`    ${chalk.white(m.padEnd(38))} ${chalk.dim(p)}`);
    }

    console.log('');
    console.log(chalk.bold('  OPENROUTER (--provider openrouter)'));
    console.log(chalk.dim(listOpenRouterModels().replace(/\n/g, '\n  ')));
    console.log('');
    console.log(chalk.bold('  FREE MODELS (OpenRouter, no cost)'));
    const freeModels = [
      ['openai/gpt-oss-120b:free',              'free'],
      ['openai/gpt-oss-20b:free',               'free'],
      ['nvidia/nemotron-3-super-120b-a12b:free', 'free'],
    ];
    for (const [m, p] of freeModels) {
      console.log(`    ${chalk.white(m.padEnd(42))} ${chalk.green(p)}`);
    }
    console.log('');
  });

program
  .command('config')
  .description('Show or set configuration')
  .argument('[key]', 'Config key')
  .argument('[value]', 'Value to set')
  .action((key?: string, value?: string) => {
    const config = getConfig();
    if (!key) {
      console.log(chalk.cyan('\n🔱 TRIDENT Configuration\n'));
      console.log(JSON.stringify(config, null, 2));
      console.log(chalk.dim(`\nConfig path: ${getConfigPath()}\n`));
    } else if (key && value) {
      let parsed: unknown = value;
      if (value === 'true') parsed = true;
      else if (value === 'false') parsed = false;
      else if (!isNaN(Number(value))) parsed = Number(value);

      // Validate key is a known config property
      const validKeys = Object.keys(ConfigSchema.shape);
      if (!validKeys.includes(key)) {
        console.log(chalk.red(`✗ Unknown config key: "${key}". Valid keys: ${validKeys.join(', ')}`));
        process.exit(1);
      }

      // Validate known keys before writing
      if (key === 'mode' && !['yolo', 'review', 'lockdown'].includes(value)) {
        console.log(chalk.red(`✗ Invalid value for mode: "${value}". Must be one of: yolo, review, lockdown`));
        process.exit(1);
      }
      if (key === 'maxTurns') {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) {
          console.log(chalk.red(`✗ Invalid value for maxTurns: "${value}". Must be a positive integer.`));
          process.exit(1);
        }
      }
      if (key === 'provider' && !['anthropic', 'openrouter'].includes(value)) {
        console.log(chalk.red(`✗ Invalid value for provider: "${value}". Must be one of: anthropic, openrouter`));
        process.exit(1);
      }

      setConfig(key as keyof typeof config, parsed);
      console.log(chalk.green(`✓ Set ${key} = ${value}`));
    } else {
      console.log(`${key}: ${JSON.stringify(config[key as keyof typeof config])}`);
    }
  });

program
  .command('doctor')
  .description('Check environment and dependencies')
  .action(async () => {
    printLogo();
    console.log(chalk.cyan('\n🔱 TRIDENT Doctor\n'));

    const isWindows = process.platform === 'win32';
    const shellExe = isWindows ? 'cmd' : 'bash';
    const shellFlag = isWindows ? '/c' : '-c';

    const checks = [
      { name: 'Node.js', cmd: 'node --version' },
      { name: 'npm', cmd: 'npm --version' },
      { name: 'git', cmd: 'git --version' },
      { name: isWindows ? 'cmd' : 'bash', cmd: isWindows ? 'echo ok' : 'bash --version' },
    ];

    for (const check of checks) {
      try {
        const result = await execa(shellExe, [shellFlag, check.cmd], { reject: false });
        console.log(`  ${chalk.green('✓')} ${check.name}: ${chalk.dim(result.stdout.split('\n')[0])}`);
      } catch {
        console.log(`  ${chalk.red('✗')} ${check.name}: ${chalk.red('NOT FOUND')}`);
      }
    }

    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;

    console.log('');
    console.log(`  ${hasAnthropic ? chalk.green('✓') : chalk.red('✗')} ANTHROPIC_API_KEY:  ${hasAnthropic ? chalk.green('set') : chalk.red('NOT SET')}`);
    console.log(`  ${hasOpenRouter ? chalk.green('✓') : chalk.yellow('○')} OPENROUTER_API_KEY: ${hasOpenRouter ? chalk.green('set') : chalk.yellow('not set (optional)')}`);

    if (!hasAnthropic && !hasOpenRouter) {
      console.log(chalk.yellow('\n  → Set at least one API key:'));
      console.log(chalk.dim('    export ANTHROPIC_API_KEY=sk-ant-...'));
      console.log(chalk.dim('    export OPENROUTER_API_KEY=sk-or-...'));
    }

    console.log('');
    if (hasAnthropic || hasOpenRouter) {
      console.log(chalk.green('  🔱 TRIDENT is ready!\n'));
    } else {
      console.log(chalk.red('  ✗ Set at least one API key to use TRIDENT.\n'));
    }
  });

program
  .command('review')
  .description('Review the last session action log')
  .action(async () => {
    const { homedir } = await import('os');
    const { readdir, readFile } = await import('fs/promises');
    const logDir = join(homedir(), '.trident', 'logs');

    if (!existsSync(logDir)) {
      printError('No sessions logged yet.');
      return;
    }

    const files = (await readdir(logDir)).sort().reverse();
    if (files.length === 0) {
      printError('No session logs found.');
      return;
    }

    const latest = files[0];
    const content = await readFile(join(logDir, latest), 'utf-8');
    const entries = content.trim().split('\n').flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { console.warn(`  [warn] Skipping malformed log line: ${l.slice(0, 60)}`); return []; }
    });

    console.log(chalk.cyan(`\n🔱 Session: ${latest.replace('.jsonl', '')}\n`));
    for (const entry of entries) {
      const icon = entry.approved ? chalk.green('✓') : chalk.red('✗');
      const time = new Date(entry.timestamp).toLocaleTimeString();
      console.log(`  ${icon} [${chalk.dim(time)}] ${chalk.bold(entry.toolName)} ${chalk.dim(JSON.stringify(entry.input).slice(0, 60))}`);
    }
    console.log('');
  });

program
  .command('heal')
  .description('Diagnose and auto-repair common TRIDENT issues')
  .option('--reset-config', 'Reset configuration to defaults')
  .option('--regen-md', 'Regenerate TRIDENT.md for current project')
  .action(async (opts: { resetConfig?: boolean; regenMd?: boolean }) => {
    printLogo();
    console.log(chalk.hex('#00D4FF').bold('\n🔱 TRIDENT Heal\n'));

    let issues = 0;
    let fixed = 0;

    // Check Node.js version
    const nodeMajor = parseInt(process.version.slice(1).split('.')[0], 10);
    if (nodeMajor < 18) {
      console.log(`  ${chalk.red('✗')} Node.js ${process.version} — requires v18+`);
      issues++;
    } else {
      console.log(`  ${chalk.green('✓')} Node.js ${process.version}`);
    }

    // Check API keys
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;
    if (!hasAnthropic && !hasOpenRouter) {
      console.log(`  ${chalk.red('✗')} No API keys set`);
      console.log(chalk.dim('    → export ANTHROPIC_API_KEY=sk-ant-... or OPENROUTER_API_KEY=sk-or-...'));
      issues++;
    } else {
      if (hasAnthropic) console.log(`  ${chalk.green('✓')} ANTHROPIC_API_KEY set`);
      if (hasOpenRouter) console.log(`  ${chalk.green('✓')} OPENROUTER_API_KEY set`);
    }

    // Validate config
    try {
      ConfigSchema.parse(getConfig());
      console.log(`  ${chalk.green('✓')} Config valid (${getConfigPath()})`);
    } catch (err) {
      console.log(`  ${chalk.red('✗')} Config invalid: ${err instanceof Error ? err.message : String(err)}`);
      issues++;
      if (opts.resetConfig) {
        const defaults = ConfigSchema.parse({});
        for (const [k, v] of Object.entries(defaults)) {
          setConfig(k as keyof TridentConfig, v);
        }
        console.log(`  ${chalk.green('→')} Config reset to defaults`);
        fixed++;
      } else {
        console.log(chalk.dim('    → Run: trident heal --reset-config to fix'));
      }
    }

    // Check TRIDENT.md
    const cwd = process.cwd();
    const tridentMdPath = join(cwd, 'TRIDENT.md');
    if (!existsSync(tridentMdPath)) {
      console.log(`  ${chalk.yellow('⚠')} No TRIDENT.md in current directory`);
      if (opts.regenMd) {
        const ctx = await loadOrCreateContext(cwd);
        await generateTridentMd(ctx, cwd);
        console.log(`  ${chalk.green('→')} Generated TRIDENT.md`);
        fixed++;
      } else {
        console.log(chalk.dim('    → Run: trident heal --regen-md to generate one'));
      }
    } else {
      console.log(`  ${chalk.green('✓')} TRIDENT.md present`);
    }

    // Check shell availability
    try {
      const shellCmd = process.platform === 'win32' ? 'cmd' : 'bash';
      const shellFlag = process.platform === 'win32' ? '/c' : '-c';
      const { stdout } = await execa(shellCmd, [shellFlag, 'echo ok'], { reject: true });
      if (stdout.trim() === 'ok') {
        console.log(`  ${chalk.green('✓')} Shell (${shellCmd}) available`);
      }
    } catch {
      console.log(`  ${chalk.yellow('⚠')} Shell not available — run_command tool may not work`);
    }

    console.log('');
    if (issues === 0) {
      console.log(chalk.green('  🔱 TRIDENT is healthy! No issues found.\n'));
    } else if (fixed > 0) {
      console.log(chalk.yellow(`  🔱 Found ${issues} issue(s), fixed ${fixed}. Re-run to verify.\n`));
    } else {
      console.log(chalk.red(`  🔱 Found ${issues} issue(s). See suggestions above.\n`));
    }
  });

// ─── MAIN FUNCTION ─────────────────────────────────────────────────────────────
function resolveProvider(
  cliProvider?: string,
  configProvider?: string,
  model?: string
): ProviderName {
  // Explicit CLI flag wins
  if (cliProvider === 'openrouter') return 'openrouter';
  if (cliProvider === 'anthropic') return 'anthropic';
  // Auto-detect from model name (openrouter models contain a slash like "openai/gpt-4o")
  if (model && model.includes('/')) return 'openrouter';
  // Fall back to config, then anthropic
  return (configProvider as ProviderName) || 'anthropic';
}

// ─── SESSION UNDO STACK ───────────────────────────────────────────────────────
interface UndoEntry {
  path: string;
  originalContent: string | null; // null = file did not exist before the write
}

// ─── COMMAND PICKER (numbered menu, readline-compatible) ─────────────────────
async function showCommandPicker(
  rl: ReturnType<typeof createInterface>,
  handleSlash: (raw: string) => Promise<boolean>
): Promise<void> {
  const TEAL = '#5EEAD4';
  const SLATE = '#94A3B8';
  const AMBER = '#F5C97A';

  const groups: Array<{ label: string; entries: Array<{ cmd: string; desc: string }> }> = [
    {
      label: 'Session',
      entries: [
        { cmd: '/help',     desc: 'show all slash commands' },
        { cmd: '/status',   desc: 'model / provider / mode / cost' },
        { cmd: '/history',  desc: 'tasks run this session' },
        { cmd: '/clear',    desc: 'clear the screen' },
        { cmd: '/exit',     desc: 'quit trident' },
      ],
    },
    {
      label: 'Agent',
      entries: [
        { cmd: '/retry',    desc: 're-run the last task' },
        { cmd: '/undo',     desc: 'revert last file write or edit' },
        { cmd: '/compact',  desc: 'trim session history & undo stack' },
        { cmd: '/save',     desc: 'save session transcript to a .md file' },
      ],
    },
    {
      label: 'Project',
      entries: [
        { cmd: '/init',     desc: 'generate TRIDENT.md' },
        { cmd: '/context',  desc: 'show TRIDENT.md contents' },
        { cmd: '/tree',     desc: 'show project file tree' },
        { cmd: '/cwd',      desc: 'show working directory' },
      ],
    },
    {
      label: 'Config',
      entries: [
        { cmd: '/yolo',     desc: 'mode → YOLO (approve all)' },
        { cmd: '/safe',     desc: 'mode → REVIEW (confirm writes)' },
        { cmd: '/lock',     desc: 'mode → LOCKDOWN (confirm everything)' },
        { cmd: '/budget',   desc: 'show or set spend budget' },
        { cmd: '/models',   desc: 'list available models' },
        { cmd: '/sessions', desc: 'list past session log files' },
        { cmd: '/version',  desc: 'show TRIDENT CLI version' },
      ],
    },
  ];

  console.log('');
  console.log('  ' + chalk.hex(TEAL).bold('🔱 Command menu'));
  console.log('');

  let n = 1;
  const numToCmd: Record<number, string> = {};

  for (const { label, entries } of groups) {
    console.log('  ' + chalk.hex(AMBER).dim(`── ${label} ──`));
    for (const { cmd, desc } of entries) {
      numToCmd[n] = cmd;
      const num   = chalk.hex(SLATE).dim(String(n).padStart(2));
      const cmdStr = chalk.hex(TEAL)(cmd.padEnd(12));
      const descStr = chalk.hex(SLATE)(desc);
      console.log(`    ${num}  ${cmdStr}  ${descStr}`);
      n++;
    }
    console.log('');
  }

  return new Promise<void>((resolve) => {
    rl.question(chalk.hex(TEAL)('  Enter number (or Enter to cancel): '), async (answer) => {
      const chosen = parseInt(answer.trim(), 10);
      if (!isNaN(chosen) && numToCmd[chosen]) {
        await handleSlash(numToCmd[chosen]);
      }
      resolve();
    });
  });
}

async function runTrident(
  initialTask?: string,
  cliOpts?: { model?: string; provider?: string; mode?: string; maxTurns?: string; budget?: string }
): Promise<void> {
  const config = getConfig();

  if (!config.onboarded) {
    await runOnboarding();
    // Re-read config so provider/model/mode reflect what was just saved
    Object.assign(config, getConfig());
  }

  const model = cliOpts?.model || config.model;
  const mode = (cliOpts?.mode as typeof config.mode) || config.mode;
  let maxTurns = parseInt(cliOpts?.maxTurns || String(config.maxTurns), 10);
  if (isNaN(maxTurns) || maxTurns <= 0) maxTurns = config.maxTurns;
  const provider = resolveProvider(cliOpts?.provider, config.provider, model);
  const cwd = process.cwd();

  // Check required API key for chosen provider
  if (provider === 'openrouter' && !process.env.OPENROUTER_API_KEY) {
    printError('OPENROUTER_API_KEY is not set.');
    printInfo('Run: export OPENROUTER_API_KEY=sk-or-...');
    printInfo('Get a key at: https://openrouter.ai/keys');
    process.exit(1);
  }
  if (provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    printError('ANTHROPIC_API_KEY is not set.');
    printInfo('Run: export ANTHROPIC_API_KEY=sk-ant-...');
    printInfo('Or use OpenRouter: trident --provider openrouter --model openai/gpt-4o');
    process.exit(1);
  }

  printLogo();

  printInfo('Loading project context...');
  const ctx = await loadOrCreateContext(cwd);
  ctx.userName = config.userName;
  const systemPrompt = buildSystemPrompt(ctx, model);

  printSessionHeader({ model, mode, provider, project: ctx.name, hasTridentMd: !!ctx.tridentMdContent });

  if (!ctx.tridentMdContent) {
    printInfo("No TRIDENT.md found. Run 'trident init' to generate one for better AI context.");
  }

  const askUserFn = async (question: string): Promise<string> => {
    const { answer } = await inquirer.prompt([
      { type: 'input', name: 'answer', message: chalk.hex('#00D4FF')(question) },
    ]);
    return answer;
  };

  const budgetUsd = cliOpts?.budget ? parseFloat(cliOpts.budget) : config.budgetUsd;

  // ONE-SHOT MODE
  if (initialTask) {
    await executeTask(initialTask, { model, mode, provider, maxTurns, budgetUsd, systemPrompt, cwd, askUserFn });
    return;
  }

  // INTERACTIVE MODE
  printWelcome();

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  const session = {
    mode, model, provider,
    cost: 0,
    tokens: { input: 0, output: 0 },
    turns: 0,
    budget: budgetUsd,
  };

  // Undo stack — persists across tasks in the session
  const undoStack: UndoEntry[] = [];

  // Task history — list of { task, summary } for /history
  const taskHistory: Array<{ task: string; summary: string; cost: number }> = [];

  // Last task — for /retry
  let lastTask: string | null = null;

  // ─── SLASH COMMAND HANDLER ────────────────────────────────────────────────
  const handleSlash = async (raw: string): Promise<boolean> => {
    const cmd = raw.slice(1).trim();
    const [head, ...rest] = cmd.split(/\s+/);
    const arg = rest.join(' ').trim();

    switch (head.toLowerCase()) {
      // ── Help / Info ────────────────────────────────────────────────────────
      case 'help': case '?':
        printSlashHelp();
        return true;

      case 'clear': case 'cls':
        process.stdout.write('\x1b[2J\x1b[H');
        return true;

      case 'exit': case 'quit': case 'q':
        console.log(chalk.hex('#5EEAD4')('\n🔱 signing off. stay powerful.\n'));
        rl.close(); process.exit(0);
        return true;

      case 'status': case 'cost':
        printStatus({
          model: session.model, provider: session.provider, mode: session.mode,
          cost: session.cost, tokens: session.tokens, turns: session.turns,
        });
        return true;

      case 'history': {
        if (taskHistory.length === 0) {
          printInfo('No tasks run this session yet.');
          return true;
        }
        console.log('');
        console.log('  ' + chalk.hex('#5EEAD4').bold('Session history'));
        for (let i = 0; i < taskHistory.length; i++) {
          const { task, summary, cost } = taskHistory[i];
          console.log('');
          console.log(`  ${chalk.hex('#94A3B8').dim(`${i + 1}.`)} ${chalk.white(task)}`);
          console.log(`     ${chalk.hex('#94A3B8').dim('↳')} ${chalk.hex('#94A3B8')(summary.slice(0, 100))}${summary.length > 100 ? '…' : ''}`);
          console.log(`     ${chalk.hex('#94A3B8').dim('$' + cost.toFixed(4))}`);
        }
        console.log('');
        return true;
      }

      // ── Agent ──────────────────────────────────────────────────────────────
      case 'retry': {
        if (!lastTask) {
          printWarn('No previous task to retry.');
          return true;
        }
        printInfo(`Retrying: ${lastTask}`);
        const result = await executeTask(lastTask, {
          model: session.model, mode: session.mode, provider: session.provider,
          maxTurns, budgetUsd: session.budget, systemPrompt, cwd, askUserFn,
          undoStack,
        });
        if (result) {
          session.cost += result.totalCost;
          session.tokens.input += result.totalTokens.input;
          session.tokens.output += result.totalTokens.output;
          session.turns += result.turns;
          taskHistory.push({ task: lastTask, summary: result.summary, cost: result.totalCost });
        }
        return true;
      }

      case 'replay': {
        if (!arg) {
          printError(`Usage: /replay <n>  (use /history to see task numbers, 1–${taskHistory.length})`);
          return true;
        }
        const replayIdx = parseInt(arg, 10) - 1;
        if (isNaN(replayIdx) || replayIdx < 0 || replayIdx >= taskHistory.length) {
          printError(`No task #${arg}. Run /history to see ${taskHistory.length} available task(s).`);
          return true;
        }
        const taskToReplay = taskHistory[replayIdx].task;
        printInfo(`Replaying task #${parseInt(arg, 10)}: ${taskToReplay}`);
        const replayResult = await executeTask(taskToReplay, {
          model: session.model, mode: session.mode, provider: session.provider,
          maxTurns, budgetUsd: session.budget, systemPrompt, cwd, askUserFn, undoStack,
        });
        if (replayResult) {
          session.cost += replayResult.totalCost;
          session.tokens.input += replayResult.totalTokens.input;
          session.tokens.output += replayResult.totalTokens.output;
          session.turns += replayResult.turns;
          taskHistory.push({ task: taskToReplay, summary: replayResult.summary, cost: replayResult.totalCost });
        }
        return true;
      }

      case 'undo': {
        if (undoStack.length === 0) {
          printWarn('Nothing to undo.');
          return true;
        }
        const entry = undoStack.pop()!;
        try {
          if (entry.originalContent === null) {
            await fsUnlink(entry.path);
            printSuccess(`Undo: deleted ${entry.path}`);
          } else {
            await fsWriteFile(entry.path, entry.originalContent, 'utf-8');
            printSuccess(`Undo: restored ${entry.path}`);
          }
        } catch (err) {
          printError(`Undo failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return true;
      }

      case 'compact': {
        if (taskHistory.length === 0) {
          printInfo('No history to compact.');
          return true;
        }
        const kept = taskHistory.splice(-3); // keep last 3
        taskHistory.length = 0;
        taskHistory.push(...kept);
        undoStack.length = 0;
        printSuccess(`Compacted — kept last ${kept.length} task(s), undo stack cleared.`);
        return true;
      }

      case 'save': {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = arg || `trident-session-${ts}.md`;
        const lines: string[] = [
          `# TRIDENT Session — ${new Date().toLocaleString()}`,
          '',
          `**Model:** ${session.model}  |  **Provider:** ${session.provider}  |  **Mode:** ${session.mode}`,
          `**Total cost:** $${session.cost.toFixed(4)}  |  **Tokens:** ${(session.tokens.input + session.tokens.output).toLocaleString()}  |  **Turns:** ${session.turns}`,
          '',
          '## Tasks',
          '',
        ];
        for (let i = 0; i < taskHistory.length; i++) {
          const { task, summary, cost } = taskHistory[i];
          lines.push(`### ${i + 1}. ${task}`);
          lines.push(`> ${summary}`);
          lines.push(`*Cost: $${cost.toFixed(4)}*`);
          lines.push('');
        }
        try {
          await fsWriteFile(join(cwd, filename), lines.join('\n'), 'utf-8');
          printSuccess(`Saved session to ${filename}`);
        } catch (err) {
          printError(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return true;
      }

      // ── Project ────────────────────────────────────────────────────────────
      case 'init': {
        const generated = await generateTridentMd(ctx, cwd);
        ctx.tridentMdContent = generated;
        printSuccess('Generated TRIDENT.md');
        return true;
      }

      case 'context':
        if (!ctx.tridentMdContent) {
          printWarn('No TRIDENT.md in current directory. Run /init to create one.');
        } else {
          console.log('');
          console.log(chalk.hex('#94A3B8').dim('─'.repeat(60)));
          console.log(ctx.tridentMdContent);
          console.log(chalk.hex('#94A3B8').dim('─'.repeat(60)));
        }
        return true;

      case 'tree': {
        printInfo('Scanning project...');
        const tree = await generateProjectTree(cwd);
        console.log('');
        console.log(chalk.hex('#5EEAD4').bold('  Project tree'));
        for (const line of tree.split('\n')) {
          console.log('  ' + chalk.hex('#94A3B8')(line));
        }
        console.log('');
        return true;
      }

      case 'cwd':
        printInfo(`Working directory: ${chalk.white(cwd)}`);
        return true;

      // ── Config ─────────────────────────────────────────────────────────────
      case 'mode': {
        if (!arg || !/^(yolo|review|lockdown)$/i.test(arg)) {
          printError('Usage: /mode yolo | review | lockdown');
          return true;
        }
        session.mode = arg.toLowerCase() as typeof session.mode;
        printSuccess(`mode → ${session.mode.toUpperCase()}`);
        return true;
      }
      case 'yolo':     session.mode = 'yolo';     printSuccess('mode → YOLO');     return true;
      case 'safe':     session.mode = 'review';   printSuccess('mode → REVIEW');   return true;
      case 'lock':     session.mode = 'lockdown'; printSuccess('mode → LOCKDOWN'); return true;

      case 'provider': {
        if (!arg || !/^(anthropic|openrouter)$/i.test(arg)) {
          printError('Usage: /provider anthropic | openrouter');
          return true;
        }
        session.provider = arg.toLowerCase() as ProviderName;
        printSuccess(`provider → ${session.provider}`);
        return true;
      }

      case 'model': {
        if (!arg) { printError('Usage: /model <name>'); return true; }
        session.model = arg;
        if (session.model.includes('/')) session.provider = 'openrouter';
        printSuccess(`model → ${session.model} (${session.provider})`);
        return true;
      }

      case 'budget': {
        if (!arg) {
          if (session.budget != null && session.budget > 0) {
            const remaining = Math.max(0, session.budget - session.cost);
            printInfo(`Budget: $${session.budget.toFixed(2)}  |  spent: $${session.cost.toFixed(4)}  |  remaining: $${remaining.toFixed(4)}`);
          } else {
            printInfo('No budget set. Use /budget <usd> to set one (e.g. /budget 1.00).');
          }
        } else {
          const b = parseFloat(arg);
          if (isNaN(b) || b <= 0) {
            printError('Usage: /budget <usd>  (e.g. /budget 1.00)');
          } else {
            session.budget = b;
            printSuccess(`Budget → $${b.toFixed(2)}`);
          }
        }
        return true;
      }

      case 'version': case 'v':
        printInfo(`TRIDENT CLI v1.0.0`);
        return true;

      case 'tools': {
        const TEAL_T = '#5EEAD4';
        const SLATE_T = '#94A3B8';
        console.log('');
        console.log('  ' + chalk.hex(TEAL_T).bold('Available agent tools'));
        console.log('');
        for (const tool of (await import('./agent/tools.js')).TOOL_DEFINITIONS) {
          console.log(`    ${chalk.hex(TEAL_T)(tool.name.padEnd(22))} ${chalk.hex(SLATE_T)(tool.description)}`);
        }
        console.log('');
        return true;
      }

      case 'logging': {
        if (!arg) {
          printInfo(`Session logging is ${config.logSessions ? 'ON' : 'OFF'}. Use /logging on|off to change.`);
        } else if (arg === 'on') {
          setConfig('logSessions', true);
          printSuccess('Session logging → ON');
        } else if (arg === 'off') {
          setConfig('logSessions', false);
          printSuccess('Session logging → OFF');
        } else {
          printError('Usage: /logging on | off');
        }
        return true;
      }

      case 'models':
        await program.commands.find(c => c.name() === 'models')?.parseAsync([], { from: 'user' });
        return true;

      case 'sessions': {
        const { homedir } = await import('os');
        const { readdir } = await import('fs/promises');
        const logDir = join(homedir(), '.trident', 'logs');
        if (!existsSync(logDir)) { printInfo('No sessions yet.'); return true; }
        const files = (await readdir(logDir)).sort().reverse().slice(0, 10);
        if (files.length === 0) { printInfo('No sessions yet.'); return true; }
        console.log('');
        console.log('  ' + chalk.hex('#5EEAD4').bold('Recent sessions'));
        for (const f of files) console.log('    ' + chalk.dim(f.replace('.jsonl', '')));
        console.log('');
        return true;
      }

      default:
        printWarn(`Unknown command: /${head}. Type / + Enter for a menu, or /help for the list.`);
        return true;
    }
  };

  // ─── PROMPT LOOP ─────────────────────────────────────────────────────────
  const promptLoop = (): void => {
    printPrompt();
    rl.once('line', async (input) => {
      const task = input.trim();
      if (!task) { promptLoop(); return; }

      // Bare "/" → show numbered command menu
      if (task === '/') {
        await showCommandPicker(rl, handleSlash);
        promptLoop();
        return;
      }

      // Slash commands
      if (task.startsWith('/')) {
        await handleSlash(task);
        promptLoop(); return;
      }

      // Backwards-compat shorthands without "/"
      if (/^(exit|quit)$/i.test(task)) { await handleSlash('/exit'); return; }
      if (/^init$/i.test(task)) { await handleSlash('/init'); promptLoop(); return; }

      lastTask = task;

      const result = await executeTask(task, {
        model: session.model,
        mode: session.mode,
        provider: session.provider,
        maxTurns,
        budgetUsd: session.budget,
        systemPrompt,
        cwd,
        askUserFn,
        undoStack,
      });

      if (result) {
        session.cost += result.totalCost;
        session.tokens.input += result.totalTokens.input;
        session.tokens.output += result.totalTokens.output;
        session.turns += result.turns;
        taskHistory.push({ task, summary: result.summary, cost: result.totalCost });
      }

      promptLoop();
    });
  };

  promptLoop();

  rl.on('close', () => {
    console.log(chalk.hex('#5EEAD4')('\n🔱 signing off.\n'));
    process.exit(0);
  });
}

async function executeTask(
  task: string,
  opts: {
    model: string;
    provider: ProviderName;
    mode: 'yolo' | 'review' | 'lockdown';
    maxTurns: number;
    budgetUsd?: number;
    systemPrompt: string;
    cwd: string;
    askUserFn: (q: string) => Promise<string>;
    undoStack?: UndoEntry[];
  }
): Promise<Awaited<ReturnType<typeof runAgentLoop>> | null> {
  const taskConfig = getConfig();
  printSectionHeader(`FORGE · ${opts.provider} · ${opts.model}`);
  console.log(chalk.dim(`  ${task}`));
  console.log('');

  const sessionId = randomUUID();

  let budgetWarned = false;

  const onToolStart = async (call: import('./agent/tools.js').ToolCall): Promise<void> => {
    // Snapshot file content before mutating operations for undo support
    if (opts.undoStack && (call.name === 'write_file' || call.name === 'edit_file'
      || call.name === 'delete_file' || call.name === 'move_file')) {
      const snapPath = call.name === 'move_file'
        ? pathResolve(opts.cwd, call.input.dest as string)
        : pathResolve(opts.cwd, call.input.path as string);
      let originalContent: string | null = null;
      try {
        originalContent = await fsReadFile(snapPath, 'utf-8');
      } catch { /* file doesn't exist yet */ }
      opts.undoStack.push({ path: snapPath, originalContent });
    }
    printToolStart(call);
  };

  try {
    const result = await runAgentLoop(task, {
      cwd: opts.cwd,
      mode: opts.mode,
      model: opts.model,
      provider: opts.provider,
      systemPrompt: opts.systemPrompt,
      maxTurns: opts.maxTurns,
      budgetUsd: opts.budgetUsd,
      logSessions: taskConfig.logSessions,
      commandTimeout: taskConfig.commandTimeout,
      searchMaxFiles: taskConfig.searchMaxFiles,
      parallelTools: taskConfig.parallelTools,
      disabledTools: taskConfig.disabledTools,
      sessionId,
      onText: printAgentText,
      onToolStart,
      onToolEnd: printToolEnd,
      onCostUpdate: (cost) => {
        if (opts.budgetUsd && !budgetWarned && cost >= opts.budgetUsd * 0.75 && cost < opts.budgetUsd) {
          budgetWarned = true;
          const pct = Math.round((cost / opts.budgetUsd) * 100);
          printWarn(`Budget: ${pct}% used ($${cost.toFixed(4)} of $${opts.budgetUsd.toFixed(2)})`);
        }
      },
      askUserFn: opts.askUserFn,
    });

    printFinalSummary(result);
    return result;
  } catch (err) {
    console.log('');
    printError(err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ─── GLOBAL CRASH PROTECTION ──────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('');
  printError(`Unexpected error: ${err.message}`);
  printInfo('Run "trident heal" to diagnose issues, or report at https://github.com/trident-cli/trident');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('');
  printError(`Unhandled async error: ${msg}`);
  printInfo('Run "trident heal" to diagnose issues.');
  process.exit(1);
});

program.parse();
