import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkspacePath } from '../dist/agent/tools.js';
import { ConfigSchema } from '../dist/config.js';
import { OPENROUTER_MODELS } from '../dist/providers/openrouter.js';
import { TRAINED_PROFILE_NAMES, buildProfileSystemPrompt, resolveProfile } from '../dist/profiles.js';

test('trained profiles are all registered and case-insensitive', () => {
  assert.deepEqual([...TRAINED_PROFILE_NAMES], ['Sydney', 'mercedes', 'Cipher', 'XAVIER', 'Berry-Ski']);
  assert.equal(resolveProfile('sydney')?.name, 'Sydney');
  assert.equal(resolveProfile('BERRY-SKI')?.name, 'Berry-Ski');
  assert.equal(resolveProfile('missing'), null);
});

test('profile prompt includes output override contract', () => {
  const profile = resolveProfile('Cipher');
  assert.ok(profile);
  const prompt = buildProfileSystemPrompt(profile);
  assert.match(prompt, /Output override contract/);
  assert.match(prompt, /operator system override/i);
});

test('config rejects unknown keys and invalid numeric values', () => {
  assert.equal(ConfigSchema.safeParse({ unknownKey: true }).success, false);
  assert.equal(ConfigSchema.safeParse({ maxTurns: 0 }).success, false);
  assert.equal(ConfigSchema.safeParse({ codexTimeoutMs: 1000, provider: 'codex', profile: 'Sydney' }).success, true);
});

test('workspace path guard blocks escapes', () => {
  const root = process.cwd();
  assert.equal(resolveWorkspacePath(root, 'README.md').endsWith('README.md'), true);
  assert.throws(() => resolveWorkspacePath(root, '..\\outside.txt'), /Path escapes workspace root/);
});

test('OpenRouter table includes onboarding model ids', () => {
  assert.ok(OPENROUTER_MODELS['anthropic/claude-sonnet-4-6']);
  assert.ok(OPENROUTER_MODELS['openai/gpt-oss-120b:free']);
});
