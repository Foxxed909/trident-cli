import { readFile, writeFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import fg from 'fast-glob';
import { buildProfileSystemPrompt, type TrainedProfile } from '../profiles.js';

export interface ProjectContext {
  name: string;
  description: string;
  languages: string[];
  frameworks: string[];
  packageManager: string | null;
  commands: {
    install: string | null;
    dev: string | null;
    test: string | null;
    build: string | null;
    lint: string | null;
  };
  tree: string;
  tridentMdPath: string;
  tridentMdContent: string | null;
  /** Emerging multi-agent standard (Codex, Cursor, OpenCode, etc.). */
  agentsMdContent: string | null;
  /** Claude Code project instructions. */
  claudeMdContent: string | null;
}

const TRIDENT_MD_FILENAME = 'TRIDENT.md';
const AGENTS_MD_FILENAME = 'AGENTS.md';
const CLAUDE_MD_FILENAME = 'CLAUDE.md';

async function readOptionalMarkdown(cwd: string, filename: string): Promise<string | null> {
  const fullPath = join(cwd, filename);
  if (!existsSync(fullPath)) {
    return null;
  }
  try {
    return await readFile(fullPath, 'utf-8');
  } catch {
    return null;
  }
}

export async function loadOrCreateContext(cwd: string): Promise<ProjectContext> {
  const tridentMdPath = join(cwd, TRIDENT_MD_FILENAME);

  const [tridentMdContent, agentsMdContent, claudeMdContent] = await Promise.all([
    readOptionalMarkdown(cwd, TRIDENT_MD_FILENAME),
    readOptionalMarkdown(cwd, AGENTS_MD_FILENAME),
    readOptionalMarkdown(cwd, CLAUDE_MD_FILENAME),
  ]);

  const name = await detectProjectName(cwd);
  const languages = await detectLanguages(cwd);
  const frameworks = await detectFrameworks(cwd, languages);
  const packageManager = await detectPackageManager(cwd);
  const commands = await detectCommands(cwd, packageManager);
  const tree = await generateProjectTree(cwd);

  return {
    name,
    description: '',
    languages,
    frameworks,
    packageManager,
    commands,
    tree,
    tridentMdPath,
    tridentMdContent,
    agentsMdContent,
    claudeMdContent,
  };
}

async function detectProjectName(cwd: string): Promise<string> {
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
      if (pkg.name) {
        return pkg.name;
      }
    } catch {}
  }

  const cargoPath = join(cwd, 'Cargo.toml');
  if (existsSync(cargoPath)) {
    const content = await readFile(cargoPath, 'utf-8');
    const match = content.match(/name\s*=\s*"([^"]+)"/);
    if (match) {
      return match[1];
    }
  }

  return basename(cwd) || 'unknown';
}

async function detectLanguages(cwd: string): Promise<string[]> {
  const detected: string[] = [];
  const checks: [string, string][] = [
    ['{**/*.ts,**/*.mts,**/*.cts}', 'TypeScript'],
    ['{**/*.tsx}', 'TypeScript (React)'],
    ['{**/*.js,**/*.mjs,**/*.cjs}', 'JavaScript'],
    ['{**/*.jsx}', 'JavaScript (React)'],
    ['**/*.py', 'Python'],
    ['**/*.go', 'Go'],
    ['**/*.rs', 'Rust'],
    ['**/*.java', 'Java'],
    ['**/*.kt', 'Kotlin'],
    ['**/*.rb', 'Ruby'],
    ['**/*.php', 'PHP'],
    ['**/*.cs', 'C#'],
    ['**/*.cpp', 'C++'],
    ['**/*.c', 'C'],
    ['**/*.swift', 'Swift'],
    ['**/*.vue', 'Vue'],
    ['**/*.svelte', 'Svelte'],
    ['**/*.astro', 'Astro'],
  ];

  for (const [pattern, lang] of checks) {
    const files = await fg(pattern, {
      cwd,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
      deep: 8,
    });
    if (files.length > 0) {
      detected.push(lang);
    }
  }

  return detected;
}

async function detectFrameworks(cwd: string, languages: string[]): Promise<string[]> {
  void languages;
  const frameworks: string[] = [];
  const pkgPath = join(cwd, 'package.json');

  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      if (deps.react) frameworks.push('React');
      if (deps.next) frameworks.push('Next.js');
      if (deps.vue) frameworks.push('Vue');
      if (deps.nuxt) frameworks.push('Nuxt');
      if (deps.svelte) frameworks.push('Svelte');
      if (deps.express) frameworks.push('Express');
      if (deps.fastify) frameworks.push('Fastify');
      if (deps['@nestjs/core']) frameworks.push('NestJS');
    } catch {}
  }

  if (existsSync(join(cwd, 'requirements.txt'))) {
    const content = await readFile(join(cwd, 'requirements.txt'), 'utf-8');
    const lowerContent = content.toLowerCase();
    if (lowerContent.includes('django')) frameworks.push('Django');
    if (lowerContent.includes('flask')) frameworks.push('Flask');
    if (lowerContent.includes('fastapi')) frameworks.push('FastAPI');
  }

  return frameworks;
}

