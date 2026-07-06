import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspacePath, applyEdits } from '../dist/agent/tools.js';
import { ConfigSchema } from '../dist/config.js';
import { calculateCost } from '../dist/providers/anthropic.js';
import { OPENROUTER_MODELS } from '../dist/providers/openrouter.js';
import { classifyRisk } from '../dist/warden/index.js';
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

test('workspace path guard blocks symlink escapes', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'trident-ws-'));
  const outside = mkdtempSync(join(tmpdir(), 'trident-out-'));
  try {
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
    symlinkSync(outside, join(root, 'linkdir'));
    mkdirSync(join(root, 'safe'));
    writeFileSync(join(root, 'safe', 'ok.txt'), 'ok');

    assert.throws(() => resolveWorkspacePath(root, 'link.txt'), /symlink/);
    assert.throws(() => resolveWorkspacePath(root, 'linkdir/secret.txt'), /symlink/);
    assert.ok(resolveWorkspacePath(root, 'safe/ok.txt').endsWith('ok.txt'));
    assert.ok(resolveWorkspacePath(root, 'safe/new-file.txt').endsWith('new-file.txt'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('applyEdits replaces first occurrence and reports missing strings', () => {
  const multi = applyEdits('aXbXc', [{ old_str: 'X', new_str: 'Y' }]);
  assert.equal(multi.content, 'aYbXc');
  assert.equal(multi.warnings.length, 1);
  assert.equal(multi.notFound, null);

  const missing = applyEdits('abc', [{ old_str: 'zzz', new_str: 'y' }]);
  assert.equal(missing.notFound, 'zzz');
  assert.equal(missing.content, 'abc');
});

test('risk classification treats web_fetch as execute and catches rm variants', () => {
  assert.equal(classifyRisk({ name: 'web_fetch', input: { url: 'https://x.test' } }), 'execute');
  assert.equal(classifyRisk({ name: 'read_file', input: { path: 'a.txt' } }), 'read');
  for (const cmd of ['rm -rf /', 'rm -fr build', 'sudo rm -r -f dist', 'git push origin main --force', 'mkfs.ext4 /dev/sda1']) {
    assert.equal(classifyRisk({ name: 'run_command', input: { cmd } }), 'destructive', cmd);
  }
  assert.equal(classifyRisk({ name: 'run_command', input: { cmd: 'npm test' } }), 'execute');
});

test('unknown Anthropic models fall back to nonzero pricing so budgets bind', () => {
  assert.ok(calculateCost('some-future-model', 1_000_000, 0) > 0);
  assert.equal(calculateCost('claude-haiku-4-5-20251001', 1_000_000, 0), 0.25);
});
