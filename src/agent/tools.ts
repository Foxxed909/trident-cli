import { readFile, writeFile, mkdir, rename, unlink, readdir, lstat } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, relative, dirname } from 'path';
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
  | 'read_file_range'
  | 'write_file'
  | 'edit_file'
  | 'delete_file'
  | 'list_dir'
  | 'glob_files'
  | 'create_dir'
  | 'move_file'
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

export async function executeTool(
  call: ToolCall,
  cwd: string,
  askUserFn: (q: string) => Promise<string>,
  timeoutMs = 30_000,
  searchMaxFiles = 100,
): Promise<ToolResult> {
  const start = Date.now();

  try {
    switch (call.name) {
      case 'read_file': {
        const filePath = resolve(cwd, call.input.path as string);
        if (!existsSync(filePath)) {
          return { success: false, output: '', error: `File not found: ${filePath}`, duration_ms: Date.now() - start };
        }
        const content = await readFile(filePath, 'utf-8');
        return { success: true, output: content, duration_ms: Date.now() - start };
      }

      case 'read_file_range': {
        const { path: rfPath, start_line, end_line } = call.input as { path: string; start_line: number; end_line: number };
        const absPath = resolve(cwd, rfPath);
        if (!existsSync(absPath)) {
          return { success: false, output: '', error: `File not found: ${absPath}`, duration_ms: Date.now() - start };
        }
        const allLines = (await readFile(absPath, 'utf-8')).split(/\r?\n/);
        const totalLines = allLines.length;
        const s = Math.max(1, start_line);
        const e = Math.min(totalLines, end_line);
        if (s > totalLines) {
          return { success: false, output: '', error: `start_line ${start_line} exceeds file length (${totalLines} lines)`, duration_ms: Date.now() - start };
        }
        const numbered = allLines.slice(s - 1, e)
          .map((line, i) => `${String(s + i).padStart(6)}: ${line}`)
          .join('\n');
        return { success: true, output: `${relative(cwd, absPath)} (lines ${s}–${e} of ${totalLines}):\n${numbered}`, duration_ms: Date.now() - start };
      }

      case 'write_file': {
        const { path: filePath, content } = call.input as { path: string; content: string };
        const absPath = resolve(cwd, filePath);
        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(absPath, content as string, 'utf-8');
        return { success: true, output: `Written: ${relative(cwd, absPath)}`, duration_ms: Date.now() - start };
      }

      case 'edit_file': {
        const { path: filePath, edits } = call.input as { path: string; edits: EditOperation[] };
        const absPath = resolve(cwd, filePath);
        if (!existsSync(absPath)) {
          return { success: false, output: '', error: `File not found: ${absPath}`, duration_ms: Date.now() - start };
        }
        let content = await readFile(absPath, 'utf-8');
        const warnings: string[] = [];
        for (const edit of edits) {
          const idx = content.indexOf(edit.old_str);
          if (idx === -1) {
            const preview = edit.old_str.length > 50 ? `${edit.old_str.slice(0, 50)}...` : edit.old_str;
          return { success: false, output: '', error: `String not found in file: "${preview}"`, duration_ms: Date.now() - start };
          }
          const occurrences = content.split(edit.old_str).length - 1;
          if (occurrences > 1) {
            warnings.push(`Warning: old_str appeared ${occurrences} times — only the first occurrence was replaced.`);
          }
          // Use split/join to avoid replace's $& / $1 substitution semantics
          content = content.slice(0, idx) + edit.new_str + content.slice(idx + edit.old_str.length);
        }
        await writeFile(absPath, content, 'utf-8');
        const baseOutput = `Edited: ${relative(cwd, absPath)} (${edits.length} edit(s))`;
        return { success: true, output: warnings.length > 0 ? `${baseOutput}\n${warnings.join('\n')}` : baseOutput, duration_ms: Date.now() - start };
      }

      case 'delete_file': {
        const absPath = resolve(cwd, call.input.path as string);
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

      case 'create_dir': {
        const absPath = resolve(cwd, call.input.path as string);
        await mkdir(absPath, { recursive: true });
        return { success: true, output: `Created: ${relative(cwd, absPath)}`, duration_ms: Date.now() - start };
      }

      case 'move_file': {
        const { src, dest } = call.input as { src: string; dest: string };
        const absSrc = resolve(cwd, src);
        const absDest = resolve(cwd, dest);
        if (!existsSync(absSrc)) {
          return { success: false, output: '', error: `Source not found: ${absSrc}`, duration_ms: Date.now() - start };
        }
        const destExisted = existsSync(absDest);
        await mkdir(dirname(absDest), { recursive: true });
        await rename(absSrc, absDest);
        const note = destExisted ? ' (overwrote existing file — undo restores destination only)' : '';
        return { success: true, output: `Moved: ${relative(cwd, absSrc)} → ${relative(cwd, absDest)}${note}`, duration_ms: Date.now() - start };
      }

      case 'list_dir': {
        const { path: dirPath, recursive = false } = call.input as { path: string; recursive?: boolean };
        const absPath = resolve(cwd, dirPath);

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

      case 'glob_files': {
        const { pattern, cwd: globCwd } = call.input as { pattern: string; cwd?: string };
        const basePath = globCwd ? resolve(cwd, globCwd) : cwd;
        const files = await fg(pattern, {
          cwd: basePath,
          ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**'],
          dot: false,
          followSymbolicLinks: false,
        });
        const relFiles = files.map(f => relative(cwd, resolve(basePath, f))).sort();
        return { success: true, output: relFiles.join('\n') || '(no matches)', duration_ms: Date.now() - start };
      }

      case 'run_command': {
        const { cmd, cwd: cmdCwd } = call.input as { cmd: string; cwd?: string };
        const execCwd = cmdCwd ? resolve(cwd, cmdCwd) : cwd;
        const isWindows = process.platform === 'win32';
        const shellExe = isWindows ? 'cmd' : 'bash';
        const shellFlag = isWindows ? '/c' : '-c';

        const execResult = await execa(shellExe, [shellFlag, cmd], {
          cwd: execCwd,
          all: true,
          reject: false,
          timeout: timeoutMs,
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
            error: `Command timed out after ${timeoutMs}ms`,
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
        const { query, glob, mode = 'literal' } = call.input as { query: string; glob?: string; mode?: 'literal' | 'regex' };
        const pattern = glob || '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,rb,php,cs,cpp,c,h,hpp,md,json,yml,yaml,toml}';
        const files = await fg(pattern, {
          cwd,
          ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**', '**/coverage/**'],
          dot: false,
          absolute: false,
          followSymbolicLinks: false,
        });

        let matcher: (line: string) => boolean;
        if (mode === 'regex') {
          let re: RegExp;
          try {
            re = new RegExp(query, 'i');
          } catch {
            return { success: false, output: '', error: `Invalid regex: "${query}"`, duration_ms: Date.now() - start };
          }
          matcher = (line) => re.test(line);
        } else {
          const needle = query.toLowerCase();
          matcher = (line) => line.toLowerCase().includes(needle);
        }

        const matches: string[] = [];
        let totalHits = 0;
        const MAX_FILES = searchMaxFiles;
        const MAX_LINES_PER_FILE = 10;
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
          const fileOutput: string[] = [];
          let hiddenHits = 0;
          const shownLineIndices = new Set<number>();

          for (let i = 0; i < lines.length; i++) {
            if (!matcher(lines[i])) continue;
            if (fileOutput.length >= MAX_LINES_PER_FILE) { hiddenHits++; continue; }

            totalHits++;
            // Context: 1 line before and after, deduplicated
            const ctxStart = Math.max(0, i - 1);
            const ctxEnd = Math.min(lines.length - 1, i + 1);
            for (let c = ctxStart; c <= ctxEnd; c++) {
              if (shownLineIndices.has(c)) continue;
              shownLineIndices.add(c);
              const prefix = c === i ? '>' : ' ';
              fileOutput.push(`${prefix} ${String(c + 1).padStart(5)}: ${lines[c].slice(0, 200)}`);
            }
          }
          if (fileOutput.length > 0) {
            filesWithMatches++;
            if (matches.length < MAX_FILES) {
              const suffix = hiddenHits > 0 ? `\n  … and ${hiddenHits} more hit(s) in this file` : '';
              matches.push(`\n${rel}\n${fileOutput.join('\n')}${suffix}`);
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
            signal: AbortSignal.timeout(timeoutMs),
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

export const TOOL_DEFINITIONS = [
  {
    name: 'read_file',
    description: 'Read the full contents of a file. For large files (>200 lines) prefer read_file_range.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the file' } },
      required: ['path'],
    },
  },
  {
    name: 'read_file_range',
    description: 'Read a specific range of lines from a file (1-indexed, inclusive). Use this instead of read_file for large files when you know which section you need.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file' },
        start_line: { type: 'number', description: 'First line to read (1-indexed, inclusive)' },
        end_line: { type: 'number', description: 'Last line to read (1-indexed, inclusive)' },
      },
      required: ['path', 'start_line', 'end_line'],
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
    name: 'create_dir',
    description: 'Create a directory (and any required parent directories)',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path to create' } },
      required: ['path'],
    },
  },
  {
    name: 'move_file',
    description: 'Move or rename a file. Creates destination directories as needed.',
    input_schema: {
      type: 'object',
      properties: {
        src:  { type: 'string', description: 'Source file path' },
        dest: { type: 'string', description: 'Destination file path' },
      },
      required: ['src', 'dest'],
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
    name: 'glob_files',
    description: 'List files matching a glob pattern. Use this to find files by name or extension (e.g. "src/**/*.ts").',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts" or "**/*.test.js"' },
        cwd: { type: 'string', description: 'Optional base directory (defaults to project root)' },
      },
      required: ['pattern'],
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
    description: 'Search for a string across codebase files. Returns matches with context lines. Use mode:"regex" for pattern searches (e.g. function signatures, imports).',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search string (literal) or regex pattern' },
        glob: { type: 'string', description: 'Optional glob pattern to limit search (e.g. "src/**/*.ts")' },
        mode: { type: 'string', enum: ['literal', 'regex'], description: 'Search mode — literal (default) or regex' },
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
