#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import { execa } from 'execa';
import { readFile as fsReadFile, writeFile as fsWriteFile, unlink as fsUnlink } from 'fs/promises';

import { getConfig, getRawConfig, getDefaultConfig, resetConfigToDefaults, setConfig, deleteConfig, getConfigPath, ConfigSchema } from './config.js';
import type { TridentConfig } from './config.js';
import { runOnboarding } from './ui/onboarding.js';
import { loadOrCreateContext, generateTridentMd, buildSystemPrompt, generateProjectTree, loadMemory, clearMemory } from './oracle/index.js';
import { runAgentLoop, getContextLimit, type ProviderName as AgentProviderName } from './agent/loop.js';
import { resolveWorkspacePath } from './agent/tools.js';
import { listOpenRouterModels } from './providers/openrouter.js';
import { codexSandboxForMode, isCodexCliAvailable, runCodexExec } from './providers/codex.js';
import { formatProfileNames, listTrainedProfiles, resolveProfile, type TrainedProfile } from './profiles.js';
import { loadHooks, runHook, type HooksConfig } from './warden/index.js';
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
  printCostUpdate,
} from './ui/renderer.js';

const program = new Command();

type TridentProviderName = AgentProviderName | 'codex';

program
  .name('trident')
  .description('TRIDENT - All-Powerful Agentic AI Coding CLI')
  .version('1.0.0');

program
  .argument('[task]', 'Task to execute (omit for interactive mode)')
  .option('-m, --model <model>', 'Model to use')
  .option('-p, --provider <provider>', 'Provider: anthropic | openrouter | codex')
  .option('--mode <mode>', 'Approval mode: yolo | review | lockdown')
  .option('--max-turns <n>', 'Max agent loop iterations', '50')
  .option('--budget <usd>', 'Max budget in USD')
  .option('--profile <name>', `Trained profile: ${formatProfileNames()}`)
  .option('--system-override <text>', 'Operator system override appended to the agent prompt')
  .option('--codex-model <model>', 'Codex CLI model override (provider=codex only)')
  .option('--codex-timeout <ms>', 'Codex CLI timeout in milliseconds')
  .option('--thinking', 'Enable extended thinking (Anthropic only)')
  .action(async (task?: string, opts?: {
    model?: string;
    provider?: string;
    mode?: string;
    maxTurns?: string;
    budget?: string;
    profile?: string;
    systemOverride?: string;
    codexModel?: string;
    codexTimeout?: string;
    thinking?: boolean;
  }) => {
    await runTrident(task, opts);
  });

program
  .command('init')
  .description('Generate TRIDENT.md for the current project')
  .action(async () => {
    printLogo();
    printInfo('Scanning project...');
    const cwd = process.cwd();
    const ctx = await loadOrCreateContext(cwd);
    await generateTridentMd(ctx, cwd);
    printSuccess('Generated TRIDENT.md - edit it to customize AI behavior.');
  });

program
  .command('models')
  .description('List available models for each provider')
  .action(() => {
    printAvailableModels();
  });

program
  .command('profiles')
  .description('List Codex-trained TRIDENT profiles')
  .action(() => {
    printAvailableProfiles();
  });

program
  .command('code-review')
  .description('AI-powered code review for a specific file')
  .argument('<file>', 'File to review')
  .option('-m, --model <model>', 'Model to use')
  .option('-p, --provider <provider>', 'Provider: anthropic | openrouter')
  .action(async (file: string, opts: { model?: string; provider?: string }) => {
    const cwd = process.cwd();
    printLogo();
    printInfo(`Reviewing ${file}...`);

    let fileContent: string;
    try {
      const { resolveWorkspacePath: rwp } = await import('./agent/tools.js');
      fileContent = await fsReadFile(rwp(cwd, file), 'utf-8');
    } catch (err) {
      printError(`Cannot read file: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
      return;
    }

    let cfg: TridentConfig;
    try { cfg = getConfig(); } catch { cfg = getDefaultConfig() as TridentConfig; }

    const provider = resolveProvider(opts.provider, cfg.provider) as 'anthropic' | 'openrouter';
    const model = opts.model || cfg.model;

    const envKey = provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY';
    if (!process.env[envKey]) {
      printError(`${envKey} is not set.`);
      process.exit(1);
      return;
    }

    const reviewPrompt = `You are an expert code reviewer. Analyse the following file and produce a structured review.

File: ${file}
\`\`\`
${fileContent.slice(0, 30000)}
\`\`\`

Respond in this exact structure:

## Summary
One-paragraph overview of what the file does.

## Issues
For each issue, format as:
- **[SEVERITY]** \`location\` — description and recommended fix
  Severity levels: CRITICAL | HIGH | MEDIUM | LOW | STYLE

## Positives
Bullet-point list of good practices observed.

## Recommendations
Prioritised action items to improve the file.`;

    const { streamCompletion: sc } = await import('./providers/anthropic.js');
    const { streamOpenRouter: sor } = await import('./providers/openrouter.js');

    console.log('');
    console.log('  ' + chalk.hex('#5EEAD4').bold('> CODE REVIEW') + '  ' + chalk.dim(file));
    console.log('');

    const spinner = ora({ text: chalk.dim('analysing...'), color: 'cyan' }).start();
    let firstToken = true;

    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [{ role: 'user', content: reviewPrompt }];
    const stream = provider === 'openrouter'
      ? sor(messages as never, { model, maxTokens: 4096, systemPrompt: 'You are an expert code reviewer.', tools: [], apiKey: process.env.OPENROUTER_API_KEY || '' })
      : sc(messages as never, { model, maxTokens: 4096, systemPrompt: 'You are an expert code reviewer.', tools: [] });

    for await (const chunk of stream) {
      if (chunk.type === 'text' && chunk.text) {
        if (firstToken) { spinner.stop(); process.stdout.write('\r\x1b[K'); firstToken = false; }
        process.stdout.write(chalk.white(chunk.text));
      }
    }

    if (firstToken) spinner.stop();
    console.log('\n');
  });

program
  .command('train')
  .description('Prepare the five Codex-powered TRIDENT profiles')
  .option('--set-default <profile>', 'Set provider=codex and choose a default trained profile')
  .action(async (opts: { setDefault?: string }) => {
    printLogo();
    console.log(chalk.cyan('\nTRIDENT Profile Training\n'));
    printInfo('Training here means installing prompt-trained operating profiles; it does not fine-tune model weights.');

    const codexReady = await isCodexCliAvailable();
    if (codexReady) {
      printSuccess('Codex CLI is available.');
    } else {
      printWarn('Codex CLI was not found or did not respond to "codex --version".');
    }

    printAvailableProfiles();

    if (opts.setDefault) {
      const profile = resolveProfile(opts.setDefault);
      if (!profile) {
        printError(`Unknown profile "${opts.setDefault}". Valid profiles: ${formatProfileNames()}`);
        process.exit(1);
      }
      setConfig('provider', 'codex');
      setConfig('profile', profile.name);
      printSuccess(`Default Codex profile set to ${profile.name}`);
    }
  });

program
  .command('config')
  .description('Show or set configuration')
  .argument('[key]', 'Config key')
  .argument('[value]', 'Value to set')
  .action((key?: string, value?: string) => {
    const rawConfig = getRawConfig();
    const validKeys = Object.keys(ConfigSchema.shape);

    if (!key) {
      const parsed = ConfigSchema.safeParse(rawConfig);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const path = issue.path.length > 0 ? issue.path.join('.') : 'config';
        console.log(chalk.red(`Invalid config at ${path}: ${issue.message}`));
        console.log(chalk.dim(`Config path: ${getConfigPath()}`));
        console.log(chalk.dim('Run: trident heal --reset-config'));
        process.exit(1);
      }

      console.log(chalk.cyan('\nTRIDENT Configuration\n'));
      console.log(JSON.stringify(parsed.data, null, 2));
      console.log(chalk.dim(`\nConfig path: ${getConfigPath()}\n`));
      return;
    }

    if (!validKeys.includes(key)) {
      console.log(chalk.red(`Unknown config key: "${key}". Valid keys: ${validKeys.join(', ')}`));
      process.exit(1);
    }

    if (key && value !== undefined) {
      let parsed: unknown = value;
      if (value === 'true') parsed = true;
      else if (value === 'false') parsed = false;
      else if (/^\s*[\[{]/.test(value)) {
        try {
          parsed = JSON.parse(value);
        } catch {
          console.log(chalk.red(`Invalid JSON value for ${key}: "${value}"`));
          process.exit(1);
        }
      } else if (!Number.isNaN(Number(value))) parsed = Number(value);

      if (key === 'profile') {
        if (/^(clear|unset|none)$/i.test(value)) {
          deleteConfig('profile');
          console.log(chalk.green('Cleared profile'));
          return;
        }
        const profile = resolveProfile(value);
        if (!profile) {
          console.log(chalk.red(`Invalid value for profile: "${value}". Must be one of: ${formatProfileNames()}`));
          process.exit(1);
        }
        parsed = profile.name;
      }

      if (key === 'systemOverride' && /^(clear|unset|none)$/i.test(value)) {
        parsed = '';
      }

      if (key === 'codexModel' && /^(clear|unset|none)$/i.test(value)) {
        parsed = '';
      }

      if (key === 'codexTimeoutMs') {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) {
          console.log(chalk.red(`Invalid value for codexTimeoutMs: "${value}". Must be a positive integer.`));
          process.exit(1);
        }
      }

      if (key === 'mode' && !['yolo', 'review', 'lockdown'].includes(value.toLowerCase())) {
        console.log(chalk.red(`Invalid value for mode: "${value}". Must be one of: yolo, review, lockdown`));
        process.exit(1);
      }

      if (key === 'mode') {
        parsed = value.toLowerCase();
      }

      if (key === 'maxTurns') {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) {
          console.log(chalk.red(`Invalid value for maxTurns: "${value}". Must be a positive integer.`));
          process.exit(1);
        }
      }

      if (key === 'budgetUsd') {
        if (/^(clear|unset|none)$/i.test(value)) {
          deleteConfig('budgetUsd');
          console.log(chalk.green('Cleared budgetUsd'));
          return;
        }

        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) {
          console.log(chalk.red(`Invalid value for budgetUsd: "${value}". Must be a positive number.`));
          process.exit(1);
        }
      }

      if (key === 'provider' && !['anthropic', 'openrouter', 'codex'].includes(value.toLowerCase())) {
        console.log(chalk.red(`Invalid value for provider: "${value}". Must be one of: anthropic, openrouter, codex`));
        process.exit(1);
      }

      if (key === 'provider') {
        parsed = value.toLowerCase();
      }

      const candidate = { ...getDefaultConfig(), ...rawConfig, [key]: parsed };
      const validated = ConfigSchema.safeParse(candidate);
      if (!validated.success) {
        const issue = validated.error.issues[0];
        const path = issue.path.length > 0 ? issue.path.join('.') : key;
        console.log(chalk.red(`Invalid value for ${path}: ${issue.message}`));
        if (key === 'theme') {
          console.log(chalk.dim('Example: trident config theme {"primary":"#00D4FF","accent":"#FFD700","danger":"#FF4444"}'));
        }
        process.exit(1);
      }

      setConfig(key as keyof TridentConfig, parsed);
      console.log(chalk.green(`Set ${key} = ${value}`));
      return;
    }

    const parsed = ConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue.path.length > 0 ? issue.path.join('.') : 'config';
      console.log(chalk.red(`Invalid config at ${path}: ${issue.message}`));
      console.log(chalk.dim('Run: trident heal --reset-config'));
      process.exit(1);
    }

    console.log(`${key}: ${JSON.stringify(parsed.data[key as keyof typeof parsed.data])}`);
  });

