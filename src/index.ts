#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import { execa } from 'execa';
import { readFile as fsReadFile, writeFile as fsWriteFile, unlink as fsUnlink } from 'fs/promises';

import { getConfig, getRawConfig, getDefaultConfig, resetConfigToDefaults, setConfig, deleteConfig, getConfigPath, ConfigSchema } from './config.js';
import type { TridentConfig } from './config.js';
import { formatEnvAssignment } from './util.js';
import { ANTHROPIC_PRICING } from './providers/anthropic.js';
import { SLASH_COMMAND_GROUPS } from './ui/commands.js';
import { runOnboarding } from './ui/onboarding.js';
import { loadOrCreateContext, generateTridentMd, buildSystemPrompt, generateProjectTree } from './oracle/index.js';
import { runAgentLoop, type ProviderName as AgentProviderName } from './agent/loop.js';
import { resolveWorkspacePath, TOOL_DEFINITIONS } from './agent/tools.js';
import { listOpenRouterModels } from './providers/openrouter.js';
import { codexSandboxForMode, isCodexCliAvailable, runCodexExec } from './providers/codex.js';
import { formatProfileNames, listTrainedProfiles, resolveProfile, type TrainedProfile } from './profiles.js';
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

type TridentProviderName = AgentProviderName | 'codex';

program
  .name('trident')
  .description('TRIDENT - All-Powerful Agentic AI Coding CLI')
  .version('1.0.0');

program.showSuggestionAfterError();

program
  .argument('[task]', 'Task to execute (omit for interactive mode)')
  .option('-m, --model <model>', 'Model to use')
  .option('-p, --provider <provider>', 'Provider: anthropic | openrouter | codex')
  .option('--mode <mode>', 'Approval mode: yolo | review | lockdown')
  .option('--max-turns <n>', 'Max agent loop iterations (default: config maxTurns)')
  .option('--budget <usd>', 'Max budget in USD')
  .option('--profile <name>', `Trained profile: ${formatProfileNames()}`)
  .option('--system-override <text>', 'Operator system override appended to the agent prompt')
  .option('--codex-model <model>', 'Codex CLI model override (provider=codex only)')
  .option('--codex-timeout <ms>', 'Codex CLI timeout in milliseconds')
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
  .command('status')
  .description('Show current config, workspace, and provider readiness')
  .action(async () => {
    printLogo();
    console.log(chalk.cyan('\nTRIDENT Status\n'));

    const rawConfig = getRawConfig();
    const parsed = ConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue.path.length > 0 ? issue.path.join('.') : 'config';
      printError(`Invalid config at ${path}: ${issue.message}`);
      console.log(chalk.dim(`Config path: ${getConfigPath()}`));
      console.log(chalk.dim('Run: trident heal --reset-config'));
      process.exit(1);
    }

    const config = parsed.data;
    const cwd = process.cwd();
    const tridentMdPath = join(cwd, 'TRIDENT.md');
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;
    const hasCodexCli = await isCodexCliAvailable();
    const providerReady =
      (config.provider === 'anthropic' && hasAnthropic) ||
      (config.provider === 'openrouter' && hasOpenRouter) ||
      (config.provider === 'codex' && hasCodexCli);

    const rows: Array<[string, string]> = [
      ['workspace', cwd],
      ['context', existsSync(tridentMdPath) ? 'TRIDENT.md present' : 'missing (run: trident init)'],
      ['provider', `${config.provider}${providerReady ? ' (ready)' : ' (needs setup)'}`],
      ['model', config.provider === 'codex' ? (config.codexModel || 'codex default') : config.model],
      ['mode', config.mode],
      ['profile', config.profile || 'none'],
      ['max turns', String(config.maxTurns)],
      ['budget', config.budgetUsd === undefined ? 'none' : `$${config.budgetUsd}`],
      ['session logs', config.logSessions ? 'on' : 'off'],
      ['config path', getConfigPath()],
    ];

    for (const [key, value] of rows) {
      console.log('  ' + chalk.gray(key.padEnd(13)) + chalk.white(value));
    }
    console.log('');
  });

