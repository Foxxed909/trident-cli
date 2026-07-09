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
import { formatEnvAssignment, expandFileMentions } from './util.js';
import { ANTHROPIC_PRICING, streamCompletion } from './providers/anthropic.js';
import { streamOpenRouter, fetchLiveOpenRouterModels } from './providers/openrouter.js';
import { SLASH_COMMAND_GROUPS } from './ui/commands.js';
import { saveSessionState, loadSessionState } from './session-store.js';
import { loadMcpConfig, McpManager, mcpConfigPath } from './mcp/index.js';
import { runOnboarding } from './ui/onboarding.js';
import { loadOrCreateContext, generateTridentMd, buildSystemPrompt, generateProjectTree, parseDoNotTouch } from './oracle/index.js';
import { runAgentLoop, type ProviderName as AgentProviderName } from './agent/loop.js';
import type { ChatMessage } from './providers/anthropic.js';
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

// Silence deprecation noise from transitive dependencies (e.g. punycode)
// while keeping other runtime warnings visible.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name !== 'DeprecationWarning') {
    console.warn(`${warning.name}: ${warning.message}`);
  }
});

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
  .option('-c, --continue', 'Resume the previous conversation in this directory')
  .option('--output <format>', 'One-shot output format: text | json')
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
    continue?: boolean;
    output?: string;
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
  .argument('[filter]', 'Filter live results by substring (with --live)')
  .option('--live', 'Fetch the current OpenRouter catalog with live pricing')
  .action(async (filter?: string, opts?: { live?: boolean }) => {
    if (!opts?.live) {
      printAvailableModels();
      return;
    }

    printInfo('Fetching live model catalog from OpenRouter...');
    try {
      const models = await fetchLiveOpenRouterModels(filter);
      const shown = models.slice(0, 40);
      console.log(chalk.hex('#00D4FF').bold(`\nOpenRouter live catalog${filter ? ` (filter: "${filter}")` : ''}\n`));
      for (const m of shown) {
        const price = m.promptPerM === 0 && m.completionPerM === 0
          ? chalk.green('free')
          : chalk.dim(`$${m.promptPerM.toFixed(2)} / $${m.completionPerM.toFixed(2)} per M tokens`);
        console.log(`  ${chalk.white(m.id.padEnd(52))} ${price}`);
      }
      if (models.length > shown.length) {
        console.log(chalk.dim(`\n  ...and ${models.length - shown.length} more. Narrow with: trident models <filter> --live`));
      }
      console.log('');
    } catch (err) {
      printError(`Could not fetch live catalog: ${err instanceof Error ? err.message : String(err)}`);
      printInfo('Falling back to the built-in list:');
      printAvailableModels();
    }
  });

program
  .command('serve')
  .description('Start the TRIDENT web server (Trident Web UI + WebSocket agent API)')
  .option('--port <n>', 'Port to listen on', '7777')
  .option('--host <host>', 'Host to bind (default localhost only)', '127.0.0.1')
  .action(async (opts: { port?: string; host?: string }) => {
    const port = resolvePositiveInteger(opts.port, 7777, 'port');
    const host = opts.host || '127.0.0.1';

    let config: TridentConfig;
    try {
      config = getConfig();
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err));
      printInfo('Run "trident heal --reset-config" to recover the config.');
      process.exit(1);
      return;
    }

    const provider = resolveProvider(undefined, config.provider, config.model);
    if (provider === 'codex') {
      printError('trident serve requires the anthropic or openrouter provider (codex is CLI-only).');
      printInfo('Switch with: trident config provider anthropic');
      process.exit(1);
      return;
    }

    const envKey = provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY';
    if (!process.env[envKey]) {
      printError(`${envKey} is not set - tasks from the web UI will fail.`);
      printInfo(`Run: ${formatEnvAssignment(envKey, provider === 'openrouter' ? 'sk-or-...' : 'sk-ant-...')}`);
    }

    const cwd = process.cwd();
    printLogo();
    printInfo('Loading project context...');
    const ctx = await loadOrCreateContext(cwd);

    let mcp: McpManager | null = null;
    try {
      const mcpConfig = await loadMcpConfig(cwd);
      if (mcpConfig && Object.keys(mcpConfig.mcpServers).length > 0) {
        printInfo(`Connecting MCP servers: ${Object.keys(mcpConfig.mcpServers).join(', ')}...`);
        mcp = await McpManager.connect(mcpConfig, cwd);
      }
    } catch (err) {
      printWarn(`MCP config error: ${err instanceof Error ? err.message : String(err)} (continuing without MCP)`);
    }

    const { startServer } = await import('./server/index.js');
    const server = await startServer({
      port,
      host,
      cwd,
      provider: provider as AgentProviderName,
      model: config.model,
      mode: config.mode,
      maxTurns: config.maxTurns,
      budgetUsd: config.budgetUsd,
      logSessions: config.logSessions,
      systemPrompt: buildSystemPrompt(ctx, { systemOverride: config.systemOverride }),
      protectedPaths: parseDoNotTouch(ctx.tridentMdContent),
      userName: config.userName,
      projectName: ctx.name,
      mcp,
    });

    printSuccess(`TRIDENT Web is live at ${server.url}`);
    printInfo(`WebSocket agent API: ws://${host}:${port}/ws`);
    printInfo(`Workspace: ${cwd} - mode: ${config.mode.toUpperCase()} - model: ${config.model}`);
    printInfo('Press Ctrl+C to stop.');

    const shutdown = async (): Promise<void> => {
      server.close();
      await mcp?.close();
      process.exit(0);
    };
    process.on('SIGINT', () => { void shutdown(); });
    process.on('SIGTERM', () => { void shutdown(); });
  });

