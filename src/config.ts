import Conf from 'conf';
import { z } from 'zod';

export const ConfigSchema = z.object({
  model: z.string().default('claude-sonnet-4-6'),
  provider: z.enum(['anthropic', 'openrouter']).default('anthropic'),
  mode: z.enum(['yolo', 'review', 'lockdown']).default('review'),
  maxTurns: z.number().default(50),
  budgetUsd: z.number().optional(),
  theme: z.object({
    primary: z.string().default('#00D4FF'),
    accent: z.string().default('#FFD700'),
    danger: z.string().default('#FF4444'),
  }).default({}),
  logSessions: z.boolean().default(true),
  onboarded: z.boolean().default(false),
  userName: z.string().default(''),
  commandTimeout: z.number().default(30_000),
  searchMaxFiles: z.number().default(100),
  parallelTools: z.number().default(3),
  disabledTools: z.array(z.string()).default([]),
});

export type TridentConfig = z.infer<typeof ConfigSchema>;

const DEFAULT_MODEL = 'claude-sonnet-4-6';

const store = new Conf<TridentConfig>({
  projectName: 'trident-cli',
  schema: {
    model: { type: 'string', default: DEFAULT_MODEL },
    provider: { type: 'string', default: 'anthropic' },
    mode: { type: 'string', default: 'review' },
    maxTurns: { type: 'number', default: 50 },
    budgetUsd: { type: 'number' },
    theme: { type: 'object' },
    logSessions: { type: 'boolean', default: true },
    onboarded: { type: 'boolean', default: false },
    userName: { type: 'string', default: '' },
    commandTimeout: { type: 'number', default: 30_000 },
    searchMaxFiles: { type: 'number', default: 100 },
    parallelTools: { type: 'number', default: 3 },
    disabledTools: { type: 'array', items: { type: 'string' }, default: [] },
  },
});

export function getConfig(): TridentConfig {
  return {
    model: (store.get('model') as string) || DEFAULT_MODEL,
    provider: (store.get('provider') as TridentConfig['provider']) || 'anthropic',
    mode: (store.get('mode') as TridentConfig['mode']) || 'review',
    maxTurns: (store.get('maxTurns') as number) || 50,
    budgetUsd: store.get('budgetUsd') as number | undefined,
    theme: (store.get('theme') as TridentConfig['theme']) || {
      primary: '#00D4FF',
      accent: '#FFD700',
      danger: '#FF4444',
    },
    logSessions: (store.get('logSessions') as boolean) ?? true,
    onboarded: (store.get('onboarded') as boolean) ?? false,
    userName: (store.get('userName') as string) || '',
    commandTimeout: (store.get('commandTimeout') as number) || 30_000,
    searchMaxFiles: (store.get('searchMaxFiles') as number) || 100,
    parallelTools: (store.get('parallelTools') as number) || 3,
    disabledTools: (store.get('disabledTools') as string[]) || [],
  };
}

export function setConfig(key: keyof TridentConfig, value: unknown): void {
  store.set(key, value);
}

export function getConfigPath(): string {
  return store.path;
}