program
  .command('doctor')
  .description('Check environment and dependencies')
  .action(async () => {
    printLogo();
    console.log(chalk.cyan('\nTRIDENT Doctor\n'));

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
        console.log(`  ${chalk.green('OK')} ${check.name}: ${chalk.dim(result.stdout.split('\n')[0])}`);
      } catch {
        console.log(`  ${chalk.red('NO')} ${check.name}: ${chalk.red('NOT FOUND')}`);
      }
    }

    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;
    const hasCodexCli = await isCodexCliAvailable();

    console.log('');
    console.log(`  ${hasAnthropic ? chalk.green('OK') : chalk.red('NO')} ANTHROPIC_API_KEY:  ${hasAnthropic ? chalk.green('set') : chalk.red('NOT SET')}`);
    console.log(`  ${hasOpenRouter ? chalk.green('OK') : chalk.yellow('--')} OPENROUTER_API_KEY: ${hasOpenRouter ? chalk.green('set') : chalk.yellow('not set (optional)')}`);
    console.log(`  ${hasCodexCli ? chalk.green('OK') : chalk.yellow('--')} Codex CLI:          ${hasCodexCli ? chalk.green('available') : chalk.yellow('not available')}`);

    if (!hasAnthropic && !hasOpenRouter && !hasCodexCli) {
      console.log(chalk.yellow('\n  Set at least one API key:'));
      console.log(chalk.dim(`    ${formatEnvAssignment('ANTHROPIC_API_KEY', 'sk-ant-...')}`));
      console.log(chalk.dim(`    ${formatEnvAssignment('OPENROUTER_API_KEY', 'sk-or-...')}`));
      console.log(chalk.dim('    Or install/login to Codex CLI for provider=codex.'));
    }

    console.log('');
    if (hasAnthropic || hasOpenRouter || hasCodexCli) {
      console.log(chalk.green('  TRIDENT is ready!\n'));
    } else {
      console.log(chalk.red('  Set at least one provider path to use TRIDENT.\n'));
    }
  });

program
  .command('review')
  .description('Review the last session action log')
  .action(async () => {
    const files = await getRecentSessionLogFiles();
    if (files.length === 0) {
      printError('No session logs found.');
      return;
    }

    const loaded = await loadLatestReviewableSession(files);
    if (!loaded) {
      printError('No readable session logs found.');
      return;
    }

    console.log(chalk.cyan(`\nSession: ${loaded.file.replace('.jsonl', '')}\n`));
    for (const entry of loaded.entries) {
      const icon = entry.approved ? chalk.green('OK') : chalk.red('NO');
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
    console.log(chalk.hex('#00D4FF').bold('\nTRIDENT Heal\n'));

    let issues = 0;
    let fixed = 0;

    const nodeMajor = parseInt(process.version.slice(1).split('.')[0], 10);
    if (nodeMajor < 18) {
      console.log(`  ${chalk.red('NO')} Node.js ${process.version} - requires v18+`);
      issues++;
    } else {
      console.log(`  ${chalk.green('OK')} Node.js ${process.version}`);
    }

    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;
    const hasCodexCli = await isCodexCliAvailable();
    if (!hasAnthropic && !hasOpenRouter && !hasCodexCli) {
      console.log(`  ${chalk.red('NO')} No provider path available`);
      console.log(chalk.dim(`    Use ${formatEnvAssignment('ANTHROPIC_API_KEY', 'sk-ant-...')} or ${formatEnvAssignment('OPENROUTER_API_KEY', 'sk-or-...')}`));
      console.log(chalk.dim('    Or install/login to Codex CLI for provider=codex.'));
      issues++;
    } else {
      if (hasAnthropic) console.log(`  ${chalk.green('OK')} ANTHROPIC_API_KEY set`);
      if (hasOpenRouter) console.log(`  ${chalk.green('OK')} OPENROUTER_API_KEY set`);
      if (hasCodexCli) console.log(`  ${chalk.green('OK')} Codex CLI available`);
    }

    try {
      ConfigSchema.parse(getRawConfig());
      console.log(`  ${chalk.green('OK')} Config valid (${getConfigPath()})`);
    } catch (err) {
      console.log(`  ${chalk.red('NO')} Config invalid: ${err instanceof Error ? err.message : String(err)}`);
      issues++;
      if (opts.resetConfig) {
        resetConfigToDefaults();
        console.log(`  ${chalk.green('OK')} Config reset to defaults`);
        fixed++;
      } else {
        console.log(chalk.dim('    Run: trident heal --reset-config'));
      }
    }

    const cwd = process.cwd();
    const tridentMdPath = join(cwd, 'TRIDENT.md');
    if (!existsSync(tridentMdPath)) {
      console.log(`  ${chalk.yellow('WARN')} No TRIDENT.md in current directory`);
      if (opts.regenMd) {
        const ctx = await loadOrCreateContext(cwd);
        await generateTridentMd(ctx, cwd);
        console.log(`  ${chalk.green('OK')} Generated TRIDENT.md`);
        fixed++;
      } else {
        console.log(chalk.dim('    Run: trident heal --regen-md'));
      }
    } else {
      console.log(`  ${chalk.green('OK')} TRIDENT.md present`);
    }

    try {
      const shellCmd = process.platform === 'win32' ? 'cmd' : 'bash';
      const shellFlag = process.platform === 'win32' ? '/c' : '-c';
      const { stdout } = await execa(shellCmd, [shellFlag, 'echo ok'], { reject: true });
      if (stdout.trim() === 'ok') {
        console.log(`  ${chalk.green('OK')} Shell (${shellCmd}) available`);
      }
    } catch {
      console.log(`  ${chalk.yellow('WARN')} Shell not available - run_command may not work`);
    }

    console.log('');
    if (issues === 0) {
      console.log(chalk.green('  TRIDENT is healthy! No issues found.\n'));
    } else if (fixed > 0) {
      console.log(chalk.yellow(`  Found ${issues} issue(s), fixed ${fixed}. Re-run to verify.\n`));
    } else {
      console.log(chalk.red(`  Found ${issues} issue(s). See suggestions above.\n`));
    }
  });

function resolveProvider(cliProvider?: string, configProvider?: string, model?: string): TridentProviderName {
  const provider = cliProvider?.toLowerCase();
  if (provider === 'openrouter') return 'openrouter';
  if (provider === 'anthropic') return 'anthropic';
  if (provider === 'codex') return 'codex';
  if (model && model.includes('/')) return 'openrouter';
  if (configProvider === 'openrouter' || configProvider === 'anthropic' || configProvider === 'codex') {
    return configProvider;
  }
  return 'anthropic';
}

interface UndoEntry {
  path: string;
  originalContent: string | null;
}

interface BackgroundTask {
  id: number;
  task: string;
  status: 'running' | 'done' | 'failed';
  summary?: string;
  cost?: number;
}

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
        { cmd: '/help', desc: 'show all slash commands' },
        { cmd: '/status', desc: 'model / provider / mode / cost' },
        { cmd: '/history', desc: 'tasks run this session' },
        { cmd: '/clear', desc: 'clear the screen' },
        { cmd: '/exit', desc: 'quit trident' },
      ],
    },
    {
      label: 'Agent',
      entries: [
        { cmd: '/retry', desc: 're-run the last task' },
        { cmd: '/undo', desc: 'revert last file write or edit' },
        { cmd: '/snapshot', desc: 'git stash current state as a named snapshot' },
        { cmd: '/resume', desc: 'load a past session as context' },
        { cmd: '/replay', desc: 're-execute approved tool calls from a past session' },
        { cmd: '/compact', desc: 'AI-summarise and trim session history' },
        { cmd: '/save', desc: 'save session transcript to a .md file' },
        { cmd: '/budget', desc: 'show, set, or clear session budget' },
        { cmd: '/profile', desc: 'show or switch trained profile' },
        { cmd: '/override', desc: 'show or set system override' },
        { cmd: '/memory', desc: 'show persistent agent memory' },
        { cmd: '/forget', desc: 'clear all agent memory' },
        { cmd: '/plan', desc: 'toggle plan-before-act mode' },
        { cmd: '/queue', desc: 'manage sequential task queue' },
        { cmd: '/autotest', desc: 'toggle auto-test after file writes' },
        { cmd: '/autoformat', desc: 'toggle auto-format after file writes' },
        { cmd: '/think', desc: 'toggle extended thinking on/off' },
        { cmd: '/jobs', desc: 'list background tasks' },
      ],
    },
    {
      label: 'Project',
      entries: [
        { cmd: '/search', desc: 'quick codebase search (--regex for regex mode)' },
        { cmd: '/git', desc: 'run a git command (default: status)' },
        { cmd: '/diff', desc: 'show git diff (optional: file path)' },
        { cmd: '/pin', desc: 'pin a file into system prompt context' },
        { cmd: '/unpin', desc: 'unpin a file (or /unpin all)' },
        { cmd: '/pinned', desc: 'list pinned files' },
        { cmd: '/init', desc: 'generate TRIDENT.md' },
        { cmd: '/context', desc: 'show TRIDENT.md contents' },
        { cmd: '/tree', desc: 'show project file tree' },
        { cmd: '/cwd', desc: 'show working directory' },
      ],
    },
    {
      label: 'Config',
      entries: [
        { cmd: '/yolo', desc: 'mode -> YOLO (approve all)' },
        { cmd: '/safe', desc: 'mode -> REVIEW (confirm writes)' },
        { cmd: '/lock', desc: 'mode -> LOCKDOWN (confirm everything)' },
        { cmd: '/models', desc: 'list available models' },
        { cmd: '/profiles', desc: 'list trained profiles' },
        { cmd: '/sessions', desc: 'list past session log files' },
      ],
    },
  ];

  console.log('');
  console.log('  ' + chalk.hex(TEAL).bold('Command menu'));
  console.log('');

  let n = 1;
  const numToCmd: Record<number, string> = {};

  for (const { label, entries } of groups) {
    console.log('  ' + chalk.hex(AMBER).dim(`-- ${label} --`));
    for (const { cmd, desc } of entries) {
      numToCmd[n] = cmd;
      const num = chalk.hex(SLATE).dim(String(n).padStart(2));
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
      if (!Number.isNaN(chosen) && numToCmd[chosen]) {
        await handleSlash(numToCmd[chosen]);
      }
      resolve();
    });
  });
}

