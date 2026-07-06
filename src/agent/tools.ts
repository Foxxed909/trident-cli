import { readFile, writeFile, unlink, readdir, lstat } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { dirname, resolve, relative, isAbsolute } from 'path';
import { execa } from 'execa';
import fg from 'fast-glob';

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  duration_ms: number;
}

export type ToolName =
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'delete_file'
  | 'list_dir'
  | 'run_command'
  | 'search_codebase'
  | 'web_fetch'
  | 'ask_user'
  | 'final_answer';

export interface ToolCall {
  name: ToolName;
  input: Record<string, unknown>;
}

export interface EditOperation {
  old_str: string;
  new_str: string;
}

const TIMEOUT_MS = 30_000;

export async function executeTool(
  call: ToolCall,
  cwd: string,
  askUserFn: (q: string) => Promise<string>,
  protectedPaths: string[] = []
): Promise<ToolResult> {
  const start = Date.now();

  try {
    if (
      (call.name === 'write_file' || call.name === 'edit_file' || call.name === 'delete_file') &&
      protectedPaths.length > 0
    ) {
      const rel = relative(resolve(cwd), resolveWorkspacePath(cwd, call.input.path as string));
      if (isProtectedPath(rel, protectedPaths)) {
        return {
          success: false,
          output: '',
          error: `Blocked: "${rel}" is listed under "Do Not Touch" in TRIDENT.md and must not be modified.`,
          duration_ms: Date.now() - start,
        };
      }
    }

    switch (call.name) {
      case 'read_file': {
        const filePath = resolveWorkspacePath(cwd, call.input.path as string);
        if (!existsSync(filePath)) {
          return { success: false, output: '', error: `File not found: ${filePath}`, duration_ms: Date.now() - start };
        }
        const content = await readFile(filePath, 'utf-8');
        return { success: true, output: content, duration_ms: Date.now() - start };
      }

      case 'write_file': {
        const { path: filePath, content } = call.input as { path: string; content: string };
        const absPath = resolveWorkspacePath(cwd, filePath);
        const { mkdirSync } = await import('fs');
        mkdirSync(dirname(absPath), { recursive: true });
        await writeFile(absPath, content as string, 'utf-8');
        return { success: true, output: `Written: ${relative(cwd, absPath)}`, duration_ms: Date.now() - start };
      }

      case 'edit_file': {
        const { path: filePath, edits } = call.input as { path: string; edits: EditOperation[] };
        const absPath = resolveWorkspacePath(cwd, filePath);
        if (!existsSync(absPath)) {
          return { success: false, output: '', error: `File not found: ${absPath}`, duration_ms: Date.now() - start };
        }
        const original = await readFile(absPath, 'utf-8');
        const { content, warnings, notFound } = applyEdits(original, edits);
        if (notFound !== null) {
          return { success: false, output: '', error: `String not found in file: "${notFound.slice(0, 50)}..."`, duration_ms: Date.now() - start };
        }
        await writeFile(absPath, content, 'utf-8');
        const baseOutput = `Edited: ${relative(cwd, absPath)} (${edits.length} edit(s))`;
        return { success: true, output: warnings.length > 0 ? `${baseOutput}\n${warnings.join('\n')}` : baseOutput, duration_ms: Date.now() - start };
      }

      case 'delete_file': {
        const absPath = resolveWorkspacePath(cwd, call.input.path as string);
        if (!existsSync(absPath)) {
          return { success: false, output: '', error: `File not found: ${absPath}`, duration_ms: Date.now() - start };
        }
        const deleteStat = await lstat(absPath);
        if (deleteStat.isDirectory()) {
          return { success: false, output: '', error: 'Cannot delete a directory with delete_file. Use a shell command instead.', duration_ms: Date.now() - start };
        }
        await unlink(absPath);
        return { success: true, output: `Deleted: ${relative(cwd, absPath)}`, duration_ms: Date.now() - start };
      }

      case 'list_dir': {
        const { path: dirPath, recursive = false } = call.input as { path: string; recursive?: boolean };
        const absPath = resolveWorkspacePath(cwd, dirPath);

        if (recursive) {
          const normalizedPath = absPath.replace(/\\/g, '/');
          const pattern = `${normalizedPath}/**/*`;
          const files = await fg(pattern, {
            ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.next/**'],
            dot: false,
          });
          const relFiles = files.map((f) => relative(cwd, f)).sort();
          return { success: true, output: relFiles.join('\n'), duration_ms: Date.now() - start };
        } else {
          const entries = await readdir(absPath, { withFileTypes: true });
          const lines = entries.map((e) => `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`);
          return { success: true, output: lines.join('\n'), duration_ms: Date.now() - start };
        }
      }

      case 'run_command': {
        const { cmd, cwd: cmdCwd } = call.input as { cmd: string; cwd?: string };
        const execCwd = cmdCwd ? resolveWorkspacePath(cwd, cmdCwd) : cwd;
        const isWindows = process.platform === 'win32';
        const shellExe = isWindows ? 'cmd' : 'bash';
        const shellFlag = isWindows ? '/c' : '-c';

        const execResult = await execa(shellExe, [shellFlag, cmd], {
          cwd: execCwd,
          all: true,
          reject: false,
          timeout: TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
        });

        const rawOutput: unknown = execResult.all;
        const output =
          typeof rawOutput === 'string' ? rawOutput :
          rawOutput instanceof Uint8Array ? Buffer.from(rawOutput).toString('utf-8') :
          rawOutput == null ? '' :
          String(rawOutput);
        const exitCode = execResult.exitCode ?? 0;

        if (execResult.timedOut) {
          return {
            success: false,
            output: output.slice(-4000),
            error: `Command timed out after ${TIMEOUT_MS}ms`,
            duration_ms: Date.now() - start,
          };
        }
        if (exitCode !== 0) {
          return {
            success: false,
            output: output.slice(-4000),
            error: `Exit code: ${exitCode}`,
            duration_ms: Date.now() - start,
          };
        }
        return { success: true, output: output.slice(-8000), duration_ms: Date.now() - start };
      }

      case 'search_codebase': {
        const { query, glob } = call.input as { query: string; glob?: string };
        const pattern = glob || '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,rb,php,cs,cpp,c,h,hpp,md,json,yml,yaml,toml}';
        const files = await fg(pattern, {
          cwd,
          ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**', '**/coverage/**'],
          dot: false,
          absolute: false,
          followSymbolicLinks: false,
        });

        const needle = query.toLowerCase();
        const matches: string[] = [];
        let totalHits = 0;
        const MAX_FILES = 30;
        const MAX_LINES_PER_FILE = 5;
        let filesWithMatches = 0;
        let truncatedFiles = 0;

        for (const rel of files) {
          let content: string;
          try {
            content = await readFile(resolve(cwd, rel), 'utf-8');
          } catch {
            continue;
          }
          const lines = content.split(/\r?\n/);
          const hits: string[] = [];
          let hiddenHits = 0;
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(needle)) {
              if (hits.length < MAX_LINES_PER_FILE) {
                hits.push(`  ${i + 1}: ${lines[i].slice(0, 200)}`);
                totalHits++;
              } else {
                hiddenHits++;
              }
            }
          }
          if (hits.length > 0) {
            filesWithMatches++;
            if (matches.length < MAX_FILES) {
              const suffix = hiddenHits > 0 ? `\n  … and ${hiddenHits} more line(s) in this file` : '';
              matches.push(`\n${rel}\n${hits.join('\n')}${suffix}`);
            } else {
              truncatedFiles++;
            }
          }
        }

        if (matches.length === 0) {
          return { success: true, output: `No matches found for "${query}"`, duration_ms: Date.now() - start };
        }

        let output = `Found ${totalHits} hit(s) in ${filesWithMatches} file(s):\n${matches.join('\n')}`;
        if (truncatedFiles > 0) {
          output += `\n\n[Note: Results truncated — ${filesWithMatches} files matched, showing first ${MAX_FILES}. Use a more specific query or glob to narrow results.]`;
        }
        return { success: true, output, duration_ms: Date.now() - start };
      }

      case 'web_fetch': {
        const { url } = call.input as { url: string };
        let resp: Response;
        try {
          resp = await fetch(url, {
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: { 'User-Agent': 'TRIDENT-CLI/1.0' },
          });
        } catch (e) {
          return { success: false, output: '', error: `Fetch failed: ${e instanceof Error ? e.message : String(e)}`, duration_ms: Date.now() - start };
        }
        if (!resp.ok) {
          return { success: false, output: '', error: `HTTP ${resp.status} ${resp.statusText}`, duration_ms: Date.now() - start };
        }
        const text = await resp.text();
        return { success: true, output: text.slice(0, 16000), duration_ms: Date.now() - start };
      }

      case 'ask_user': {
        const { question } = call.input as { question: string };
        const answer = await askUserFn(question);
        return { success: true, output: answer, duration_ms: Date.now() - start };
      }

      case 'final_answer': {
        const { summary } = call.input as { summary: string };
        return { success: true, output: summary, duration_ms: Date.now() - start };
      }

      default:
        return { success: false, output: '', error: `Unknown tool: ${(call as ToolCall).name}`, duration_ms: Date.now() - start };
    }
  } catch (err) {
    return {
      success: false,
      output: '',
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - start,
    };
  }
}

export function resolveWorkspacePath(workspaceRoot: string, targetPath: string): string {
  const resolvedRoot = resolve(workspaceRoot);
  const resolvedPath = resolve(workspaceRoot, targetPath);
  const relativePath = relative(resolvedRoot, resolvedPath);

  if (relativePath !== '' && (relativePath.startsWith('..') || isAbsolute(relativePath))) {
    throw new Error(`Path escapes workspace root: ${targetPath}`);
  }

  // A symlink inside the workspace can still point outside it, so compare the
  // real locations of the root and the deepest existing ancestor of the target.
  const realRoot = realpathSync(resolvedRoot);
  const realExisting = realpathSync(deepestExistingAncestor(resolvedPath));
  const realRelative = relative(realRoot, realExisting);
  if (realRelative !== '' && (realRelative.startsWith('..') || isAbsolute(realRelative))) {
    throw new Error(`Path escapes workspace root via symlink: ${targetPath}`);
  }

  return resolvedPath;
}

function deepestExistingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return current;
}

/**
 * Match a workspace-relative path against TRIDENT.md "Do Not Touch" patterns.
 * Supports exact paths, directory prefixes, and simple globs (*, **, ?).
 */
export function isProtectedPath(relPath: string, patterns: string[]): boolean {
  const rel = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const raw of patterns) {
    const pattern = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!pattern) {
      continue;
    }
    if (/[*?[\]{}]/.test(pattern)) {
      if (globToRegExp(pattern).test(rel)) {
        return true;
      }
    } else if (rel === pattern || rel.startsWith(`${pattern}/`)) {
      return true;
    }
  }
  return false;
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function applyEdits(
  content: string,
  edits: EditOperation[]
): { content: string; warnings: string[]; notFound: string | null } {
  const warnings: string[] = [];
  for (const edit of edits) {
    const idx = content.indexOf(edit.old_str);
    if (idx === -1) {
      return { content, warnings, notFound: edit.old_str };
    }
    const occurrences = content.split(edit.old_str).length - 1;
    if (occurrences > 1) {
      warnings.push(`Warning: old_str appeared ${occurrences} times — only the first occurrence was replaced.`);
    }
    // Splice by index to avoid replace's $& / $1 substitution semantics
    content = content.slice(0, idx) + edit.new_str + content.slice(idx + edit.old_str.length);
  }
  return { content, warnings, notFound: null };
}

export const TOOL_DEFINITIONS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the file' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file (creates or overwrites)',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Apply surgical string-replace edits to a file',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              old_str: { type: 'string', description: 'Exact string to find' },
              new_str: { type: 'string', description: 'String to replace with' },
            },
            required: ['old_str', 'new_str'],
          },
        },
      },
      required: ['path', 'edits'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file (DESTRUCTIVE)',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the file' } },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: 'List directory contents',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path' },
        recursive: { type: 'boolean', description: 'List recursively' },
      },
      required: ['path'],
    },
  },
  {
    name: 'run_command',
    description: 'Execute a shell command and capture output',
    input_schema: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'Shell command to run' },
        cwd: { type: 'string', description: 'Working directory (optional)' },
      },
      required: ['cmd'],
    },
  },
  {
    name: 'search_codebase',
    description: 'Search for a literal string across codebase files (case-insensitive). Optional glob narrows the search.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search string (literal, case-insensitive)' },
        glob: { type: 'string', description: 'Optional glob pattern (e.g. "src/**/*.ts") to limit search' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch content from a URL (docs, APIs, etc.)',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to fetch' } },
      required: ['url'],
    },
  },
  {
    name: 'ask_user',
    description: 'Ask the user a question for clarification',
    input_schema: {
      type: 'object',
      properties: { question: { type: 'string', description: 'Question to ask' } },
      required: ['question'],
    },
  },
  {
    name: 'final_answer',
    description: 'Signal task completion with a summary',
    input_schema: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'Summary of what was accomplished' } },
      required: ['summary'],
    },
  },
];