program
  .command('mcp')
  .description('List configured MCP servers and the tools they expose')
  .action(async () => {
    const cwd = process.cwd();
    let config;
    try {
      config = await loadMcpConfig(cwd);
    } catch (err) {
      printError(`Invalid MCP config: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
      return;
    }

    if (!config || Object.keys(config.mcpServers).length === 0) {
      printInfo(`No MCP servers configured. Create ${mcpConfigPath(cwd)} like:`);
      console.log(chalk.dim(JSON.stringify({
        mcpServers: {
          filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
        },
      }, null, 2)));
      return;
    }

    printInfo(`Connecting ${Object.keys(config.mcpServers).length} MCP server(s)...`);
    const manager = await McpManager.connect(config, cwd);

    console.log(chalk.hex('#00D4FF').bold('\nTRIDENT MCP Servers\n'));
    for (const status of manager.getStatuses()) {
      if (status.connected) {
        console.log(`  ${chalk.green('OK')} ${chalk.white(status.name.padEnd(20))} ${chalk.dim(`${status.toolCount} tool(s)`)}`);
      } else {
        console.log(`  ${chalk.red('NO')} ${chalk.white(status.name.padEnd(20))} ${chalk.red(status.error || 'failed to connect')}`);
      }
    }

    const defs = manager.getToolDefinitions();
    if (defs.length > 0) {
      console.log(chalk.bold('\n  Tools exposed to the agent\n'));
      for (const def of defs) {
        console.log(`    ${chalk.white(def.name.padEnd(40))} ${chalk.dim(def.description.slice(0, 70))}`);
      }
    }
    console.log('');
    await manager.close();
  });

program
  .command('costs')
  .description('Aggregate spend across logged sessions')
  .action(async () => {
    const summaries = await collectTaskSummaries();
    if (summaries.length === 0) {
      printInfo('No cost data found. Task costs are recorded when logSessions is on.');
      return;
    }

    const byDay = new Map<string, { tasks: number; cost: number; tokens: number }>();
    for (const s of summaries) {
      const day = s.timestamp.slice(0, 10);
      const agg = byDay.get(day) || { tasks: 0, cost: 0, tokens: 0 };
      agg.tasks++;
      agg.cost += s.cost;
      agg.tokens += s.inputTokens + s.outputTokens;
      byDay.set(day, agg);
    }

    console.log(chalk.hex('#00D4FF').bold('\nTRIDENT Cost Report\n'));
    console.log('  ' + chalk.gray('date'.padEnd(12)) + chalk.gray('tasks'.padEnd(8)) + chalk.gray('tokens'.padEnd(12)) + chalk.gray('cost'));
    let totalCost = 0;
    let totalTasks = 0;
    for (const [day, agg] of [...byDay.entries()].sort()) {
      console.log('  ' + chalk.white(day.padEnd(12)) + chalk.white(String(agg.tasks).padEnd(8)) + chalk.white(agg.tokens.toLocaleString().padEnd(12)) + chalk.hex('#F5C97A')('$' + agg.cost.toFixed(4)));
      totalCost += agg.cost;
      totalTasks += agg.tasks;
    }
    console.log('');
    console.log('  ' + chalk.bold(`total: ${totalTasks} task(s), $${totalCost.toFixed(4)}`));
    console.log('');
  });

program
  .command('test-fix')
  .description('Run the project test command and let the agent fix failures until green')
  .option('--max-attempts <n>', 'Maximum fix attempts', '3')
  .action(async (opts: { maxAttempts?: string }) => {
    const maxAttempts = resolvePositiveInteger(opts.maxAttempts, 3, 'max attempts');
    let config: TridentConfig;
    try {
      config = getConfig();
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err));
      printInfo('Run "trident heal --reset-config" to recover the config.');
      process.exit(1);
      return;
    }

    const cwd = process.cwd();
    printLogo();
    printInfo('Loading project context...');
    const ctx = await loadOrCreateContext(cwd);
    const testCmd = ctx.commands.test;
    if (!testCmd) {
      printError('No test command detected for this project (no test script/config found).');
      process.exit(1);
      return;
    }

    const provider = resolveProvider(undefined, config.provider, config.model);
    const model = provider === 'codex' ? (config.codexModel || 'codex default') : config.model;
    const systemPrompt = buildSystemPrompt(ctx, { systemOverride: config.systemOverride });
    const history: ChatMessage[] = [];
    const isWindows = process.platform === 'win32';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      printSectionHeader(`test-fix - attempt ${attempt}/${maxAttempts} - ${testCmd}`);
      const run = await execa(isWindows ? 'cmd' : 'bash', [isWindows ? '/c' : '-c', testCmd], {
        cwd,
        all: true,
        reject: false,
        timeout: 300_000,
      });
      const output = typeof run.all === 'string' ? run.all : String(run.all ?? '');

      if ((run.exitCode ?? 1) === 0 && !run.timedOut) {
        printSuccess(`Tests pass (attempt ${attempt}).`);
        return;
      }

      printWarn(`Tests failed (exit ${run.timedOut ? 'timeout' : run.exitCode}).`);
      if (attempt === maxAttempts) {
        printError(`Still failing after ${maxAttempts} attempt(s). Last output tail:`);
        console.log(chalk.dim(output.slice(-2000)));
        process.exit(1);
        return;
      }

      const task = [
        `The project test command "${testCmd}" is failing. Investigate the failures, fix the code (or the tests if they are wrong), and re-run the tests to verify.`,
        '',
        'Test output (tail):',
        output.slice(-6000),
      ].join('\n');

      await executeTask(task, {
        model,
        mode: config.mode,
        provider,
        maxTurns: config.maxTurns,
        budgetUsd: config.budgetUsd,
        logSessions: config.logSessions,
        systemPrompt,
        profile: null,
        codexTimeoutMs: config.codexTimeoutMs,
        cwd,
        askUserFn: async (question: string): Promise<string> => {
          const { answer } = await inquirer.prompt([
            { type: 'input', name: 'answer', message: chalk.hex('#00D4FF')(question) },
          ]);
          return answer;
        },
        history,
        protectedPaths: parseDoNotTouch(ctx.tridentMdContent),
      });
    }
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
  .option('--risk <level>', 'Only show actions at this risk level: read | write | execute | destructive')
  .option('--denied', 'Only show actions that were denied')
  .action(async (opts: { risk?: string; denied?: boolean }) => {
    if (opts.risk && !['read', 'write', 'execute', 'destructive'].includes(opts.risk.toLowerCase())) {
      printError('Invalid --risk. Use: read | write | execute | destructive');
      process.exit(1);
      return;
    }

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

    let entries = loaded.entries.filter((e) => !e.toolName.startsWith('__'));
    if (opts.risk) {
      const level = opts.risk.toLowerCase();
      entries = entries.filter((e) => e.riskLevel === level);
    }
    if (opts.denied) {
      entries = entries.filter((e) => !e.approved);
    }

    console.log(chalk.cyan(`\nSession: ${loaded.file.replace('.jsonl', '')}\n`));
    if (entries.length === 0) {
      printInfo('No matching actions in this session.');
      return;
    }
    for (const entry of entries) {
      const icon = entry.approved ? chalk.green('OK') : chalk.red('NO');
      const time = new Date(entry.timestamp).toLocaleTimeString();
      const risk = entry.riskLevel ? chalk.dim(`[${entry.riskLevel}]`) : '';
      console.log(`  ${icon} [${chalk.dim(time)}] ${chalk.bold(entry.toolName)} ${risk} ${chalk.dim(JSON.stringify(entry.input).slice(0, 60))}`);
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
  taskId: string;
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
    continue?: boolean;
    output?: string;
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

  if (cliOpts?.output && !['text', 'json'].includes(cliOpts.output)) {
    printError(`Invalid --output "${cliOpts.output}". Use: text | json`);
    process.exit(1);
    return;
  }
  const jsonOut = cliOpts?.output === 'json' && !!initialTask;

  if (!config.onboarded && !jsonOut) {
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

  if (!jsonOut) {
    printLogo();
    printInfo('Loading project context...');
  }
  const ctx = await loadOrCreateContext(cwd);
  const resumedState = cliOpts?.continue ? await loadSessionState(cwd) : null;
  if (cliOpts?.continue && !resumedState && !jsonOut) {
    printWarn('No previous conversation found for this directory - starting fresh.');
  }

  // Connect configured MCP servers (stdio) so their tools reach the agent.
  let mcp: McpManager | null = null;
  try {
    const mcpConfig = await loadMcpConfig(cwd);
    if (mcpConfig && Object.keys(mcpConfig.mcpServers).length > 0) {
      if (!jsonOut) {
        printInfo(`Connecting MCP servers: ${Object.keys(mcpConfig.mcpServers).join(', ')}...`);
      }
      mcp = await McpManager.connect(mcpConfig, cwd);
      if (!jsonOut) {
        for (const status of mcp.getStatuses()) {
          if (status.connected) {
            printInfo(`MCP ${status.name}: ${status.toolCount} tool(s) available`);
          } else {
            printWarn(`MCP ${status.name}: ${status.error || 'failed to connect'}`);
          }
        }
      }
    }
  } catch (err) {
    if (!jsonOut) {
      printWarn(`MCP config error: ${err instanceof Error ? err.message : String(err)} (continuing without MCP)`);
    }
  }
  const getSystemPrompt = (): string => buildSystemPrompt(ctx, {
    profile: activeProfile,
    systemOverride,
  });
  const getProtectedPaths = (): string[] => parseDoNotTouch(ctx.tridentMdContent);

  if (!jsonOut) {
    printSessionHeader({ model, mode, provider, project: ctx.name, hasTridentMd: !!ctx.tridentMdContent, profile: activeProfile?.name });

    if (!ctx.tridentMdContent) {
      printInfo("No TRIDENT.md found. Run 'trident init' to generate one for better AI context.");
    }
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
    const oneShotHistory: ChatMessage[] = resumedState ? [...resumedState.history] : [];
    const result = await executeTask(initialTask, {
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
      protectedPaths: getProtectedPaths(),
      history: oneShotHistory,
      quiet: jsonOut,
      mcp,
    });
    await mcp?.close();

    if (provider !== 'codex') {
      await saveSessionState({
        cwd,
        savedAt: new Date().toISOString(),
        history: oneShotHistory,
        taskHistory: [
          ...(resumedState?.taskHistory || []),
          { task: initialTask, summary: result?.summary || '(failed)', cost: result?.totalCost || 0 },
        ],
        lastTask: initialTask,
      });
    }

    if (jsonOut) {
      console.log(JSON.stringify(result ?? { success: false, summary: 'Task failed before completion.', turns: 0, totalCost: 0, totalTokens: { input: 0, output: 0 } }));
    }
    if (result === null) {
      process.exitCode = 1;
    }
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
  // Shared conversation memory: follow-up tasks see earlier turns.
  const agentHistory: ChatMessage[] = [];
  let lastTask: string | null = null;

  if (resumedState) {
    agentHistory.push(...resumedState.history);
    taskHistory.push(...resumedState.taskHistory);
    lastTask = resumedState.lastTask;
    printInfo(`Resumed conversation from ${new Date(resumedState.savedAt).toLocaleString()} (${resumedState.taskHistory.length} earlier task(s)).`);
  }

  const persistSession = async (): Promise<void> => {
    await saveSessionState({
      cwd,
      savedAt: new Date().toISOString(),
      history: agentHistory,
      taskHistory,
      lastTask,
    });
  };

  const runInteractiveTask = async (task: string): Promise<void> => {
    lastTask = task;

    if (session.budgetUsd !== undefined && session.cost >= session.budgetUsd) {
      printWarn(`Session budget reached ($${session.budgetUsd.toFixed(2)}). Raise it with /budget <usd> to continue.`);
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
      history: agentHistory,
      protectedPaths: getProtectedPaths(),
      mcp,
    });

    if (result) {
      session.cost += result.totalCost;
      session.tokens.input += result.totalTokens.input;
      session.tokens.output += result.totalTokens.output;
      session.turns += result.turns;
      taskHistory.push({ task, summary: result.summary, cost: result.totalCost });
      if (session.provider !== 'codex') {
        await persistSession();
      }
    }
  };

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
        await mcp?.close();
        process.exit(0);
        return true;

      case 'mcp': {
        if (!mcp) {
          printInfo(`No MCP servers connected. Configure them in ${mcpConfigPath(cwd)} and restart.`);
          return true;
        }
        console.log('');
        console.log('  ' + chalk.hex('#5EEAD4').bold('MCP servers'));
        for (const status of mcp.getStatuses()) {
          if (status.connected) {
            console.log(`    ${chalk.green('OK')} ${chalk.white(status.name.padEnd(18))} ${chalk.dim(`${status.toolCount} tool(s)`)}`);
          } else {
            console.log(`    ${chalk.red('NO')} ${chalk.white(status.name.padEnd(18))} ${chalk.red(status.error || 'failed')}`);
          }
        }
        for (const def of mcp.getToolDefinitions()) {
          console.log(`      ${chalk.hex('#94A3B8')(def.name)}`);
        }
        console.log('');
        return true;
      }

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
        await runInteractiveTask(lastTask);
        return true;
      }

      case 'undo': {
        if (undoStack.length === 0) {
          printWarn('Nothing to undo.');
          return true;
        }
        // Revert every file the last task touched, newest snapshot first.
        const taskId = undoStack[undoStack.length - 1].taskId;
        const entries: UndoEntry[] = [];
        while (undoStack.length > 0 && undoStack[undoStack.length - 1].taskId === taskId) {
          entries.push(undoStack.pop()!);
        }
        let reverted = 0;
        for (const entry of entries) {
          try {
            if (entry.originalContent === null) {
              await fsUnlink(entry.path);
              printSuccess(`Undo: deleted ${entry.path}`);
            } else {
              await fsWriteFile(entry.path, entry.originalContent, 'utf-8');
              printSuccess(`Undo: restored ${entry.path}`);
            }
            reverted++;
          } catch (err) {
            printError(`Undo failed for ${entry.path}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (reverted > 1) {
          printInfo(`Reverted ${reverted} file(s) changed by the last task.`);
        }
        return true;
      }

      case 'compact': {
        if (taskHistory.length === 0 && agentHistory.length === 0) {
          printInfo('No history to compact.');
          return true;
        }
        const kept = taskHistory.slice(-3);
        taskHistory.length = 0;
        taskHistory.push(...kept);

        // Replace the full conversation with a short recap so follow-up tasks
        // keep the gist without the token weight.
        agentHistory.length = 0;
        if (kept.length > 0) {
          const recap = kept
            .map((t, i) => `${i + 1}. ${t.task} -> ${t.summary.slice(0, 200)}`)
            .join('\n');
          agentHistory.push({ role: 'user', content: `Recap of earlier tasks in this session:\n${recap}` });
          agentHistory.push({ role: 'assistant', content: 'Recap noted. Ready for the next task.' });
        }

        undoStack.length = 0;
        await persistSession();
        printSuccess(`Compacted - conversation memory reduced to a recap of the last ${kept.length} task(s); undo stack cleared.`);
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

      case 'diff': {
        if (!(await isGitRepo(cwd))) {
          printWarn('Not a git repository.');
          return true;
        }
        const status = await execa('git', ['status', '--short'], { cwd, reject: false });
        const diff = await execa('git', ['diff', '--color=always'], { cwd, reject: false });
        if (!status.stdout.trim() && !diff.stdout.trim()) {
          printInfo('Working tree clean - nothing to show.');
          return true;
        }
        console.log('');
        console.log('  ' + chalk.hex('#5EEAD4').bold('Working tree changes'));
        console.log('');
        if (status.stdout.trim()) {
          for (const line of status.stdout.split('\n')) {
            console.log('  ' + line);
          }
          console.log('');
        }
        const diffLines = diff.stdout ? diff.stdout.split('\n') : [];
        const shown = diffLines.slice(0, 300);
        for (const line of shown) {
          console.log('  ' + line);
        }
        if (diffLines.length > shown.length) {
          console.log(chalk.dim(`  ...${diffLines.length - shown.length} more line(s). Run git diff for the full view.`));
        }
        console.log('');
        return true;
      }

      case 'commit': {
        if (!(await isGitRepo(cwd))) {
          printWarn('Not a git repository.');
          return true;
        }
        const status = await execa('git', ['status', '--porcelain'], { cwd, reject: false });
        if (!status.stdout.trim()) {
          printInfo('Nothing to commit - working tree clean.');
          return true;
        }

        let message = arg;
        if (!message) {
          if (session.provider === 'codex') {
            printError('AI commit messages need the anthropic or openrouter provider. Use: /commit <message>');
            return true;
          }
          if (!(await ensureProviderReady(session.provider, true))) {
            return true;
          }
          printInfo('Generating commit message...');
          const diffOut = await execa('git', ['diff', 'HEAD'], { cwd, reject: false });
          const context = `Changed files:\n${status.stdout}\n\nDiff:\n${(diffOut.stdout || '').slice(0, 8000)}`;
          try {
            message = await generateCommitMessage(session.provider as AgentProviderName, session.model, context);
          } catch (err) {
            printError(`Could not generate a message (${err instanceof Error ? err.message : String(err)}). Use: /commit <message>`);
            return true;
          }
          if (!message) {
            printError('Could not generate a message. Use: /commit <message>');
            return true;
          }
          printInfo(`Message: ${chalk.white(message)}`);
        }

        await execa('git', ['add', '-A'], { cwd, reject: false });
        const commit = await execa('git', ['commit', '-m', message], { cwd, reject: false, all: true });
        if ((commit.exitCode ?? 1) === 0) {
          printSuccess(commit.stdout.split('\n')[0] || 'Committed.');
        } else {
          printError(`Commit failed: ${String(commit.all || '').slice(0, 200)}`);
        }
        return true;
      }

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

      default: {
        // Project-defined commands: .trident/commands/<name>.md
        const customPath = join(cwd, '.trident', 'commands', `${head.toLowerCase()}.md`);
        if (existsSync(customPath)) {
          let template: string;
          try {
            template = await fsReadFile(customPath, 'utf-8');
          } catch (err) {
            printError(`Could not read ${customPath}: ${err instanceof Error ? err.message : String(err)}`);
            return true;
          }
          const task = template.includes('$ARGS')
            ? template.replaceAll('$ARGS', arg)
            : arg
              ? `${template}\n\nAdditional arguments: ${arg}`
              : template;
          printInfo(`Running custom command /${head.toLowerCase()}`);
          await runInteractiveTask(task.trim());
          return true;
        }

        printWarn(`Unknown command: /${head}. Type / then Enter for the menu, or /help for the list.`);
        return true;
      }
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

    // Shell passthrough: !cmd runs directly without the agent.
    if (task.startsWith('!')) {
      const cmd = task.slice(1).trim();
      if (!cmd) {
        printWarn('Usage: !<shell command>');
        return;
      }
      const isWindows = process.platform === 'win32';
      try {
        const res = await execa(isWindows ? 'cmd' : 'bash', [isWindows ? '/c' : '-c', cmd], {
          cwd,
          stdio: 'inherit',
          reject: false,
        });
        if ((res.exitCode ?? 0) !== 0) {
          printWarn(`Exit code: ${res.exitCode}`);
        }
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
      }
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

    await runInteractiveTask(task);
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
    history?: ChatMessage[];
    protectedPaths?: string[];
    quiet?: boolean;
    mcp?: McpManager | null;
  }
): Promise<Awaited<ReturnType<typeof runAgentLoop>> | null> {
  task = expandFileMentions(task, opts.cwd);

  if (!opts.quiet) {
    printSectionHeader(`FORGE - ${opts.provider} - ${opts.model}`);
    console.log(chalk.dim(`  ${task.split('\n')[0]}`));
    console.log('');
  }

  if (opts.provider === 'codex') {
    if (!opts.quiet) {
      printInfo(`Running Codex CLI${opts.profile ? ` with ${opts.profile.name}` : ''} (${opts.mode} -> ${codexSandboxForMode(opts.mode)} sandbox).`);
    }
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
      if (!opts.quiet) {
        printFinalSummary(result);
        if (!codexResult.success) {
          printWarn('Codex CLI did not complete successfully. Run "codex doctor" for details.');
        }
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
    // Only the first snapshot per task matters: /undo restores pre-task state.
    if (opts.undoStack.some((e) => e.taskId === sessionId && e.path === filePath)) {
      return;
    }
    let originalContent: string | null = null;
    try {
      originalContent = await fsReadFile(filePath, 'utf-8');
    } catch {
      // File did not exist before this change.
    }
    opts.undoStack.push({ taskId: sessionId, path: filePath, originalContent });
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
      onText: opts.quiet ? undefined : printAgentText,
      onToolStart: opts.quiet ? undefined : onToolStart,
      beforeToolExecute,
      onToolEnd: opts.quiet ? undefined : printToolEnd,
      askUserFn: opts.askUserFn,
      history: opts.history,
      protectedPaths: opts.protectedPaths,
      showDiffs: !opts.quiet,
      mcp: opts.mcp,
    });

    if (!opts.quiet) {
      printFinalSummary(result);
    }
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

async function isGitRepo(cwd: string): Promise<boolean> {
  const res = await execa('git', ['rev-parse', '--is-inside-work-tree'], { cwd, reject: false });
  return (res.exitCode ?? 1) === 0;
}

async function generateCommitMessage(
  provider: AgentProviderName,
  model: string,
  changes: string
): Promise<string> {
  const prompt = `Write a single-line conventional commit message (max 72 characters) for the following changes. Respond with ONLY the message - no quotes, no explanation.\n\n${changes}`;
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
  const streamOpts = {
    model,
    maxTokens: 100,
    systemPrompt: 'You write concise conventional commit messages.',
    tools: [] as unknown[],
  };
  const stream = provider === 'openrouter'
    ? streamOpenRouter(messages, { ...streamOpts, apiKey: process.env.OPENROUTER_API_KEY || '' })
    : streamCompletion(messages, streamOpts);

  let text = '';
  for await (const chunk of stream) {
    if (chunk.type === 'text' && chunk.text) {
      text += chunk.text;
    }
  }
  return text.trim().split('\n')[0].replace(/^["'`]+|["'`]+$/g, '').slice(0, 100);
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

interface TaskSummary {
  timestamp: string;
  cost: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

async function collectTaskSummaries(): Promise<TaskSummary[]> {
  const { homedir } = await import('os');
  const { readFile } = await import('fs/promises');
  const logDir = join(homedir(), '.trident', 'logs');
  const files = await getRecentSessionLogFiles();
  const summaries: TaskSummary[] = [];

  for (const file of files) {
    let content: string;
    try {
      content = await readFile(join(logDir, file), 'utf-8');
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { timestamp?: string; toolName?: string; result?: { output?: string } };
        if (entry.toolName !== '__task_summary' || !entry.result?.output) continue;
        const stats = JSON.parse(entry.result.output) as { cost?: number; turns?: number; inputTokens?: number; outputTokens?: number };
        summaries.push({
          timestamp: entry.timestamp || '',
          cost: Number(stats.cost) || 0,
          turns: Number(stats.turns) || 0,
          inputTokens: Number(stats.inputTokens) || 0,
          outputTokens: Number(stats.outputTokens) || 0,
        });
      } catch {
        continue;
      }
    }
  }

  return summaries;
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
    riskLevel?: string;
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
          riskLevel?: string;
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
