import chalk from 'chalk';
import inquirer from 'inquirer';
import { deleteConfig, setConfig } from '../config.js';
import { isCodexCliAvailable } from '../providers/codex.js';
import { listTrainedProfiles } from '../profiles.js';
import { formatEnvAssignment, shellProfileHint } from '../util.js';

const TEAL = '#5EEAD4';
const AMBER = '#F5C97A';
const SLATE = '#94A3B8';
const ROSE = '#F87171';

function hr(char = '-', width = 60): string {
  return chalk.hex(SLATE).dim(char.repeat(width));
}

function printOnboardingLogo(): void {
  console.clear();
  console.log('');
  console.log(chalk.hex(TEAL).bold('  +------------------------------------------------------+'));
  console.log(chalk.hex(TEAL).bold('  |') + '                                                      ' + chalk.hex(TEAL).bold('|'));
  console.log(chalk.hex(TEAL).bold('  |') + '   ' + chalk.hex(AMBER).bold('TRIDENT - First Run Setup') + '                           ' + chalk.hex(TEAL).bold('|'));
  console.log(chalk.hex(TEAL).bold('  |') + '   ' + chalk.hex(SLATE)('Three Prongs. One Power. All Yours.') + '                 ' + chalk.hex(TEAL).bold('|'));
  console.log(chalk.hex(TEAL).bold('  |') + '                                                      ' + chalk.hex(TEAL).bold('|'));
  console.log(chalk.hex(TEAL).bold('  +------------------------------------------------------+'));
  console.log('');
  console.log('  ' + chalk.hex(SLATE)("Let's get you set up in about 30 seconds."));
  console.log('');
}

function section(title: string): void {
  console.log('');
  console.log('  ' + hr('-', 54));
  console.log('  ' + chalk.hex(TEAL).bold(`> ${title}`));
  console.log('');
}

const ANTHROPIC_MODELS = [
  { name: 'claude-opus-4-7 - most powerful, $15/$75 per M tok', value: 'claude-opus-4-7' },
  { name: 'claude-sonnet-4-6 - balanced, $3/$15 per M tok (recommended)', value: 'claude-sonnet-4-6' },
  { name: 'claude-haiku-4-5-20251001 - fast and cheap, $0.25/$1.25', value: 'claude-haiku-4-5-20251001' },
];

const OPENROUTER_MODELS = [
  { name: 'openai/gpt-4o - GPT-4o', value: 'openai/gpt-4o' },
  { name: 'openai/o3-mini - o3-mini reasoning', value: 'openai/o3-mini' },
  { name: 'google/gemini-2.0-flash-001 - Gemini Flash', value: 'google/gemini-2.0-flash-001' },
  { name: 'meta-llama/llama-4-maverick - Llama 4 Maverick', value: 'meta-llama/llama-4-maverick' },
  { name: 'anthropic/claude-sonnet-4-6 - Sonnet via OpenRouter', value: 'anthropic/claude-sonnet-4-6' },
  { name: 'openai/gpt-oss-120b:free - GPT OSS 120B (FREE)', value: 'openai/gpt-oss-120b:free' },
  { name: 'openai/gpt-oss-20b:free - GPT OSS 20B (FREE)', value: 'openai/gpt-oss-20b:free' },
  { name: 'nvidia/nemotron-3-super-120b-a12b:free - Nemotron 120B (FREE)', value: 'nvidia/nemotron-3-super-120b-a12b:free' },
];

