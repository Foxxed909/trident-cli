import Conf from 'conf';
import { z } from 'zod';
import { TRAINED_PROFILE_NAMES } from './profiles.js';

export const ConfigSchema = z.object({
  model: z.string().min(1).default('claude-sonnet-4-6'),
  provider: z.enum(['anthropic', 'openrouter', 'codex']).default('anthropic'),
  mode: z.enum(['yolo', 'review', 'lockdown']).default('review'),
  maxTurns: z.number().int().positive().default(50),
  budgetUsd: z.number().positive().optional(),
  logSessions: z.boolean().default(true),
  allowedCommands: z.array(z.string()).default([]),
  onboarded: z.boolean().default(false),
  userName: z.string().default(''),
  profile: z.enum(TRAINED_PROFILE_NAMES).optional(),
  systemOverride: z.string().default(''),
  codexModel: z.string().default(''),
  codexTimeoutMs: z.number().int().positive().default(180_000),
}).strict();

export type TridentConfig = z.infer<typeof ConfigSchema>;
type RawConfig = Record<string, unknown>;

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const LEGACY_CONFIG_KEYS = new Set(['plan', 'theme']);

const store = new Conf<RawConfig>({
  projectName: 'trident-cli',
});

export function getConfig(): TridentConfig {
  const parsed = ConfigSchema.safeParse(getRawConfig());
  if (parsed.success) {
    return parsed.data;
  }

  const issue = parsed.error.issues[0];
  const path = issue.path.length > 0 ? issue.path.join('.') : 'config';
  throw new Error(`Invalid config at ${path}: ${issue.message}`);
}

export function setConfig(key: keyof TridentConfig, value: unknown): void {
  store.set(key, value);
}

export function deleteConfig(key: keyof TridentConfig): void {
  store.delete(key);
}

export function getRawConfig(): RawConfig {
  migrateLegacyConfigKeys();
  return { ...store.store };
}

export function getDefaultConfig(): TridentConfig {
  return ConfigSchema.parse({});
}

export function resetConfigToDefaults(): void {
  for (const key of Object.keys(getRawConfig())) {
    store.delete(key);
  }

  const defaults = getDefaultConfig();
  for (const [key, value] of Object.entries(defaults)) {
    store.set(key, value);
  }
}

export function getConfigPath(): string {
  return store.path;
}

function migrateLegacyConfigKeys(): void {
  for (const key of LEGACY_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(store.store, key)) {
      store.delete(key);
    }
  }
}