async function detectPackageManager(cwd: string): Promise<string | null> {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(cwd, 'package-lock.json'))) return 'npm';
  if (existsSync(join(cwd, 'package.json'))) return 'npm';
  if (existsSync(join(cwd, 'Pipfile'))) return 'pipenv';
  if (existsSync(join(cwd, 'pyproject.toml'))) return 'poetry';
  if (existsSync(join(cwd, 'Cargo.toml'))) return 'cargo';
  if (existsSync(join(cwd, 'go.mod'))) return 'go';
  return null;
}

async function detectCommands(
  cwd: string,
  pm: string | null
): Promise<ProjectContext['commands']> {
  const commands: ProjectContext['commands'] = {
    install: null,
    dev: null,
    test: null,
    build: null,
    lint: null,
  };

  if (pm && ['npm', 'yarn', 'pnpm'].includes(pm)) {
    const pkgPath = join(cwd, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
        const scripts = pkg.scripts || {};

        commands.install = `${pm} install`;
        if (scripts.dev) commands.dev = `${pm} run dev`;
        else if (scripts.start) commands.dev = `${pm} run start`;
        if (scripts.test) commands.test = `${pm} run test`;
        if (scripts.build) commands.build = `${pm} run build`;
        if (scripts.lint) commands.lint = `${pm} run lint`;
      } catch {}
    }
  } else if (pm === 'cargo') {
    commands.build = 'cargo build';
    commands.test = 'cargo test';
    commands.dev = 'cargo run';
  } else if (pm === 'go') {
    commands.build = 'go build ./...';
    commands.test = 'go test ./...';
    commands.dev = 'go run .';
  }

  return commands;
}

export async function generateProjectTree(cwd: string): Promise<string> {
  try {
    const lines = await collectTreeEntries(cwd, '.', 0, 3);
    return lines.slice(0, 80).join('\n');
  } catch {
    return '(could not generate tree)';
  }
}

export async function generateTridentMd(ctx: ProjectContext, cwd: string): Promise<string> {
  void cwd;
  const content = `# TRIDENT Project Context
*Auto-generated by TRIDENT CLI. Edit this file to customize AI behavior.*

## Project
- **Name**: ${ctx.name}
- **Languages**: ${ctx.languages.join(', ') || 'Unknown'}
- **Frameworks**: ${ctx.frameworks.join(', ') || 'None detected'}
- **Package Manager**: ${ctx.packageManager || 'None'}

## Commands
\`\`\`
Install:  ${ctx.commands.install || 'N/A'}
Dev:      ${ctx.commands.dev || 'N/A'}
Test:     ${ctx.commands.test || 'N/A'}
Build:    ${ctx.commands.build || 'N/A'}
Lint:     ${ctx.commands.lint || 'N/A'}
\`\`\`

## Project Tree (top 3 levels)
\`\`\`
${ctx.tree}
\`\`\`

## Do Not Touch
*Add paths or files TRIDENT should never modify.*

## Context for AI
*Add any additional context, conventions, or rules for TRIDENT here.*

## Config notes
TRIDENT also reads AGENTS.md (team standard) and CLAUDE.md (Claude Code)
if present. Precedence: operator override > TRIDENT.md > AGENTS.md > CLAUDE.md.
`;

  await writeFile(ctx.tridentMdPath, content, 'utf-8');
  return content;
}

function parseProtectedSection(md: string | null, sectionPattern: RegExp): string[] {
  if (!md) {
    return [];
  }

  const patterns: string[] = [];
  let inSection = false;

  for (const line of md.split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      inSection = sectionPattern.test(heading[1]);
      continue;
    }
    if (!inSection) {
      continue;
    }
    const item = line.match(/^\s*[-*+]\s+(.+)$/);
    if (item) {
      const cleaned = item[1].trim().replace(/^`+|`+$/g, '').trim();
      if (cleaned && !/^\*.*\*$/.test(cleaned)) {
        patterns.push(cleaned);
      }
    }
  }

  return patterns;
}

/**
 * Merge Do Not Touch patterns from TRIDENT.md, AGENTS.md, and CLAUDE.md.
 * Deduplicates while preserving first-seen order.
 */
