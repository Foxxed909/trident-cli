import { readFile, writeFile, unlink, readdir, lstat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve, relative, isAbsolute } from 'path';
import { execa } from 'execa';
import fg from 'fast-glob';
import { appendMemory } from '../oracle/index.js';

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
  | 'final_answer'
  | 'memory_update'
  | 'git_blame'
  | 'web_search'
  | 'github_api'
  | 'spawn_agent'
  | 'read_notebook'
  | 'edit_notebook_cell'
  | 'read_pdf'
  | 'read_image';

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
  spawnAgentFn?: (task: string, systemPrompt: string) => Promise<{ success: boolean; output: string }>
): Promise<ToolResult> {
  const start = Date.now();

  try {
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
        const { dirname } = await import('path');
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
        let content = await readFile(absPath, 'utf-8');
        for (const edit of edits) {
          const idx = content.indexOf(edit.old_str);
          if (idx === -1) {
            return { success: false, output: '', error: `String not found in file: "${edit.old_str.slice(0, 50)}..."`, duration_ms: Date.now() - start };
          }
          const occurrences = content.split(edit.old_str).length - 1;
          if (occurrences > 1) {
            return {
              success: false,
              output: '',
              error: `Ambiguous edit: old_str appears ${occurrences} times in ${relative(cwd, absPath)}. Make old_str more specific by including more surrounding context.`,
              duration_ms: Date.now() - start,
            };
          }
          content = content.slice(0, idx) + edit.new_str + content.slice(idx + edit.old_str.length);
        }
        await writeFile(absPath, content, 'utf-8');
        return { success: true, output: `Edited: ${relative(cwd, absPath)} (${edits.length} edit(s))`, duration_ms: Date.now() - start };
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
            followSymbolicLinks: false,
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
        let text: string;
        try {
          text = await resp.text();
        } catch (e) {
          return { success: false, output: '', error: `Failed to read response body: ${e instanceof Error ? e.message : String(e)}`, duration_ms: Date.now() - start };
        }
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

      case 'memory_update': {
        const { fact } = call.input as { fact: string };
        if (!fact?.trim()) {
          return { success: false, output: '', error: 'fact is required', duration_ms: Date.now() - start };
        }
        await appendMemory(fact.trim());
        return { success: true, output: `Memory updated: ${fact.trim()}`, duration_ms: Date.now() - start };
      }

      case 'git_blame': {
        const { path: filePath, startLine, endLine } = call.input as { path: string; startLine?: number; endLine?: number };
        const absPath = resolveWorkspacePath(cwd, filePath);
        if (!existsSync(absPath)) return { success: false, output: '', error: `File not found: ${absPath}`, duration_ms: Date.now() - start };
        const lineFlag = (startLine && endLine) ? ` -L ${startLine},${endLine}` : '';
        const isWindows = process.platform === 'win32';
        const execRes = await execa(isWindows ? 'cmd' : 'bash', [isWindows ? '/c' : '-c', `git blame --porcelain${lineFlag} -- "${filePath}"`], { cwd, reject: false, all: true, timeout: 10000 });
        const blameOut = typeof execRes.all === 'string' ? execRes.all : '';
        if (execRes.exitCode !== 0) return { success: false, output: '', error: blameOut.slice(0, 500) || 'git blame failed', duration_ms: Date.now() - start };
        const blameLines = blameOut.split('\n');
        const blameResult: string[] = [];
        let currentCommit = '';
        let currentAuthor = '';
        let currentTime = '';
        let lineNum = 0;
        for (const line of blameLines) {
          if (/^[0-9a-f]{40}/.test(line)) {
            currentCommit = line.slice(0, 8);
          } else if (line.startsWith('author ')) {
            currentAuthor = line.slice(7);
          } else if (line.startsWith('author-time ')) {
            currentTime = new Date(parseInt(line.slice(12)) * 1000).toISOString().slice(0, 10);
          } else if (line.startsWith('\t')) {
            lineNum++;
            blameResult.push(`${String(lineNum).padStart(4)}  ${currentCommit}  ${currentAuthor.slice(0, 15).padEnd(15)}  ${currentTime}  ${line.slice(1)}`);
          }
        }
        return { success: true, output: blameResult.join('\n').slice(0, 12000), duration_ms: Date.now() - start };
      }

      case 'web_search': {
        const { query, maxResults = 8 } = call.input as { query: string; maxResults?: number };
        let searchResp: Response;
        try {
          searchResp = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            signal: AbortSignal.timeout(15000),
            headers: { 'User-Agent': 'Mozilla/5.0 TRIDENT-CLI/1.0' },
          });
        } catch (e) {
          return { success: false, output: '', error: `Search failed: ${e instanceof Error ? e.message : String(e)}`, duration_ms: Date.now() - start };
        }
        let html: string;
        try { html = await searchResp.text(); } catch (e) { return { success: false, output: '', error: `Failed to read response: ${e instanceof Error ? e.message : String(e)}`, duration_ms: Date.now() - start }; }
        const results: string[] = [];
        const resultRegex = /<a class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([^<]*)<\/a>/g;
        let rMatch;
        let count = 0;
        while ((rMatch = resultRegex.exec(html)) !== null && count < (maxResults as number)) {
          const [, href, title, snippet] = rMatch;
          results.push(`${count + 1}. ${title.trim()}\n   URL: ${href}\n   ${snippet.trim()}`);
          count++;
        }
        if (results.length === 0) {
          const titleRe = /<a[^>]+class="result__a"[^>]*>([^<]+)<\/a>/g;
          const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
          const titles: string[] = [];
          const snippets: string[] = [];
          let m;
          while ((m = titleRe.exec(html)) !== null) titles.push(m[1].trim());
          while ((m = snippetRe.exec(html)) !== null) snippets.push(m[1].replace(/<[^>]+>/g, '').trim());
          for (let i = 0; i < Math.min(titles.length, maxResults as number); i++) {
            results.push(`${i + 1}. ${titles[i]}\n   ${snippets[i] || ''}`);
          }
        }
        if (results.length === 0) {
          return { success: true, output: `No results found for: ${query}`, duration_ms: Date.now() - start };
        }
        return { success: true, output: `Search results for: ${query}\n\n${results.join('\n\n')}`, duration_ms: Date.now() - start };
      }

      case 'github_api': {
        const { method = 'GET', path: apiPath, endpoint, body } = call.input as { method?: string; path?: string; endpoint?: string; body?: Record<string, unknown> };
        const apiEndpoint = apiPath || endpoint || '';
        const token = process.env.GITHUB_TOKEN;
        if (!token) return { success: false, output: '', error: 'GITHUB_TOKEN env var not set', duration_ms: Date.now() - start };
        const url = apiEndpoint.startsWith('http') ? apiEndpoint : `https://api.github.com${apiEndpoint.startsWith('/') ? '' : '/'}${apiEndpoint}`;
        let resp: Response;
        try {
          resp = await fetch(url, {
            method,
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: {
              'Authorization': `Bearer ${token}`,
              'Accept': 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              'User-Agent': 'TRIDENT-CLI/1.0',
              ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
        } catch (e) {
          return { success: false, output: '', error: `GitHub API request failed: ${e instanceof Error ? e.message : String(e)}`, duration_ms: Date.now() - start };
        }
        let text: string;
        try { text = await resp.text(); } catch (e) { return { success: false, output: '', error: `Failed to read response: ${e instanceof Error ? e.message : String(e)}`, duration_ms: Date.now() - start }; }
        if (!resp.ok) return { success: false, output: text.slice(0, 2000), error: `GitHub API error: HTTP ${resp.status}`, duration_ms: Date.now() - start };
        return { success: true, output: text.slice(0, 16000), duration_ms: Date.now() - start };
      }

      case 'spawn_agent': {
        const { task, context } = call.input as { task: string; context?: string };
        const systemPrompt = context || '';
        if (!spawnAgentFn) {
          return { success: false, output: '', error: 'spawn_agent not available in this context', duration_ms: Date.now() - start };
        }
        const result = await spawnAgentFn(task, systemPrompt);
        return { success: result.success, output: result.output, duration_ms: Date.now() - start };
      }

      case 'read_notebook': {
        const { path: filePath } = call.input as { path: string };
        const absPath = resolveWorkspacePath(cwd, filePath);
        if (!existsSync(absPath)) return { success: false, output: '', error: `File not found: ${absPath}`, duration_ms: Date.now() - start };
        const raw = await readFile(absPath, 'utf-8');
        let nb: any;
        try { nb = JSON.parse(raw); } catch { return { success: false, output: '', error: 'Invalid notebook JSON', duration_ms: Date.now() - start }; }
        const cells = nb.cells || [];
        const lines: string[] = [`# Notebook: ${filePath} (${cells.length} cells)\n`];
        for (let i = 0; i < cells.length; i++) {
          const cell = cells[i];
          const src = Array.isArray(cell.source) ? cell.source.join('') : cell.source || '';
          lines.push(`## Cell ${i} [${cell.cell_type}]`);
          lines.push(src);
          const outputs = cell.outputs || [];
          for (const out of outputs) {
            if (out.output_type === 'stream') {
              lines.push('Output: ' + (Array.isArray(out.text) ? out.text.join('') : out.text || ''));
            } else if (out.output_type === 'error') {
              lines.push('Error: ' + out.ename + ': ' + out.evalue);
            } else if (out.data?.['text/plain']) {
              lines.push('Result: ' + (Array.isArray(out.data['text/plain']) ? out.data['text/plain'].join('') : out.data['text/plain']));
            }
          }
          lines.push('');
        }
        return { success: true, output: lines.join('\n').slice(0, 16000), duration_ms: Date.now() - start };
      }

      case 'edit_notebook_cell': {
        const { path: filePath, cell_index, source } = call.input as { path: string; cell_index: number; source: string };
        const absPath = resolveWorkspacePath(cwd, filePath);
        if (!existsSync(absPath)) return { success: false, output: '', error: `File not found: ${absPath}`, duration_ms: Date.now() - start };
        const raw = await readFile(absPath, 'utf-8');
        let nb: any;
        try { nb = JSON.parse(raw); } catch { return { success: false, output: '', error: 'Invalid notebook JSON', duration_ms: Date.now() - start }; }
        if (!nb.cells || cell_index < 0 || cell_index >= nb.cells.length) {
          return { success: false, output: '', error: `Cell index ${cell_index} out of range (0-${(nb.cells?.length || 1) - 1})`, duration_ms: Date.now() - start };
        }
        nb.cells[cell_index].source = source.split('\n').map((l: string, i: number, arr: string[]) => i < arr.length - 1 ? l + '\n' : l);
        await writeFile(absPath, JSON.stringify(nb, null, 1), 'utf-8');
        return { success: true, output: `Cell ${cell_index} updated in ${relative(cwd, absPath)}`, duration_ms: Date.now() - start };
      }

      case 'read_pdf': {
        const { path: filePath, pages } = call.input as { path: string; pages?: string };
        const absPath = resolveWorkspacePath(cwd, filePath);
        if (!existsSync(absPath)) return { success: false, output: '', error: `File not found: ${absPath}`, duration_ms: Date.now() - start };
        const pageFlag = pages ? `-f ${pages.split('-')[0] || 1} -l ${pages.split('-')[1] || 999}` : '';
        const isWin = process.platform === 'win32';
        const res = await execa(isWin ? 'cmd' : 'bash', [isWin ? '/c' : '-c', `pdftotext ${pageFlag} "${absPath}" -`], { reject: false, all: true, timeout: 30000 });
        const out = typeof res.all === 'string' ? res.all : '';
        if (res.exitCode !== 0) {
          if (out.includes('command not found') || res.exitCode === 127) {
            return { success: false, output: '', error: 'pdftotext not found. Install poppler-utils: apt install poppler-utils / brew install poppler', duration_ms: Date.now() - start };
          }
          return { success: false, output: out.slice(0, 2000), error: `pdftotext failed (exit ${res.exitCode})`, duration_ms: Date.now() - start };
        }
        return { success: true, output: out.slice(0, 32000), duration_ms: Date.now() - start };
      }

      case 'read_image': {
        const { path: filePath } = call.input as { path: string };
        const absPath = resolveWorkspacePath(cwd, filePath);
        if (!existsSync(absPath)) return { success: false, output: '', error: `File not found: ${absPath}`, duration_ms: Date.now() - start };
        const ext = filePath.split('.').pop()?.toLowerCase() || '';
        const mediaTypeMap: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
        const mediaType = mediaTypeMap[ext];
        if (!mediaType) return { success: false, output: '', error: `Unsupported image format: .${ext}. Supported: jpg, png, gif, webp`, duration_ms: Date.now() - start };
        const bytes = await readFile(absPath);
        const b64 = bytes.toString('base64');
        // Return as a special marker that loop.ts can detect for vision injection
        return { success: true, output: `__IMAGE_BLOCK__:${mediaType}:${b64}`, duration_ms: Date.now() - start };
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

  if (relativePath === '') {
    return resolvedPath;
  }

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Path escapes workspace root: ${targetPath}`);
  }

  return resolvedPath;
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
  {
    name: 'memory_update',
    description: 'Persist a fact or note to long-term agent memory across sessions.',
    input_schema: {
      type: 'object',
      properties: { fact: { type: 'string', description: 'The fact or note to remember' } },
      required: ['fact'],
    },
  },
  {
    name: 'git_blame',
    description: 'Show who last modified each line of a file (git blame)',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file' },
        startLine: { type: 'number', description: 'Optional start line' },
        endLine: { type: 'number', description: 'Optional end line' },
      },
      required: ['path'],
    },
  },
  {
    name: 'web_search',
    description: 'Search the web using DuckDuckGo and return result titles, URLs, and snippets',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        maxResults: { type: 'number', description: 'Max results to return (default 8)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'github_api',
    description: 'Call the GitHub REST API (requires GITHUB_TOKEN env var). Use for reading issues, PRs, creating PRs, etc.',
    input_schema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'HTTP method: GET, POST, PATCH, DELETE (default: GET)' },
        path: { type: 'string', description: 'API path e.g. /repos/owner/repo/issues or full URL' },
        body: { type: 'object', description: 'Request body for POST/PATCH' },
      },
      required: ['path'],
    },
  },
  {
    name: 'spawn_agent',
    description: 'Spawn a sub-agent to handle a focused sub-task in isolation and return its output. Use for parallelizable work or tasks that need a clean context.',
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task for the sub-agent' },
        context: { type: 'string', description: 'Optional extra context/instructions for the sub-agent' },
      },
      required: ['task'],
    },
  },
  {
    name: 'read_notebook',
    description: 'Read and render a Jupyter notebook (.ipynb) showing all cells and outputs',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the .ipynb file' } },
      required: ['path'],
    },
  },
  {
    name: 'edit_notebook_cell',
    description: 'Edit a specific cell in a Jupyter notebook by index (0-based)',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the .ipynb file' },
        cell_index: { type: 'number', description: 'Zero-based index of the cell to edit' },
        source: { type: 'string', description: 'New source content for the cell' },
      },
      required: ['path', 'cell_index', 'source'],
    },
  },
  {
    name: 'read_pdf',
    description: "Extract text from a PDF file using pdftotext. Optional pages range e.g. '1-5'",
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the PDF file' },
        pages: { type: 'string', description: "Optional page range e.g. '1-5'" },
      },
      required: ['path'],
    },
  },
  {
    name: 'read_image',
    description: 'Read an image file (jpg, png, gif, webp) and make it visible to the AI for visual analysis',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the image file' } },
      required: ['path'],
    },
  },
];