async function runTrident(
  initialTask?: string,
  cliOpts?: {
    model?: string;
    provider?: string;
    mode?: string;
    maxTurns?: string;
    budget?: string;
    profile?: string;
    systemOverride?: string;
    codexModel?: string;
    codexTimeout?: string;
    thinking?: boolean;
  }
): Promise<void> {
  let config: TridentConfig;
  try {
    config = getConfig();
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    printInfo(`Config path: ${getConfigPath()}`);
    printInfo('Run "trident heal --reset-config" to recover the config.');
    process.exit(1);
    return;
  }

  if (!config.onboarded) {
    await runOnboarding();
    Object.assign(config, getConfig());
  }

  let activeProfile = resolveConfiguredProfile(cliOpts?.profile, config.profile);
  let systemOverride = cliOpts?.systemOverride ?? config.systemOverride;
  const mode = (cliOpts?.mode as typeof config.mode) || config.mode;
  let maxTurns = parseInt(cliOpts?.maxTurns || String(config.maxTurns), 10);
  if (Number.isNaN(maxTurns) || maxTurns <= 0) maxTurns = config.maxTurns;
  const budgetUsd = resolveBudget(cliOpts?.budget, config.budgetUsd);
  const provider = resolveProvider(cliOpts?.provider, config.provider, cliOpts?.model || config.model);
  const apiModel = cliOpts?.model || config.model;
  const codexModel = cliOpts?.codexModel ?? config.codexModel;
  const model = provider === 'codex' ? (codexModel || 'codex default') : apiModel;
  const codexTimeoutMs = resolvePositiveInteger(cliOpts?.codexTimeout, config.codexTimeoutMs, 'codex timeout');
  const cwd = process.cwd();

  printLogo();

  printInfo('Loading project context...');
  const ctx = await loadOrCreateContext(cwd);

  // Load hooks
  const hooks: HooksConfig = await loadHooks(cwd);

  // Pinned files: path -> content, always injected into system prompt
  const pinnedFiles = new Map<string, string>();
  const getPinnedContext = (): string => {
    if (pinnedFiles.size === 0) return '';
    const parts = ['## Pinned Files (always in context)\n'];
    for (const [filePath, content] of pinnedFiles) {
      const ext = filePath.split('.').pop() || '';
      parts.push(`### ${filePath}\n\`\`\`${ext}\n${content.slice(0, 8000)}\n\`\`\``);
    }
    return parts.join('\n\n');
  };

  const getSystemPrompt = (): string => {
    const memorySection = sessionMemory.trim()
      ? `\n\n## Agent Memory\n${sessionMemory.trim()}`
      : '';
    const planSection = session.planMode
      ? '\n\n## Plan Mode\nBefore taking any action, produce a numbered plan and wait for the user to confirm or refine it. Only proceed with tool calls after the plan is accepted.'
      : '';
    return buildSystemPrompt(ctx, {
      profile: activeProfile,
      systemOverride: [systemOverride, getPinnedContext(), memorySection + planSection].filter(Boolean).join('\n\n'),
    });
  };

  printSessionHeader({ model, mode, provider, project: ctx.name, hasTridentMd: !!ctx.tridentMdContent, profile: activeProfile?.name });

  if (!ctx.tridentMdContent) {
    printInfo("No TRIDENT.md found. Run 'trident init' to generate one for better AI context.");
  }

  const askUserFn = async (question: string): Promise<string> => {
    const { answer } = await inquirer.prompt([
      { type: 'input', name: 'answer', message: chalk.hex('#00D4FF')(question) },
    ]);
    return answer;
  };

  const ensureProviderReady = async (providerToCheck: TridentProviderName, soft = false): Promise<boolean> => {
    if (providerToCheck === 'codex') {
      if (await isCodexCliAvailable()) {
        return true;
      }
      printError('Codex CLI is not available.');
      printInfo('Run: codex --version');
      printInfo('If Codex is installed but stale in this shell, open a new terminal or repair the global npm shim.');
      if (!soft) {
        process.exit(1);
      }
      return false;
    }

    const envKey = providerToCheck === 'openrouter' ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY';
    const example = providerToCheck === 'openrouter' ? 'sk-or-...' : 'sk-ant-...';
    const fallbackModel = providerToCheck === 'anthropic' ? 'openai/gpt-4o' : 'claude-sonnet-4-6';

    if (process.env[envKey]) {
      return true;
    }

    printError(`${envKey} is not set.`);
    printInfo(`Run: ${formatEnvAssignment(envKey, example)}`);
    if (providerToCheck === 'anthropic') {
      printInfo(`Or use OpenRouter: trident --provider openrouter --model ${fallbackModel}`);
    } else {
      printInfo('Get a key at: https://openrouter.ai/keys');
    }

    if (!soft) {
      process.exit(1);
    }
    return false;
  };

  await ensureProviderReady(provider);

  if (initialTask) {
    if (hooks.on_task_start) await runHook(hooks.on_task_start, cwd);
    await executeTask(initialTask, {
      model,
      mode,
      provider,
      maxTurns,
      budgetUsd,
      logSessions: config.logSessions,
      systemPrompt: getSystemPrompt(),
      profile: activeProfile,
      codexTimeoutMs,
      cwd,
      askUserFn,
      thinking: cliOpts?.thinking ?? false,
      hooks,
    });
    if (hooks.on_task_end) await runHook(hooks.on_task_end, cwd);
    return;
  }

  printWelcome();

  let sessionMemory = await loadMemory();

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const session = {
    mode,
    model,
    provider,
    profile: activeProfile?.name,
    systemOverride,
    cost: 0,
    tokens: { input: 0, output: 0 },
    turns: 0,
    budgetUsd: budgetUsd ?? config.budgetUsd,
    planMode: false,
    autoTest: false,
    autoFormat: false,
    thinking: false,
  };
  const taskQueue: string[] = [];
  const undoStack: UndoEntry[] = [];
  const taskHistory: Array<{ task: string; summary: string; cost: number }> = [];
  const turnCostLog: Array<{ taskIdx: number; turn: number; cost: number }> = [];
  const backgroundTasks: BackgroundTask[] = [];
  let lastTask: string | null = null;

  const handleSlash = async (raw: string): Promise<boolean> => {
    const cmd = raw.slice(1).trim();
    const [head, ...rest] = cmd.split(/\s+/);
    const arg = rest.join(' ').trim();

    switch (head.toLowerCase()) {
      case 'help':
      case '?':
        printSlashHelp();
        return true;

      case 'clear':
      case 'cls':
        process.stdout.write('\x1b[2J\x1b[H');
        return true;

      case 'exit':
      case 'quit':
      case 'q':
        console.log(chalk.hex('#5EEAD4')('\nsigning off. stay powerful.\n'));
        rl.close();
        process.exit(0);
        return true;

      case 'status':
      case 'cost': {
        if (arg === 'breakdown' || arg === 'turns') {
          if (turnCostLog.length === 0) {
            printInfo('No turn cost data yet — run a task first.');
            return true;
          }
          console.log('');
          console.log('  ' + chalk.hex('#5EEAD4').bold('Cost breakdown by turn'));
          let cumulative = 0;
          for (const entry of turnCostLog) {
            cumulative += entry.cost;
            const taskLabel = chalk.dim(`task ${entry.taskIdx + 1}`);
            const turnLabel = chalk.hex('#94A3B8')(`turn ${String(entry.turn).padStart(2)}`);
            const costLabel = chalk.hex('#F5C97A')(`$${entry.cost.toFixed(5)}`);
            const cumLabel = chalk.dim(`(Σ $${cumulative.toFixed(4)})`);
            console.log(`    ${taskLabel}  ${turnLabel}  ${costLabel}  ${cumLabel}`);
          }
          console.log('');
          console.log(`    Total: ${chalk.hex('#F5C97A')('$' + session.cost.toFixed(4))}`);
          console.log('');
          return true;
        }
        printStatus({
          model: session.model,
          provider: session.provider,
          mode: session.mode,
          cost: session.cost,
          budgetUsd: session.budgetUsd,
          budgetRemainingUsd: remainingBudget(session),
          tokens: session.tokens,
          turns: session.turns,
          profile: session.profile,
          systemOverrideActive: session.systemOverride.trim().length > 0,
          pinnedCount: pinnedFiles.size,
          planMode: session.planMode,
          contextUsedTokens: session.tokens.input + session.tokens.output,
          contextLimitTokens: getContextLimit(session.model),
        });
        return true;
      }

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
          console.log(`     ${chalk.hex('#94A3B8').dim('->')} ${chalk.hex('#94A3B8')(summary.slice(0, 100))}${summary.length > 100 ? '...' : ''}`);
          console.log(`     ${chalk.hex('#94A3B8').dim('$' + cost.toFixed(4))}`);
        }
        console.log('');
        return true;
      }

      case 'retry': {
        if (!lastTask) {
          printWarn('No previous task to retry.');
          return true;
        }
        printInfo(`Retrying: ${lastTask}`);
        if (session.budgetUsd !== undefined && session.cost >= session.budgetUsd) {
          printWarn(`Session budget reached ($${session.budgetUsd.toFixed(2)}). Start a new session with a higher --budget to continue.`);
          return true;
        }
        if (!(await ensureProviderReady(session.provider, true))) {
          return true;
        }
        const result = await executeTask(lastTask, {
          model: session.model,
          mode: session.mode,
          provider: session.provider,
          maxTurns,
          budgetUsd: remainingBudget(session),
          logSessions: config.logSessions,
          systemPrompt: getSystemPrompt(),
          profile: activeProfile,
          codexTimeoutMs,
          cwd,
          askUserFn,
          undoStack,
          autoTest: session.autoTest,
          autoFormat: session.autoFormat,
          planMode: session.planMode,
          thinking: session.thinking,
        });
        if (result) {
          session.cost += result.totalCost;
          session.tokens.input += result.totalTokens.input;
          session.tokens.output += result.totalTokens.output;
          session.turns += result.turns;
          const retryTaskIdx = taskHistory.length;
          taskHistory.push({ task: lastTask, summary: result.summary, cost: result.totalCost });
          for (const tc of result.turnCosts ?? []) {
            turnCostLog.push({ taskIdx: retryTaskIdx, turn: tc.turn, cost: tc.cost });
          }
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
        if (session.provider === 'codex') {
          const kept = taskHistory.splice(-3);
          taskHistory.length = 0;
          taskHistory.push(...kept);
          undoStack.length = 0;
          printSuccess(`Compacted - kept last ${kept.length} task(s), undo stack cleared.`);
          return true;
        }
        const spinner = ora({ text: chalk.dim('summarising history...'), color: 'cyan', discardStdin: false }).start();
        try {
          const historyText = taskHistory.map((h, i) =>
            `Task ${i + 1}: ${h.task}\nResult: ${h.summary}`
          ).join('\n\n');
          const { streamCompletion: sc } = await import('./providers/anthropic.js');
          const { streamOpenRouter: sor } = await import('./providers/openrouter.js');
          const compactMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [{
            role: 'user',
            content: `Summarise the following session history into a concise paragraph that captures key outcomes, files changed, and important context. Write in plain prose, no bullet points.\n\n${historyText}`,
          }];
          const compactStream = session.provider === 'openrouter'
            ? sor(compactMessages as never, { model: session.model, maxTokens: 512, systemPrompt: 'You are a concise summariser.', tools: [], apiKey: process.env.OPENROUTER_API_KEY || '' })
            : sc(compactMessages as never, { model: session.model, maxTokens: 512, systemPrompt: 'You are a concise summariser.', tools: [] });
          let summary = '';
          for await (const chunk of compactStream) {
            if (chunk.type === 'text' && chunk.text) summary += chunk.text;
          }
          spinner.stop();
          process.stdout.write('\r\x1b[K');
          taskHistory.length = 0;
          taskHistory.push({ task: '[compacted]', summary: summary.trim() || 'Session history compacted.', cost: 0 });
          undoStack.length = 0;
          printSuccess('History summarised and compacted. Undo stack cleared.');
        } catch (err) {
          spinner.stop();
          process.stdout.write('\r\x1b[K');
          printError(`Compact failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return true;
      }

      case 'budget': {
        if (!arg) {
          if (session.budgetUsd === undefined) {
            printInfo('No session budget is set.');
          } else {
            const remaining = Math.max(0, session.budgetUsd - session.cost);
            printInfo(`Session budget: $${session.budgetUsd.toFixed(2)} total, $${remaining.toFixed(4)} remaining.`);
          }
          return true;
        }

        if (/^(clear|off|none)$/i.test(arg)) {
          session.budgetUsd = undefined;
          printSuccess('Session budget cleared.');
          return true;
        }

        const parsed = Number(arg);
        if (!isFiniteBudget(parsed)) {
          printError('Usage: /budget <positive-usd-amount> | clear');
          return true;
        }

        session.budgetUsd = parsed;
        if (parsed <= session.cost) {
          printWarn(`Budget set to $${parsed.toFixed(2)}, which is already exhausted by current session spend ($${session.cost.toFixed(4)}).`);
        } else {
          printSuccess(`Session budget set to $${parsed.toFixed(2)}.`);
        }
        return true;
      }

      case 'profile': {
        if (!arg) {
          printInfo(`Active profile: ${activeProfile ? activeProfile.name : 'none'}`);
          printInfo(`Available profiles: ${formatProfileNames()}`);
          return true;
        }

        if (/^(clear|off|none)$/i.test(arg)) {
          activeProfile = null;
          session.profile = undefined;
          printSuccess('Trained profile cleared.');
          return true;
        }

        const nextProfile = resolveProfile(arg);
        if (!nextProfile) {
          printError(`Unknown profile "${arg}". Valid profiles: ${formatProfileNames()}`);
          return true;
        }

        activeProfile = nextProfile;
        session.profile = nextProfile.name;
        printSuccess(`profile -> ${nextProfile.name}`);
        return true;
      }

      case 'profiles':
        printAvailableProfiles();
        return true;

      case 'override': {
        if (!arg) {
          if (!session.systemOverride.trim()) {
            printInfo('No system override is active.');
          } else {
            printInfo(`System override: ${session.systemOverride}`);
          }
          return true;
        }

        if (/^(clear|off|none)$/i.test(arg)) {
          systemOverride = '';
          session.systemOverride = '';
          printSuccess('System override cleared.');
          return true;
        }

        systemOverride = arg;
        session.systemOverride = arg;
        printSuccess('System override updated.');
        return true;
      }

      case 'think': {
        if (!arg || arg === 'on') {
          session.thinking = true;
          printSuccess('Extended thinking enabled.');
        } else if (arg === 'off') {
          session.thinking = false;
          printSuccess('Extended thinking disabled.');
        } else {
          printError('Usage: /think [on|off]');
        }
        return true;
      }

      case 'jobs': {
        if (backgroundTasks.length === 0) {
          printInfo('No background tasks.');
          return true;
        }
        console.log('');
        console.log('  ' + chalk.hex('#5EEAD4').bold('Background tasks'));
        for (const bg of backgroundTasks) {
          const statusColor = bg.status === 'done' ? chalk.green(bg.status)
            : bg.status === 'failed' ? chalk.red(bg.status)
            : chalk.yellow(bg.status);
          const costStr = bg.cost !== undefined ? chalk.dim(` $${bg.cost.toFixed(4)}`) : '';
          console.log(`  ${chalk.dim(`#${bg.id}`)}  ${statusColor}  ${chalk.white(bg.task.slice(0, 60))}${costStr}`);
          if (bg.summary) {
            console.log(`         ${chalk.hex('#94A3B8')(bg.summary.slice(0, 80))}`);
          }
        }
        console.log('');
        return true;
      }

      case 'save': {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = arg || `trident-session-${ts}.md`;
        let savePath: string;
        try {
          savePath = resolveWorkspacePath(cwd, filename);
        } catch (err) {
          printError(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
          return true;
        }

        const lines: string[] = [
          `# TRIDENT Session - ${new Date().toLocaleString()}`,
          '',
          `**Model:** ${session.model}  |  **Provider:** ${session.provider}  |  **Mode:** ${session.mode}`,
          `**Profile:** ${session.profile || 'none'}  |  **Override:** ${session.systemOverride.trim() ? 'active' : 'none'}`,
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
          await fsWriteFile(savePath, lines.join('\n'), 'utf-8');
          printSuccess(`Saved session to ${savePath}`);
        } catch (err) {
          printError(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return true;
      }

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
          console.log(chalk.hex('#94A3B8').dim('-'.repeat(60)));
          console.log(ctx.tridentMdContent);
          console.log(chalk.hex('#94A3B8').dim('-'.repeat(60)));
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

      case 'mode':
        if (!arg || !/^(yolo|review|lockdown)$/i.test(arg)) {
          printError('Usage: /mode yolo | review | lockdown');
          return true;
        }
        session.mode = arg.toLowerCase() as typeof session.mode;
        printSuccess(`mode -> ${session.mode.toUpperCase()}`);
        return true;

      case 'yolo':
        session.mode = 'yolo';
        printSuccess('mode -> YOLO');
        return true;

      case 'safe':
        session.mode = 'review';
        printSuccess('mode -> REVIEW');
        return true;

      case 'lock':
        session.mode = 'lockdown';
        printSuccess('mode -> LOCKDOWN');
        return true;

      case 'provider': {
        if (!arg || !/^(anthropic|openrouter|codex)$/i.test(arg)) {
          printError('Usage: /provider anthropic | openrouter | codex');
          return true;
        }
        const nextProvider = arg.toLowerCase() as TridentProviderName;
        if (!(await ensureProviderReady(nextProvider, true))) {
          return true;
        }
        session.provider = nextProvider;
        if (nextProvider === 'codex' && session.model !== (codexModel || 'codex default')) {
          session.model = codexModel || 'codex default';
        } else if (nextProvider !== 'codex' && session.model === (codexModel || 'codex default')) {
          session.model = apiModel;
        }
        printSuccess(`provider -> ${session.provider}`);
        return true;
      }

      case 'model': {
        if (!arg) {
          printError('Usage: /model <name>');
          return true;
        }
        const nextProvider: TridentProviderName = session.provider === 'codex'
          ? 'codex'
          : arg.includes('/') ? 'openrouter' : session.provider;
        if (!(await ensureProviderReady(nextProvider, true))) {
          return true;
        }
        session.model = arg;
        session.provider = nextProvider;
        printSuccess(`model -> ${session.model} (${session.provider})`);
        return true;
      }

      case 'models':
        printAvailableModels();
        return true;

      case 'sessions': {
        const files = await getRecentSessionLogFiles(10);
        if (files.length === 0) {
          printInfo('No sessions yet.');
          return true;
        }
        console.log('');
        console.log('  ' + chalk.hex('#5EEAD4').bold('Recent sessions'));
        for (const f of files) {
          console.log('    ' + chalk.dim(f.replace('.jsonl', '')));
        }
        console.log('');
        return true;
      }

      case 'git': {
        const gitCmd = arg || 'status';
        const isWindows = process.platform === 'win32';
        const shellExe = isWindows ? 'cmd' : 'bash';
        const shellFlag = isWindows ? '/c' : '-c';
        try {
          const execRes = await execa(shellExe, [shellFlag, `git ${gitCmd}`], { cwd, reject: false, all: true });
          const out = (typeof execRes.all === 'string' ? execRes.all : '').trim();
          if (out) {
            console.log('');
            for (const line of out.split('\n')) {
              const colored = line.startsWith('+') ? chalk.green(line)
                : line.startsWith('-') ? chalk.red(line)
                : line.startsWith('@@') ? chalk.cyan(line)
                : chalk.hex('#94A3B8')(line);
              console.log('  ' + colored);
            }
            console.log('');
          } else {
            printInfo('(no output)');
          }
        } catch (err) {
          printError(`git ${gitCmd}: ${err instanceof Error ? err.message : String(err)}`);
        }
        return true;
      }

      case 'search': {
        if (!arg) {
          printError('Usage: /search [--regex|-r] <query> [glob]');
          return true;
        }
        const useRegex = arg.startsWith('--regex ') || arg.startsWith('-r ');
        const argClean = useRegex ? arg.replace(/^(--regex|-r)\s+/, '') : arg;
        const [searchQuery, searchGlob] = argClean.split(/\s+(?=\*|\*\*|[a-zA-Z0-9_-]+[/*])/, 2);

        if (useRegex) {
          let regex: RegExp;
          try {
            regex = new RegExp(searchQuery, 'gi');
          } catch {
            printError(`Invalid regex: ${searchQuery}`);
            return true;
          }
          printInfo(`Regex search: /${searchQuery}/gi`);
          const fg = (await import('fast-glob')).default;
          const { readFile: rfSearch } = await import('fs/promises');
          const { resolve: resolvePath } = await import('path');
          const globPattern = searchGlob || '**/*.{ts,tsx,js,jsx,mjs,py,go,rs,java,rb,cs,cpp,c,h,md,json,yml,yaml}';
          const files = await fg(globPattern, {
            cwd, ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
            dot: false, absolute: false, followSymbolicLinks: false,
          });
          const hits: string[] = [];
          for (const rel of files) {
            let fc: string;
            try { fc = await rfSearch(resolvePath(cwd, rel), 'utf-8'); } catch { continue; }
            const lines = fc.split(/\r?\n/);
            const matched: string[] = [];
            for (let i = 0; i < lines.length; i++) {
              regex.lastIndex = 0;
              if (regex.test(lines[i])) matched.push(`  ${i + 1}: ${lines[i].slice(0, 200)}`);
              if (matched.length >= 5) { matched.push('  …'); break; }
            }
            if (matched.length > 0) hits.push(`\n${rel}\n${matched.join('\n')}`);
            if (hits.length >= 30) { hits.push('\n[truncated — too many matches]'); break; }
          }
          console.log('');
          if (hits.length === 0) { printInfo(`No matches for /${searchQuery}/`); }
          else {
            for (const h of hits) {
              for (const line of h.split('\n')) {
                const isFile = line.trim() && !line.startsWith(' ') && !line.startsWith('[');
                console.log('  ' + (isFile ? chalk.hex('#5EEAD4')(line) : chalk.hex('#94A3B8')(line)));
              }
            }
          }
          console.log('');
          return true;
        }

        printInfo(`Searching for "${searchQuery}"...`);
        const { executeTool: execTool } = await import('./agent/tools.js');
        const searchResult = await execTool(
          { name: 'search_codebase', input: { query: searchQuery, ...(searchGlob ? { glob: searchGlob } : {}) } },
          cwd,
          async () => '',
        );
        if (!searchResult.success) {
          printError(searchResult.error || 'Search failed');
          return true;
        }
        console.log('');
        for (const line of searchResult.output.split('\n')) {
          const isFilePath = !line.startsWith(' ') && !line.startsWith('Found') && !line.startsWith('[') && line.trim().length > 0;
          console.log('  ' + (isFilePath ? chalk.hex('#5EEAD4')(line) : chalk.hex('#94A3B8')(line)));
        }
        console.log('');
        return true;
      }

      case 'diff': {
        const diffTarget = arg ? `-- ${arg}` : '';
        const isWindows = process.platform === 'win32';
        const shellExe = isWindows ? 'cmd' : 'bash';
        const shellFlag = isWindows ? '/c' : '-c';
        try {
          const execRes = await execa(shellExe, [shellFlag, `git diff ${diffTarget}`], { cwd, reject: false, all: true });
          const out = (typeof execRes.all === 'string' ? execRes.all : '').trim();
          if (!out) {
            const stagedRes = await execa(shellExe, [shellFlag, `git diff --cached ${diffTarget}`], { cwd, reject: false, all: true });
            const staged = (typeof stagedRes.all === 'string' ? stagedRes.all : '').trim();
            if (!staged) {
              printInfo(arg ? `No changes in ${arg}` : 'No uncommitted changes.');
              return true;
            }
            console.log('');
            printInfo('Staged changes:');
            for (const line of staged.split('\n').slice(0, 200)) {
              const colored = line.startsWith('+') ? chalk.green(line)
                : line.startsWith('-') ? chalk.red(line)
                : line.startsWith('@@') ? chalk.cyan(line)
                : chalk.dim(line);
              console.log('  ' + colored);
            }
          } else {
            console.log('');
            for (const line of out.split('\n').slice(0, 200)) {
              const colored = line.startsWith('+') ? chalk.green(line)
                : line.startsWith('-') ? chalk.red(line)
                : line.startsWith('@@') ? chalk.cyan(line)
                : chalk.dim(line);
              console.log('  ' + colored);
            }
          }
          console.log('');
        } catch (err) {
          printError(`diff failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return true;
      }

      // ── FEATURE: /pin, /unpin, /pinned ─────────────────────────────────
      case 'pin': {
        if (!arg) {
          printError('Usage: /pin <file>');
          return true;
        }
        let absPath: string;
        try {
          absPath = resolveWorkspacePath(cwd, arg);
        } catch {
          printError(`Path escapes workspace: ${arg}`);
          return true;
        }
        let content: string;
        try {
          content = await fsReadFile(absPath, 'utf-8');
        } catch {
          printError(`Cannot read file: ${arg}`);
          return true;
        }
        pinnedFiles.set(arg, content);
        printSuccess(`Pinned ${arg} — always in context (${content.length.toLocaleString()} chars)`);
        return true;
      }

      case 'unpin': {
        if (!arg) {
          if (pinnedFiles.size === 0) {
            printInfo('No files are pinned.');
          } else {
            printError('Usage: /unpin <file>  (or /unpin all)');
          }
          return true;
        }
        if (/^(all|clear)$/i.test(arg)) {
          pinnedFiles.clear();
          printSuccess('All pinned files cleared.');
          return true;
        }
        if (pinnedFiles.delete(arg)) {
          printSuccess(`Unpinned ${arg}`);
        } else {
          printWarn(`"${arg}" was not pinned.`);
        }
        return true;
      }

      case 'pinned': {
        if (pinnedFiles.size === 0) {
          printInfo('No files are currently pinned.');
        } else {
          console.log('');
          console.log('  ' + chalk.hex('#5EEAD4').bold('Pinned files'));
          for (const [filePath, content] of pinnedFiles) {
            console.log(`    ${chalk.white(filePath)} ${chalk.dim(`(${content.length.toLocaleString()} chars)`)}`);
          }
          console.log('');
        }
        return true;
      }

      // ── FEATURE: /snapshot ──────────────────────────────────────────────
      case 'snapshot': {
        const label = arg || `trident-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}`;
        const isWin = process.platform === 'win32';
        try {
          const res = await execa(isWin ? 'cmd' : 'bash', [isWin ? '/c' : '-c', `git stash push -u -m "TRIDENT: ${label}"`], { cwd, reject: false, all: true });
          const out = (typeof res.all === 'string' ? res.all : '').trim();
          if ((res.exitCode ?? 1) === 0) {
            printSuccess(`Snapshot created: "${label}"`);
            if (out) console.log(chalk.dim('  ' + out));
          } else {
            printError(`Snapshot failed: ${out || 'git stash returned non-zero'}`);
          }
        } catch (err) {
          printError(`Snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return true;
      }

      // ── FEATURE: /resume ────────────────────────────────────────────────
      case 'resume': {
        const files = await getRecentSessionLogFiles(20);
        if (files.length === 0) {
          printInfo('No past sessions found.');
          return true;
        }
        if (!arg) {
          printError('Usage: /resume <n>  (number from /sessions list)');
          return true;
        }
        const resumeNum = parseInt(arg, 10);
        const targetFile = !Number.isNaN(resumeNum) && resumeNum > 0 && resumeNum <= files.length
          ? files[resumeNum - 1]
          : files.find((f) => f.includes(arg)) || null;
        if (!targetFile) {
          printError(`Session not found: ${arg}. Use /sessions to list available sessions.`);
          return true;
        }
        const loaded = await loadLatestReviewableSession([targetFile]);
        if (!loaded || loaded.entries.length === 0) {
          printError('Session log is empty or unreadable.');
          return true;
        }
        const toolSummary = loaded.entries
          .map((e) => `  ${e.approved ? '✓' : '✗'} ${e.toolName}: ${JSON.stringify(e.input).slice(0, 60)}`)
          .join('\n');
        const contextBlock = `## Resumed from session ${targetFile.replace('.jsonl', '')}\n\nActions performed:\n${toolSummary}`;
        systemOverride = [session.systemOverride, contextBlock].filter(Boolean).join('\n\n');
        session.systemOverride = systemOverride;
        printSuccess(`Resumed context from session ${resumeNum || arg} (${loaded.entries.length} actions).`);
        printInfo('Next task will include that session as context.');
        return true;
      }

      // ── FEATURE: /replay ────────────────────────────────────────────────
      case 'replay': {
        const files = await getRecentSessionLogFiles(20);
        if (files.length === 0) {
          printInfo('No past sessions found.');
          return true;
        }
        if (!arg) {
          printError('Usage: /replay <n>  (number from /sessions list)');
          return true;
        }
        const replayNum = parseInt(arg, 10);
        const replayFile = !Number.isNaN(replayNum) && replayNum > 0 && replayNum <= files.length
          ? files[replayNum - 1]
          : files.find((f) => f.includes(arg)) || null;
        if (!replayFile) {
          printError(`Session not found: ${arg}.`);
          return true;
        }
        const replayLoaded = await loadLatestReviewableSession([replayFile]);
        if (!replayLoaded || replayLoaded.entries.length === 0) {
          printError('Session log is empty or unreadable.');
          return true;
        }
        const replayableCalls = replayLoaded.entries.filter(
          (e) => e.approved && e.toolName !== 'final_answer' && e.toolName !== 'ask_user',
        );
        if (replayableCalls.length === 0) {
          printInfo('No replayable tool calls in this session.');
          return true;
        }
        console.log('');
        console.log('  ' + chalk.hex('#5EEAD4').bold('Tool calls to replay:'));
        for (let i = 0; i < replayableCalls.length; i++) {
          const e = replayableCalls[i];
          console.log(`    ${chalk.dim(String(i + 1).padStart(2))}  ${chalk.white(e.toolName.padEnd(14))} ${chalk.dim(JSON.stringify(e.input).slice(0, 60))}`);
        }
        console.log('');
        const { confirmed } = await inquirer.prompt([{
          type: 'confirm', name: 'confirmed',
          message: chalk.cyan(`Replay ${replayableCalls.length} action(s)?`),
          default: false,
        }]);
        if (!confirmed) { printInfo('Replay cancelled.'); return true; }
        const { executeTool: execToolReplay } = await import('./agent/tools.js');
        let replayOk = 0; let replayFail = 0;
        for (const e of replayableCalls) {
          try {
            const res = await execToolReplay(
              { name: e.toolName as import('./agent/tools.js').ToolName, input: e.input },
              cwd, askUserFn,
            );
            if (res.success) { printSuccess(`${e.toolName}: ${res.output.slice(0, 60)}`); replayOk++; }
            else { printError(`${e.toolName}: ${res.error || 'failed'}`); replayFail++; }
          } catch (err) {
            printError(`${e.toolName}: ${err instanceof Error ? err.message : String(err)}`);
            replayFail++;
          }
        }
        console.log('');
        printInfo(`Replay complete: ${replayOk} succeeded, ${replayFail} failed.`);
        return true;
      }

      case 'memory': {
        const mem = sessionMemory.trim();
        if (!mem) {
          printInfo('Memory is empty. The agent will write facts using the memory_update tool.');
        } else {
          console.log('');
          console.log('  ' + chalk.hex('#5EEAD4').bold('Agent memory'));
          console.log(chalk.hex('#94A3B8').dim('-'.repeat(60)));
          for (const line of mem.split('\n')) {
            console.log('  ' + chalk.hex('#94A3B8')(line));
          }
          console.log(chalk.hex('#94A3B8').dim('-'.repeat(60)));
          console.log('');
        }
        return true;
      }

      case 'forget': {
        await clearMemory();
        sessionMemory = '';
        printSuccess('Memory cleared.');
        return true;
      }

      case 'plan': {
        if (arg === 'on' || arg === '') {
          session.planMode = true;
          printSuccess('Plan mode ON — agent will draft a plan before acting.');
        } else if (arg === 'off') {
          session.planMode = false;
          printSuccess('Plan mode OFF.');
        } else {
          printError('Usage: /plan [on|off]');
        }
        return true;
      }

      case 'queue': {
        const [subCmd, ...queueRest] = (arg || '').split(/\s+/);
        const queueArg = queueRest.join(' ').trim();
        if (!subCmd || subCmd === 'list') {
          if (taskQueue.length === 0) {
            printInfo('Task queue is empty. Add tasks with /queue add <task>.');
          } else {
            console.log('');
            console.log('  ' + chalk.hex('#5EEAD4').bold('Task queue'));
            taskQueue.forEach((t, i) => {
              console.log(`    ${chalk.hex('#94A3B8').dim(String(i + 1) + '.')} ${chalk.white(t)}`);
            });
            console.log('');
          }
        } else if (subCmd === 'add') {
          if (!queueArg) { printError('Usage: /queue add <task>'); return true; }
          taskQueue.push(queueArg);
          printSuccess(`Queued task ${taskQueue.length}: ${queueArg}`);
        } else if (subCmd === 'clear') {
          taskQueue.length = 0;
          printSuccess('Task queue cleared.');
        } else if (subCmd === 'run') {
          if (taskQueue.length === 0) { printInfo('Task queue is empty.'); return true; }
          const queued = taskQueue.splice(0);
          printInfo(`Running ${queued.length} queued task(s)...`);
          for (let qi = 0; qi < queued.length; qi++) {
            const qt = queued[qi];
            printSectionHeader(`Queue ${qi + 1}/${queued.length}: ${qt}`);
            if (session.budgetUsd !== undefined && session.cost >= session.budgetUsd) {
              printWarn('Budget exhausted — stopping queue.');
              break;
            }
            const qResult = await executeTask(qt, {
              model: session.model, mode: session.mode, provider: session.provider,
              maxTurns, budgetUsd: remainingBudget(session),
              logSessions: config.logSessions, systemPrompt: getSystemPrompt(),
              profile: activeProfile, codexTimeoutMs, cwd, askUserFn, undoStack,
              autoTest: session.autoTest, autoFormat: session.autoFormat, planMode: session.planMode,
            });
            if (qResult) {
              session.cost += qResult.totalCost;
              session.tokens.input += qResult.totalTokens.input;
              session.tokens.output += qResult.totalTokens.output;
              session.turns += qResult.turns;
              const qIdx = taskHistory.length;
              taskHistory.push({ task: qt, summary: qResult.summary, cost: qResult.totalCost });
              for (const tc of qResult.turnCosts ?? []) {
                turnCostLog.push({ taskIdx: qIdx, turn: tc.turn, cost: tc.cost });
              }
            }
          }
          printSuccess('Queue complete.');
        } else {
          printError('Usage: /queue [add <task>|list|run|clear]');
        }
        return true;
      }

      case 'autotest': {
        if (arg === 'on' || (!arg && !session.autoTest)) {
          session.autoTest = true;
          printSuccess('Auto-test ON — tests will run after each file write.');
        } else if (arg === 'off' || (!arg && session.autoTest)) {
          session.autoTest = false;
          printSuccess('Auto-test OFF.');
        } else {
          printError('Usage: /autotest [on|off]');
        }
        return true;
      }

      case 'autoformat': {
        if (arg === 'on' || (!arg && !session.autoFormat)) {
          session.autoFormat = true;
          printSuccess('Auto-format ON — files will be formatted after each write.');
        } else if (arg === 'off' || (!arg && session.autoFormat)) {
          session.autoFormat = false;
          printSuccess('Auto-format OFF.');
        } else {
          printError('Usage: /autoformat [on|off]');
        }
        return true;
      }

      default:
        printWarn(`Unknown command: /${head}. Type / then Enter for the menu, or /help for the list.`);
        return true;
    }
  };

  const handleInput = async (rawInput: string): Promise<void> => {
    const task = rawInput.trim();
    if (!task) {
      return;
    }

    if (task === '/') {
      await showCommandPicker(rl, handleSlash);
      return;
    }

    // Background task shortcut: bg:<task> or /bg <task>
    if (task.startsWith('bg:') || task.startsWith('/bg ')) {
      const bgTask = task.replace(/^(bg:|\/bg\s+)/, '').trim();
      if (!bgTask) { printError('Usage: bg:<task> or /bg <task>'); return; }
      const bgId = backgroundTasks.length + 1;
      backgroundTasks.push({ id: bgId, task: bgTask, status: 'running' });
      printInfo(`[bg#${bgId}] started in background: ${bgTask.slice(0, 60)}`);
      executeTask(bgTask, {
        model: session.model,
        mode: session.mode,
        provider: session.provider,
        maxTurns,
        budgetUsd: remainingBudget(session),
        logSessions: config.logSessions,
        systemPrompt: getSystemPrompt(),
        profile: activeProfile,
        codexTimeoutMs,
        cwd,
        askUserFn,
        thinking: session.thinking,
        hooks,
      }).then(result => {
        const bg = backgroundTasks.find(b => b.id === bgId);
        if (bg) { bg.status = result ? 'done' : 'failed'; bg.summary = result?.summary; bg.cost = result?.totalCost; }
        process.stdout.write(`\n  [bg#${bgId}] ${result ? 'DONE' : 'FAILED'}: ${bgTask.slice(0, 50)}\n`);
        if (process.stdout.isTTY) printPrompt();
      }).catch(() => {
        const bg = backgroundTasks.find(b => b.id === bgId);
        if (bg) bg.status = 'failed';
      });
      return; // Do NOT await - continue to REPL immediately
    }

    if (task.startsWith('/')) {
      await handleSlash(task);
      return;
    }

    if (/^(exit|quit)$/i.test(task)) {
      await handleSlash('/exit');
      return;
    }

    if (/^init$/i.test(task)) {
      await handleSlash('/init');
      return;
    }

    lastTask = task;

    if (session.budgetUsd !== undefined && session.cost >= session.budgetUsd) {
      printWarn(`Session budget reached ($${session.budgetUsd.toFixed(2)}). Start a new session with a higher --budget to continue.`);
      return;
    }

    if (!(await ensureProviderReady(session.provider, true))) {
      return;
    }

    if (hooks.on_task_start) await runHook(hooks.on_task_start, cwd);

    const taskIdx = taskHistory.length;
    const result = await executeTask(task, {
      model: session.model,
      mode: session.mode,
      provider: session.provider,
      maxTurns,
      budgetUsd: remainingBudget(session),
      logSessions: config.logSessions,
      systemPrompt: getSystemPrompt(),
      profile: activeProfile,
      codexTimeoutMs,
      cwd,
      askUserFn,
      undoStack,
      autoTest: session.autoTest,
      autoFormat: session.autoFormat,
      planMode: session.planMode,
      thinking: session.thinking,
    });

    if (hooks.on_task_end) await runHook(hooks.on_task_end, cwd);

    if (result) {
      session.cost += result.totalCost;
      session.tokens.input += result.totalTokens.input;
      session.tokens.output += result.totalTokens.output;
      session.turns += result.turns;
      taskHistory.push({ task, summary: result.summary, cost: result.totalCost });
      for (const tc of result.turnCosts ?? []) {
        turnCostLog.push({ taskIdx, turn: tc.turn, cost: tc.cost });
      }
    }
  };

  if (process.stdin.isTTY) {
    const promptLoop = (): void => {
      printPrompt();
      rl.once('line', async (input) => {
        await handleInput(input);
        promptLoop();
      });
    };

    promptLoop();
  } else {
    for await (const input of rl) {
      await handleInput(input);
    }
  }

  rl.on('close', () => {
    console.log(chalk.hex('#5EEAD4')('\nsigning off.\n'));
    process.exit(0);
  });
}

async function executeTask(
  task: string,
  opts: {
    model: string;
    provider: TridentProviderName;
    mode: 'yolo' | 'review' | 'lockdown';
    maxTurns: number;
    budgetUsd?: number;
    logSessions: boolean;
    systemPrompt: string;
    profile?: TrainedProfile | null;
    codexTimeoutMs: number;
    cwd: string;
    askUserFn: (q: string) => Promise<string>;
    undoStack?: UndoEntry[];
    autoTest?: boolean;
    autoFormat?: boolean;
    planMode?: boolean;
    thinking?: boolean;
    hooks?: HooksConfig;
  }
): Promise<Awaited<ReturnType<typeof runAgentLoop>> | null> {
  printSectionHeader(`FORGE - ${opts.provider} - ${opts.model}`);
  console.log(chalk.dim(`  ${task}`));
  console.log('');

  if (opts.provider === 'codex') {
    printInfo(`Running Codex CLI${opts.profile ? ` with ${opts.profile.name}` : ''} (${opts.mode} -> ${codexSandboxForMode(opts.mode)} sandbox).`);
    try {
      const codexResult = await runCodexExec({
        cwd: opts.cwd,
        task,
        systemPrompt: opts.systemPrompt,
        profile: opts.profile,
        model: opts.model === 'codex default' ? '' : opts.model,
        timeoutMs: opts.codexTimeoutMs,
        sandbox: codexSandboxForMode(opts.mode),
      });
      const result = {
        success: codexResult.success,
        summary: codexResult.summary,
        turns: 1,
        totalCost: 0,
        totalTokens: { input: 0, output: 0 },
        turnCosts: [],
      };
      printFinalSummary(result);
      if (!codexResult.success) {
        printWarn('Codex CLI did not complete successfully. Run "codex doctor" for details.');
      }
      return result;
    } catch (err) {
      console.log('');
      printError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  const sessionId = randomUUID();
  const hooks = opts.hooks ?? {};

  // Set up abort controller for Ctrl+C interrupt
  const abortController = new AbortController();
  const sigintHandler = () => {
    console.log(chalk.yellow('\n  [TRIDENT] Interrupted. Stopping task...'));
    abortController.abort();
  };
  process.once('SIGINT', sigintHandler);

  const onToolStart = async (call: import('./agent/tools.js').ToolCall): Promise<void> => {
    printToolStart(call);
  };

  const beforeToolExecute = async (call: import('./agent/tools.js').ToolCall): Promise<void> => {
    // Run before_tool hook if configured
    if (hooks.before_tool?.[call.name]) {
      await runHook(hooks.before_tool[call.name], opts.cwd);
    }

    if (!opts.undoStack || (call.name !== 'write_file' && call.name !== 'edit_file' && call.name !== 'delete_file')) {
      return;
    }

    const filePath = resolveWorkspacePath(opts.cwd, call.input.path as string);
    let originalContent: string | null = null;
    try {
      originalContent = await fsReadFile(filePath, 'utf-8');
    } catch {
      // File did not exist before this change.
    }
    opts.undoStack.push({ path: filePath, originalContent });
  };

  const onToolEnd = (call: import('./agent/tools.js').ToolCall, result: import('./agent/tools.js').ToolResult): void => {
    printToolEnd(call, result);
    // Run after_tool hook if configured (fire-and-forget)
    if (hooks.after_tool?.[call.name]) {
      runHook(hooks.after_tool[call.name], opts.cwd).catch(() => {});
    }
  };

  try {
    const result = await runAgentLoop(task, {
      cwd: opts.cwd,
      mode: opts.mode,
      model: opts.model,
      provider: opts.provider as AgentProviderName,
      systemPrompt: opts.systemPrompt,
      maxTurns: opts.maxTurns,
      budgetUsd: opts.budgetUsd,
      logSessions: opts.logSessions,
      sessionId,
      autoTest: opts.autoTest ?? false,
      autoFormat: opts.autoFormat ?? false,
      thinking: opts.thinking,
      abortSignal: abortController.signal,
      onTurnStart: process.stdout.isTTY
        ? (turn, maxTurns) => {
            const spinner = ora({ text: chalk.dim(`thinking · turn ${turn}/${maxTurns}`), color: 'cyan', discardStdin: false }).start();
            return () => { spinner.stop(); process.stdout.write('\r\x1b[K'); };
          }
        : undefined,
      onTurnComplete: (turn, turnCost) => {
        if (process.stdout.isTTY) {
          process.stdout.write(chalk.dim(`\n  ↳ turn ${turn} · $${turnCost.toFixed(5)}\n`));
        }
      },
      onContextPressure: () => {
        if (process.stdout.isTTY) {
          process.stdout.write(chalk.hex('#F5C97A')('\n  [TRIDENT] Context approaching limit — consider /compact\n'));
        }
      },
      onText: printAgentText,
      onToolStart,
      beforeToolExecute,
      onToolEnd,
      onCostUpdate: printCostUpdate,
      askUserFn: opts.askUserFn,
    });

    printFinalSummary(result);
    return result;
  } catch (err) {
    console.log('');
    printError(err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    process.removeListener('SIGINT', sigintHandler);
  }
}

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

function resolveBudget(cliBudget?: string, configBudget?: number): number | undefined {
  if (cliBudget === undefined || cliBudget === null || cliBudget === '') {
    return isFiniteBudget(configBudget) ? configBudget : undefined;
  }

  const parsed = Number(cliBudget);
  if (!isFiniteBudget(parsed)) {
    printError(`Invalid budget: "${cliBudget}". Expected a positive number.`);
    process.exit(1);
  }
  return parsed;
}

function isFiniteBudget(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function remainingBudget(session: { cost: number; budgetUsd?: number }): number | undefined {
  if (session.budgetUsd === undefined) {
    return undefined;
  }
  return Math.max(0, session.budgetUsd - session.cost);
}

function resolvePositiveInteger(cliValue: string | undefined, configValue: number, label: string): number {
  if (cliValue === undefined || cliValue === null || cliValue === '') {
    return configValue;
  }

  const parsed = Number(cliValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    printError(`Invalid ${label}: "${cliValue}". Expected a positive integer.`);
    process.exit(1);
  }
  return parsed;
}

function resolveConfiguredProfile(cliProfile?: string, configProfile?: string): TrainedProfile | null {
  const raw = cliProfile ?? configProfile;
  if (!raw) {
    return null;
  }

  const profile = resolveProfile(raw);
  if (!profile) {
    printError(`Unknown profile "${raw}". Valid profiles: ${formatProfileNames()}`);
    process.exit(1);
  }
  return profile;
}

function formatEnvAssignment(key: string, value: string): string {
  if (process.platform === 'win32') {
    return `$env:${key}="${value}"`;
  }
  return `export ${key}=${value}`;
}

function printAvailableModels(): void {
  console.log(chalk.hex('#00D4FF').bold('\nTRIDENT - Available Models\n'));

  console.log(chalk.bold('  ANTHROPIC (--provider anthropic)'));
  const anthropicModels = [
    ['claude-opus-4-7', '$15 / $75 per M tokens'],
    ['claude-sonnet-4-6', '$3  / $15 per M tokens'],
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
    ['openai/gpt-oss-120b:free', 'free'],
    ['openai/gpt-oss-20b:free', 'free'],
    ['nvidia/nemotron-3-super-120b-a12b:free', 'free'],
  ];
  for (const [m, p] of freeModels) {
    console.log(`    ${chalk.white(m.padEnd(42))} ${chalk.green(p)}`);
  }
  console.log('');
  console.log(chalk.bold('  CODEX CLI (--provider codex)'));
  console.log(chalk.dim('    Uses the locally installed Codex CLI and its configured/authenticated model.'));
  console.log(chalk.dim('    Optional override: --codex-model <model>'));
  console.log('');
  printAvailableProfiles();
  console.log('');
}

function printAvailableProfiles(): void {
  console.log(chalk.bold('  TRIDENT TRAINED PROFILES'));
  for (const profile of listTrainedProfiles()) {
    console.log(`    ${chalk.white(profile.name.padEnd(12))} ${chalk.dim(profile.title)} - ${chalk.hex('#94A3B8')(profile.focus)}`);
  }
  console.log(chalk.dim('    Use: trident --provider codex --profile Sydney "task"'));
}

async function getRecentSessionLogFiles(limit?: number): Promise<string[]> {
  const { homedir } = await import('os');
  const { readdir, stat } = await import('fs/promises');
  const logDir = join(homedir(), '.trident', 'logs');

  if (!existsSync(logDir)) {
    return [];
  }

  const names = (await readdir(logDir)).filter((name) => name.endsWith('.jsonl'));
  const withMtime = await Promise.all(names.map(async (name) => ({
    name,
    mtimeMs: (await stat(join(logDir, name))).mtimeMs,
  })));

  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  const ordered = withMtime.map((entry) => entry.name);
  return limit ? ordered.slice(0, limit) : ordered;
}

async function loadLatestReviewableSession(files: string[]): Promise<{
  file: string;
  entries: Array<{
    timestamp: string;
    approved: boolean;
    toolName: string;
    input: Record<string, unknown>;
  }>;
} | null> {
  const { homedir } = await import('os');
  const { readFile } = await import('fs/promises');
  const logDir = join(homedir(), '.trident', 'logs');

  for (const file of files) {
    const content = await readFile(join(logDir, file), 'utf-8');
    const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      continue;
    }

    const entries = lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as {
          timestamp: string;
          approved: boolean;
          toolName: string;
          input: Record<string, unknown>;
        }];
      } catch {
        console.warn(`  [warn] Skipping malformed log line in ${file}: ${line.slice(0, 60)}`);
        return [];
      }
    });

    if (entries.length > 0) {
      return { file, entries };
    }
  }

  return null;
}