export function parseDoNotTouch(
  tridentMdContent: string | null,
  agentsMdContent?: string | null,
  claudeMdContent?: string | null
): string[] {
  const all = [
    ...parseProtectedSection(tridentMdContent, /do\s+not\s+touch/i),
    ...parseProtectedSection(agentsMdContent ?? null, /do\s+not\s+touch|protected|deny|never\s+modify/i),
    ...parseProtectedSection(claudeMdContent ?? null, /do\s+not\s+touch|protected|deny|never\s+modify/i),
  ];
  return [...new Set(all)];
}

export function buildSystemPrompt(
  ctx: ProjectContext,
  opts: { profile?: TrainedProfile | null; systemOverride?: string } = {}
): string {
  const autoContext = `Project: ${ctx.name}\nLanguages: ${ctx.languages.join(', ') || 'unknown'}\nFrameworks: ${ctx.frameworks.join(', ') || 'none'}\nPackage manager: ${ctx.packageManager || 'none'}`;

  const sections: string[] = [];

  if (ctx.claudeMdContent) {
    sections.push(`## PROJECT CONTEXT (CLAUDE.md)\n${ctx.claudeMdContent}`);
  }
  if (ctx.agentsMdContent) {
    sections.push(`## PROJECT CONTEXT (AGENTS.md)\n${ctx.agentsMdContent}`);
  }
  if (ctx.tridentMdContent) {
    sections.push(`## PROJECT CONTEXT (TRIDENT.md)\n${ctx.tridentMdContent}`);
  } else if (!ctx.agentsMdContent && !ctx.claudeMdContent) {
    sections.push(`## PROJECT CONTEXT\n${autoContext}`);
  }

  const tridentContext = sections.length > 0 ? `\n\n${sections.join('\n\n')}` : '';

  const profileContext = opts.profile
    ? `\n\n## TRAINED PROFILE OVERLAY\n${buildProfileSystemPrompt(opts.profile)}`
    : '';
  const override = (opts.systemOverride || '').trim();
  const overrideContext = override
    ? `\n\n## OPERATOR SYSTEM OVERRIDE\nThe following instructions override the trained profile output style and any default response formatting when they conflict:\n${override}`
    : '';

  return `You are TRIDENT, an elite autonomous software engineering agent. You operate with three prongs:\n\n- **FORGE** - Build and code with precision and excellence\n- **ORACLE** - Understand codebases deeply before acting\n- **WARDEN** - Protect the codebase; prefer surgical edits over nuclear rewrites\n\n## Your Core Principles\n1. **Think before acting** - Always reason through the task before calling tools\n2. **Minimal blast radius** - Prefer targeted edits over full rewrites\n3. **Verify your work** - After changes, run tests or linters if commands are available\n4. **Ask when uncertain** - Use ask_user for ambiguous critical decisions\n5. **Be transparent** - Briefly explain what you're doing and why\n6. **Complete tasks fully** - Don't stop until the task is verified done\n\n## Agent Loop Rules\n- Use tools systematically to explore, understand, then act\n- Prefer search_codebase before reading many files blindly\n- After each file write/edit, verify the result with read_file if critical\n- When done, call final_answer with a clear summary of what was accomplished\n- Max iterations: follow the provided turn limit\n\n## Response Style\n- Write in plain text only - no markdown syntax whatsoever\n- No **bold**, no *italics*, no # headers, no bullet points with *, no backtick code blocks in conversational text\n- Use plain sentences and short paragraphs\n- Tool summaries and final_answer must also be plain text\n- Numbered lists are allowed when listing steps, but use "1." style naturally\n${tridentContext}${profileContext}${overrideContext}\n\n## Current Working Directory\n${process.cwd()}`;
}

async function collectTreeEntries(
  cwd: string,
  relativeDir: string,
  depth: number,
  maxDepth: number
): Promise<string[]> {
  if (depth > maxDepth) {
    return [];
  }

  const absoluteDir = relativeDir === '.' ? cwd : join(cwd, relativeDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const filtered = entries
    .filter((entry) => !shouldIgnoreTreeEntry(entry.name))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) {
        return a.isDirectory() ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

  const lines: string[] = [];

  for (const entry of filtered) {
    const relPath = relativeDir === '.' ? entry.name : join(relativeDir, entry.name).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (depth >= maxDepth) {
        continue;
      }

      const childLines = await collectTreeEntries(cwd, relPath, depth + 1, maxDepth);
      if (childLines.length === 0) {
        continue;
      }

      lines.push(`./${relPath}`);
      lines.push(...childLines);
      continue;
    }

    lines.push(`./${relPath}`);
  }

  return lines;
}

function shouldIgnoreTreeEntry(name: string): boolean {
  return ['node_modules', '.git', 'dist', '.next', 'build'].includes(name);
}