export async function runOnboarding(): Promise<void> {
  printOnboardingLogo();

  section('Who are you?');
  const { userName } = await inquirer.prompt([
    {
      type: 'input',
      name: 'userName',
      message: chalk.hex(TEAL)('What should TRIDENT call you?'),
      default: 'Operator',
      validate: (v: string) => v.trim().length > 0 || 'Name cannot be empty.',
    },
  ]);

  section('Permission Mode');
  console.log('  ' + chalk.hex(SLATE)('Controls how TRIDENT asks before taking actions.'));
  console.log('');
  const { mode } = await inquirer.prompt([
    {
      type: 'list',
      name: 'mode',
      message: chalk.hex(TEAL)('Choose a default permission mode:'),
      choices: [
        {
          name: chalk.hex(TEAL).bold('review') + chalk.hex(SLATE)(' - auto-approve reads; ask for writes, shell, deletes  ') + chalk.hex(AMBER)('(recommended)'),
          value: 'review',
        },
        {
          name: chalk.hex(ROSE).bold('yolo') + chalk.hex(SLATE)(' - approve everything automatically'),
          value: 'yolo',
        },
        {
          name: chalk.hex(AMBER).bold('lockdown') + chalk.hex(SLATE)(' - ask before every single action'),
          value: 'lockdown',
        },
      ],
      default: 'review',
    },
  ]);

  section('AI Provider');
  const { provider } = await inquirer.prompt([
    {
      type: 'list',
      name: 'provider',
      message: chalk.hex(TEAL)('Which AI provider do you want to use?'),
      choices: [
        {
          name: chalk.hex(TEAL).bold('anthropic') + chalk.hex(SLATE)(' - Claude models directly from Anthropic'),
          value: 'anthropic',
        },
        {
          name: chalk.hex(AMBER).bold('openrouter') + chalk.hex(SLATE)(' - GPT-4o, Gemini, Llama, and more via OpenRouter'),
          value: 'openrouter',
        },
        {
          name: chalk.hex(AMBER).bold('codex') + chalk.hex(SLATE)(' - local Codex CLI with TRIDENT trained profiles'),
          value: 'codex',
        },
      ],
      default: 'anthropic',
    },
  ]);

  let model = '';
  let profile = '';

  if (provider === 'codex') {
    section('Codex CLI');
    if (await isCodexCliAvailable()) {
      console.log('  ' + chalk.hex(TEAL)(`${figOk()} Codex CLI is available.`));
    } else {
      console.log('  ' + chalk.hex(AMBER)('! Codex CLI was not found or did not respond to "codex --version".'));
      console.log('  ' + chalk.hex(SLATE).dim('  Install or repair Codex before running provider=codex tasks.'));
    }
  } else {
    section('API Key');
    const envKey = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENROUTER_API_KEY';
    const alreadySet = !!process.env[envKey];

    if (alreadySet) {
      console.log('  ' + chalk.hex(TEAL)(`${figOk()} ${envKey} is already set in your environment - skipping.`));
    } else {
      const keyUrl = provider === 'anthropic'
        ? 'https://console.anthropic.com/keys'
        : 'https://openrouter.ai/keys';
      console.log('  ' + chalk.hex(SLATE)(`Get your key at: ${keyUrl}`));
      console.log('  ' + chalk.hex(SLATE)('The key is stored in your shell environment, not in TRIDENT config.'));
      console.log('  ' + chalk.hex(AMBER)('You can skip this and set it yourself with:'));
      console.log('  ' + chalk.hex(SLATE).dim(`  ${formatEnvAssignment(envKey, 'your-key-here')}`));
      console.log('');

      const { apiKey } = await inquirer.prompt([
        {
          type: 'password',
          name: 'apiKey',
          message: chalk.hex(TEAL)(`Paste your ${envKey} (or press Enter to skip):`),
          mask: '*',
        },
      ]);

      if (apiKey && apiKey.trim().length > 0) {
        process.env[envKey] = apiKey.trim();
        console.log('');
        console.log('  ' + chalk.hex(TEAL)(`${figOk()} Key set for this session.`));
        console.log('  ' + chalk.hex(SLATE).dim(`  To persist it, add this to ${shellProfileHint()}:`));
        console.log('  ' + chalk.hex(SLATE).dim(`  ${formatEnvAssignment(envKey, `${apiKey.trim().slice(0, 12)}...`)}`));
      } else {
        console.log('');
        console.log('  ' + chalk.hex(AMBER)(`! No key provided - TRIDENT will fail unless ${envKey} is set.`));
      }
    }
  }

  if (provider === 'codex') {
    section('Trained Profile');
    const answer = await inquirer.prompt([
      {
        type: 'list',
        name: 'profile',
        message: chalk.hex(TEAL)('Choose your default trained profile:'),
        choices: listTrainedProfiles().map((p) => ({
          name: `${p.name} - ${p.focus}`,
          value: p.name,
        })),
        default: 'Sydney',
      },
    ]);
    profile = answer.profile;
  } else {
    section('Default Model');
    const modelChoices = provider === 'anthropic' ? ANTHROPIC_MODELS : OPENROUTER_MODELS;
    const answer = await inquirer.prompt([
      {
        type: 'list',
        name: 'model',
        message: chalk.hex(TEAL)('Choose your default model:'),
        choices: modelChoices,
        default: provider === 'anthropic' ? 'claude-sonnet-4-6' : 'openai/gpt-4o',
      },
    ]);
    model = answer.model;
  }

  section('Session Logging');
  console.log('  ' + chalk.hex(SLATE)('TRIDENT can log all agent actions to ~/.trident/logs/'));
  console.log('  ' + chalk.hex(SLATE)('Run "trident review" anytime to inspect past sessions.'));
  console.log('');
  const { logSessions } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'logSessions',
      message: chalk.hex(TEAL)('Enable session logging?'),
      default: true,
    },
  ]);

  setConfig('userName', userName.trim());
  setConfig('mode', mode);
  setConfig('provider', provider);
  if (model) {
    setConfig('model', model);
  }
  if (profile) {
    setConfig('profile', profile);
  } else {
    deleteConfig('profile');
  }
  setConfig('logSessions', logSessions);
  setConfig('onboarded', true);

  console.log('');
  console.log('  ' + hr('=', 54));
  console.log('');
  console.log('  ' + chalk.hex(TEAL).bold(`Welcome aboard, ${userName.trim()}!`));
  console.log('');
  console.log('  ' + chalk.hex(SLATE)('Your setup:'));
  const rows: [string, string][] = [
    ['mode    ', mode],
    ['provider', provider],
    ['model   ', provider === 'codex' ? 'Codex CLI default' : model],
    ['profile ', profile || 'none'],
    ['logging ', logSessions ? 'enabled' : 'disabled'],
  ];
  for (const [key, value] of rows) {
    console.log('    ' + chalk.hex(SLATE)(key) + '  ' + chalk.white(value));
  }
  console.log('');
  console.log('  ' + chalk.hex(SLATE)('You can change any setting anytime:'));
  console.log('  ' + chalk.hex(SLATE).dim('  trident config mode yolo'));
  console.log('  ' + chalk.hex(SLATE).dim('  trident config model claude-opus-4-7'));
  console.log('');
  console.log('  ' + hr('=', 54));
  console.log('');
}

function figOk(): string {
  return 'OK';
}
