import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkspacePath } from '../dist/agent/tools.js';
import { ConfigSchema } from '../dist/config.js';
import { OPENROUTER_MODELS } from '../dist/providers/openrouter.js';
import { TRAINED_PROFILE_NAMES, buildProfileSystemPrompt, resolveProfile } from '../dist/profiles.js';
import { getContextLimit, MODEL_CONTEXT_LIMITS } from '../dist/agent/loop.js';
import { calculateCost } from '../dist/providers/anthropic.js';
import { classifyRisk, matchesPermitRule } from '../dist/warden/index.js';

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

test('context limits are correct for known models', () => {
  assert.equal(getContextLimit('claude-sonnet-4-6'), 200000);
  assert.equal(getContextLimit('claude-opus-4-5'), 200000);
  assert.equal(getContextLimit('unknown-model'), 200000); // fallback
  assert.ok(MODEL_CONTEXT_LIMITS['claude-haiku-4-5-20251001'] > 0);
});

test('cost calculation is non-negative and scales with tokens', () => {
  const cost1 = calculateCost('claude-sonnet-4-6', 1000, 500);
  const cost2 = calculateCost('claude-sonnet-4-6', 2000, 500);
  assert.ok(cost1 >= 0, 'cost should be non-negative');
  assert.ok(cost2 > cost1, 'more input tokens = higher cost');
  assert.equal(calculateCost('claude-sonnet-4-6', 0, 0), 0);
});

test('classifyRisk assigns correct levels', () => {
  assert.equal(classifyRisk({ name: 'read_file', input: {} }), 'read');
  assert.equal(classifyRisk({ name: 'write_file', input: {} }), 'write');
  assert.equal(classifyRisk({ name: 'edit_file', input: {} }), 'write');
  assert.equal(classifyRisk({ name: 'delete_file', input: {} }), 'destructive');
  assert.equal(classifyRisk({ name: 'github_api', input: {} }), 'execute');
  assert.equal(classifyRisk({ name: 'run_command', input: { cmd: 'ls' } }), 'execute');
  assert.equal(classifyRisk({ name: 'run_command', input: { cmd: 'rm -rf /tmp/test' } }), 'destructive');
  assert.equal(classifyRisk({ name: 'web_search', input: {} }), 'read');
  assert.equal(classifyRisk({ name: 'read_notebook', input: {} }), 'read');
  assert.equal(classifyRisk({ name: 'spawn_agent', input: {} }), 'execute');
});

test('permit rules matching is correct', () => {
  const rules = [
    { tool: 'read_file', pattern: undefined },
    { tool: 'run_command', pattern: 'npm' },
    { tool: '*', pattern: 'safe' },
  ];

  // Exact tool match, no pattern = always approve
  assert.equal(matchesPermitRule({ name: 'read_file', input: { path: 'anything' } }, rules), true);

  // Pattern match on run_command
  assert.equal(matchesPermitRule({ name: 'run_command', input: { cmd: 'npm install' } }, rules), true);
  assert.equal(matchesPermitRule({ name: 'run_command', input: { cmd: 'rm -rf /' } }, rules), false);

  // Wildcard rule with pattern
  assert.equal(matchesPermitRule({ name: 'delete_file', input: { path: 'safe-file.txt' } }, rules), true);
  assert.equal(matchesPermitRule({ name: 'delete_file', input: { path: 'dangerous.txt' } }, rules), false);

  // No matching rule
  assert.equal(matchesPermitRule({ name: 'github_api', input: { path: '/repos' } }, []), false);
});

test('workspace path guard allows valid subdirectory paths', () => {
  const root = '/tmp';
  assert.equal(resolveWorkspacePath(root, 'src/index.ts').endsWith('src/index.ts'), true);
  assert.equal(resolveWorkspacePath(root, './src/index.ts').endsWith('src/index.ts'), true);
  assert.throws(() => resolveWorkspacePath(root, '../etc/passwd'), /Path escapes workspace root/);
  assert.throws(() => resolveWorkspacePath(root, '/etc/passwd'), /Path escapes workspace root/);
});