program
  .command('sessions')
  .description('List recent TRIDENT session log files')
  .option('-n, --limit <n>', 'Number of session logs to show', '10')
  .action(async (opts: { limit?: string }) => {
    const limit = resolvePositiveInteger(opts.limit, 10, 'limit');
    const files = await getRecentSessionLogFiles(limit);
    if (files.length === 0) {
      printInfo('No session logs found.');
      return;
    }

    console.log(chalk.cyan('\nTRIDENT Recent Sessions\n'));
    for (const file of files) {
      console.log(`  ${chalk.white(file.replace('.jsonl', ''))}`);
    }
    console.log('');
  });

program
  .command('tools')
  .description('List the agent tools exposed to model providers')
  .action(() => {
    console.log(chalk.cyan('\nTRIDENT Agent Tools\n'));
    for (const tool of TOOL_DEFINITIONS) {
      const required = Array.isArray(tool.input_schema.required) && tool.input_schema.required.length
        ? ` required: ${tool.input_schema.required.join(', ')}`
        : '';
      console.log(`  ${chalk.white(tool.name.padEnd(16))} ${chalk.gray(tool.description)}${chalk.dim(required)}`);
    }
    console.log('');
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

async function showCommandPicker(
  rl: ReturnType<typeof createInterface>,
  handleSlash: (raw: string) => Promise<boolean>
): Promise<void> {
  const TEAL = '#5EEAD4';
  const SLATE = '#94A3B8';
  const AMBER = '#F5C97A';

  console.log('');
  console.log('  ' + chalk.hex(TEAL).bold('Command menu'));
  console.log('');

  let n = 1;
  const numToCmd: Record<number, string> = {};

  for (const { label, commands } of SLASH_COMMAND_GROUPS) {
    const pickable = commands.filter((c) => !c.requiresArg && !c.aliasOf);
    if (pickable.length === 0) {
      continue;
    }
    console.log('  ' + chalk.hex(AMBER).dim(`-- ${label} --`));
    for (const { cmd, desc } of pickable) {
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
  const getSystemPrompt = (): string => buildSystemPrompt(ctx, {
    profile: activeProfile,
    systemOverride,
  });

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
    });
    return;
  }

  printWelcome(config.userName);

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
  };
  const undoStack: UndoEntry[] = [];
  const taskHistory: Array<{ task: string; summary: string; cost: number }> = [];
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
      case 'cost':
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
        const kept = taskHistory.splice(-3);
        taskHistory.length = 0;
        taskHistory.push(...kept);
        undoStack.length = 0;
        printSuccess(`Compacted - kept last ${kept.length} task(s), undo stack cleared.`);
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
    });

    if (result) {
      session.cost += result.totalCost;
      session.tokens.input += result.totalTokens.input;
      session.tokens.output += result.totalTokens.output;
      session.turns += result.turns;
      taskHistory.push({ task, summary: result.summary, cost: result.totalCost });
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

  const onToolStart = async (call: import('./agent/tools.js').ToolCall): Promise<void> => {
    printToolStart(call);
  };

  const beforeToolExecute = async (call: import('./agent/tools.js').ToolCall): Promise<void> => {
    if (!opts.undoStack || (call.name !== 'write_file' && call.name !== 'edit_file' && call.name !== 'delete_file')) {
      return;
    }

    // A bad path must not abort the whole agent run here; executeTool will
    // reject it and report a tool error to the model instead.
    let filePath: string;
    try {
      filePath = resolveWorkspacePath(opts.cwd, call.input.path as string);
    } catch {
      return;
    }
    let originalContent: string | null = null;
    try {
      originalContent = await fsReadFile(filePath, 'utf-8');
    } catch {
      // File did not exist before this change.
    }
    opts.undoStack.push({ path: filePath, originalContent });
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
      onText: printAgentText,
      onToolStart,
      beforeToolExecute,
      onToolEnd: printToolEnd,
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

function printAvailableModels(): void {
  console.log(chalk.hex('#00D4FF').bold('\nTRIDENT - Available Models\n'));

  console.log(chalk.bold('  ANTHROPIC (--provider anthropic)'));
  for (const [m, p] of Object.entries(ANTHROPIC_PRICING)) {
    console.log(`    ${chalk.white(m.padEnd(38))} ${chalk.dim(`$${p.input} / $${p.output} per M tokens`)}`);
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
