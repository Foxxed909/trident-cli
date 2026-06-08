import { readFile, writeFile, readdir, mkdir, appendFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import fg from 'fast-glob';
import { buildProfileSystemPrompt, type TrainedProfile } from '../profiles.js';

const MEMORY_DIR = join(homedir(), '.trident');
const MEMORY_FILE = join(MEMORY_DIR, 'memory.md');

export async function loadMemory(): Promise<string> {
  if (!existsSync(MEMORY_FILE)) {
    return '';
  }
  try {
    return await readFile(MEMORY_FILE, 'utf-8');
  } catch {
    return '';
  }
}

export async function appendMemory(fact: string): Promise<void> {
  await mkdir(MEMORY_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const entry = `[${date}] ${fact}\n`;
  await appendFile(MEMORY_FILE, entry, 'utf-8');
}

export async function clearMemory(): Promise<void> {
  if (existsSync(MEMORY_FILE)) {
    await unlink(MEMORY_FILE);
  }
}

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
  globalTridentMdPath: string;
}

const TRIDENT_MD_FILENAME = 'TRIDENT.md';

export const globalTridentMdPath = join(homedir(), '.trident', 'TRIDENT.md');

export async function loadOrCreateContext(cwd: string): Promise<ProjectContext> {
  const tridentMdPath = join(cwd, TRIDENT_MD_FILENAME);

  let tridentMdContent: string | null = null;
  if (existsSync(tridentMdPath)) {
    tridentMdContent = await readFile(tridentMdPath, 'utf-8');
  }

  // Load global TRIDENT.md from ~/.trident/TRIDENT.md
  let globalTridentContent: string | null = null;
  if (existsSync(globalTridentMdPath)) {
    globalTridentContent = await readFile(globalTridentMdPath, 'utf-8');
  }

  // Merge: global first, then project-specific overrides
  const mergedContent = [
    globalTridentContent ? `<!-- global ~/.trident/TRIDENT.md -->\n${globalTridentContent}` : null,
    tridentMdContent,
  ].filter(Boolean).join('\n\n---\n\n') || null;

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
    tridentMdContent: mergedContent,
    globalTridentMdPath,
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
`;

  await writeFile(ctx.tridentMdPath, content, 'utf-8');
  return content;
}

export function buildSystemPrompt(
  ctx: ProjectContext,
  opts: { profile?: TrainedProfile | null; systemOverride?: string } = {}
): string {
  const tridentContext = ctx.tridentMdContent
    ? `\n\n## PROJECT CONTEXT (TRIDENT.md)\n${ctx.tridentMdContent}`
    : `\n\n## PROJECT CONTEXT\nProject: ${ctx.name}\nLanguages: ${ctx.languages.join(', ')}\nFrameworks: ${ctx.frameworks.join(', ')}`;
  const profileContext = opts.profile
    ? `\n\n## TRAINED PROFILE OVERLAY\n${buildProfileSystemPrompt(opts.profile)}`
    : '';
  const override = (opts.systemOverride || '').trim();
  const overrideContext = override
    ? `\n\n## OPERATOR SYSTEM OVERRIDE\nThe following instructions override the trained profile output style and any default response formatting when they conflict:\n${override}`
    : '';

  return `You are TRIDENT, an elite autonomous software engineering agent. You operate with three prongs:

- **FORGE** - Build and code with precision and excellence
- **ORACLE** - Understand codebases deeply before acting
- **WARDEN** - Protect the codebase; prefer surgical edits over nuclear rewrites

## Your Core Principles
1. **Think before acting** - Always reason through the task before calling tools
2. **Minimal blast radius** - Prefer targeted edits over full rewrites
3. **Verify your work** - After changes, run tests or linters if commands are available
4. **Ask when uncertain** - Use ask_user for ambiguous critical decisions
5. **Be transparent** - Briefly explain what you're doing and why
6. **Complete tasks fully** - Don't stop until the task is verified done

## Agent Loop Rules
- Use tools systematically to explore, understand, then act
- After each file write/edit, verify the result with read_file if critical
- When done, call final_answer with a clear summary of what was accomplished
- Max iterations: follow the provided turn limit

## Response Style
- Write in plain text only - no markdown syntax whatsoever
- No **bold**, no *italics*, no # headers, no bullet points with *, no backtick code blocks in conversational text
- Use plain sentences and short paragraphs
- Tool summaries and final_answer must also be plain text
- Numbered lists are allowed when listing steps, but use "1." style naturally
${tridentContext}${profileContext}${overrideContext}

## Current Working Directory
${process.cwd()}`;
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
