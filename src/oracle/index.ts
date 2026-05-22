import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve, basename } from 'path';
import fg from 'fast-glob';

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
  userName?: string;
}

const TRIDENT_MD_FILENAME = 'TRIDENT.md';

export async function loadOrCreateContext(cwd: string): Promise<ProjectContext> {
  const tridentMdPath = join(cwd, TRIDENT_MD_FILENAME);

  // Try to read existing TRIDENT.md
  let tridentMdContent: string | null = null;
  if (existsSync(tridentMdPath)) {
    tridentMdContent = await readFile(tridentMdPath, 'utf-8');
  }

  // Auto-detect project details
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
  };
}

async function detectProjectName(cwd: string): Promise<string> {
  // Try package.json
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
      if (pkg.name) return pkg.name;
    } catch {}
  }

  // Try Cargo.toml
  const cargoPath = join(cwd, 'Cargo.toml');
  if (existsSync(cargoPath)) {
    const content = await readFile(cargoPath, 'utf-8');
    const match = content.match(/name\s*=\s*"([^"]+)"/);
    if (match) return match[1];
  }

  // Fallback: directory name (cross-platform)
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
    if (files.length > 0) detected.push(lang);
  }

  return detected;
}

async function detectFrameworks(cwd: string, languages: string[]): Promise<string[]> {
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
    const entries = await fg('**/*', {
      cwd,
      ignore: ['node_modules/**', '.git/**', 'dist/**', '.next/**', 'build/**'],
      deep: 3,
      dot: false,
      onlyFiles: false,
    });
    const lines = entries.sort().slice(0, 80).map(f => `./${f}`);
    return lines.join('\n');
  } catch {
    return '(could not generate tree)';
  }
}

export async function generateTridentMd(ctx: ProjectContext, cwd: string): Promise<string> {
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

export function buildSystemPrompt(ctx: ProjectContext, model = ''): string {
  const tridentContext = ctx.tridentMdContent
    ? `\n\n## PROJECT CONTEXT (TRIDENT.md)\n${ctx.tridentMdContent}`
    : `\n\n## PROJECT CONTEXT\nProject: ${ctx.name}\nLanguages: ${ctx.languages.join(', ')}\nFrameworks: ${ctx.frameworks.join(', ')}`;

  const operatorLine = ctx.userName ? `\nOperator: ${ctx.userName}` : '';

  let modelNote = '';
  if (model.includes('haiku')) {
    modelNote = '\n\nNote: Be concise. Use brief summaries and short explanations. Prefer targeted reads over broad exploration.';
  } else if (model.includes('opus')) {
    modelNote = '\n\nNote: Take time to reason deeply. Explore thoroughly before acting. Consider architectural implications and edge cases.';
  }

  return `You are TRIDENT 🔱, an elite autonomous software engineering agent. You operate with three prongs:

- **FORGE** — Build and code with precision and excellence
- **ORACLE** — Understand codebases deeply before acting
- **WARDEN** — Protect the codebase; prefer surgical edits over nuclear rewrites
${operatorLine}
## Your Core Principles
1. **Think before acting** — Always reason through the task before calling tools
2. **Minimal blast radius** — Prefer targeted edits over full rewrites
3. **Verify your work** — After changes, run tests or linters if commands are available
4. **Ask when uncertain** — Use ask_user for ambiguous critical decisions
5. **Be transparent** — Briefly explain what you're doing and why
6. **Complete tasks fully** — Don't stop until the task is verified done

## Tool Selection Guide
- Use **read_file_range** instead of read_file for files >200 lines — request only the section you need
- Use **glob_files** to discover what files exist before deciding what to read
- Use **search_codebase** with mode:"regex" for pattern searches (function signatures, class names, imports)
- Use **create_dir** before write_file when writing to a directory that may not exist
- Use **move_file** to rename or relocate files cleanly (no shell required)
- Prefer **edit_file** with multiple edits in one call over sequential single-edit calls

## Error Recovery
- If a tool returns an error, understand the cause before retrying
- If edit_file fails "string not found", read the file first to confirm the current content
- If a test fails, read both the test file and the implementation before modifying either
- If a command times out, break it into smaller steps
- Never delete a file until you have confirmed nothing else depends on it

## Agent Loop Rules
- Use tools systematically to explore, understand, then act
- After each file write/edit, verify the result with read_file_range if the change is critical
- When done, call final_answer with a clear summary of what was accomplished
- Max iterations: follow the provided turn limit
${tridentContext}

## Current Working Directory
${process.cwd()}${modelNote}`;
}
