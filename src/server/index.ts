import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { existsSync, createReadStream, statSync } from 'fs';
import { join, resolve, extname, dirname } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, type WebSocket } from 'ws';
import { runAgentLoop, type ProviderName } from '../agent/loop.js';
import type { ToolCall } from '../agent/tools.js';
import type { ChatMessage } from '../providers/anthropic.js';
import type { ApprovalMode, RiskLevel } from '../warden/index.js';
import { commandMatchesAllowlist } from '../warden/index.js';
import { getRawConfig } from '../config.js';
import type { McpManager } from '../mcp/index.js';

export interface ServeOptions {
  port: number;
  host: string;
  cwd: string;
  provider: ProviderName;
  model: string;
  mode: ApprovalMode;
  maxTurns: number;
  budgetUsd?: number;
  logSessions: boolean;
  systemPrompt: string;
  protectedPaths: string[];
  userName: string;
  projectName: string;
  mcp: McpManager | null;
}

interface ClientMessage {
  type: 'task' | 'approve' | 'answer' | 'set_mode';
  id?: string;
  requestId?: string;
  task?: string;
  approved?: boolean;
  text?: string;
  mode?: string;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

function webDistDir(): string {
  // dist/server/index.js -> <package root>/web/dist
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'web', 'dist');
}

function getAllowedCommands(): string[] {
  const raw = getRawConfig().allowedCommands;
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

export async function startServer(opts: ServeOptions): Promise<{ close: () => void; url: string }> {
  const staticDir = webDistDir();

  const httpServer = createServer((req, res) => {
    handleHttp(req, res, staticDir, opts);
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (socket) => {
    handleConnection(socket, opts);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once('error', rejectListen);
    httpServer.listen(opts.port, opts.host, () => resolveListen());
  });

  const url = `http://${opts.host}:${opts.port}`;
  return {
    url,
    close: () => {
      wss.close();
      httpServer.close();
    },
  };
}

function handleHttp(req: IncomingMessage, res: ServerResponse, staticDir: string, opts: ServeOptions): void {
  const urlPath = (req.url || '/').split('?')[0];

  if (urlPath === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(statusPayload(opts)));
    return;
  }

  if (!existsSync(staticDir)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>TRIDENT</title><body style="font-family:monospace;background:#0B1220;color:#E2E8F0;padding:3rem"><h1>TRIDENT serve is running</h1><p>WebSocket: <code>ws://${req.headers.host}/ws</code></p><p>The web UI build was not found. Run <code>npm run build</code> inside <code>web/</code> to enable it.</p></body>`);
    return;
  }

  const safePath = resolve(staticDir, '.' + (urlPath === '/' ? '/index.html' : urlPath));
  if (!safePath.startsWith(staticDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const filePath = existsSync(safePath) && statSync(safePath).isFile()
    ? safePath
    : join(staticDir, 'index.html'); // SPA fallback

  res.writeHead(200, { 'Content-Type': MIME_TYPES[extname(filePath)] || 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
}

function statusPayload(opts: ServeOptions): Record<string, unknown> {
  return {
    project: opts.projectName,
    provider: opts.provider,
    model: opts.model,
    mode: opts.mode,
    userName: opts.userName,
    protectedPaths: opts.protectedPaths,
    mcpServers: opts.mcp ? opts.mcp.getStatuses() : [],
  };
}

function handleConnection(socket: WebSocket, opts: ServeOptions): void {
  const history: ChatMessage[] = [];
  const pending = new Map<string, (value: string) => void>();
  let mode: ApprovalMode = opts.mode;
  let sessionCost = 0;
  let busy = false;

  const send = (msg: Record<string, unknown>): void => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  };

  send({ type: 'hello', payload: { ...statusPayload(opts), mode } });

  const waitForClient = (requestId: string): Promise<string> =>
    new Promise((resolveWait) => {
      pending.set(requestId, resolveWait);
    });

  const approvalFn = async (call: ToolCall, activeMode: ApprovalMode, risk: RiskLevel): Promise<boolean> => {
    if (activeMode === 'yolo') return true;
    if (activeMode === 'review') {
      if (risk === 'read') return true;
      if (call.name === 'run_command' && risk !== 'destructive' &&
          commandMatchesAllowlist((call.input.cmd as string) || '', getAllowedCommands())) {
        return true;
      }
    }
    const requestId = randomUUID();
    send({ type: 'approval_request', requestId, call: { name: call.name, input: call.input }, risk });
    const answer = await waitForClient(requestId);
    return answer === 'true';
  };

  socket.on('message', async (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(data)) as ClientMessage;
    } catch {
      send({ type: 'error', message: 'Malformed message.' });
      return;
    }

    if (msg.type === 'approve' && msg.requestId) {
      pending.get(msg.requestId)?.(String(!!msg.approved));
      pending.delete(msg.requestId);
      return;
    }

    if (msg.type === 'answer' && msg.requestId) {
      pending.get(msg.requestId)?.(msg.text || '');
      pending.delete(msg.requestId);
      return;
    }

    if (msg.type === 'set_mode') {
      if (msg.mode === 'yolo' || msg.mode === 'review' || msg.mode === 'lockdown') {
        mode = msg.mode;
        send({ type: 'mode', mode });
      }
      return;
    }

    if (msg.type === 'task') {
      const task = (msg.task || '').trim();
      const id = msg.id || randomUUID();
      if (!task) return;
      if (busy) {
        send({ type: 'task_error', id, message: 'A task is already running on this connection.' });
        return;
      }

      busy = true;
      send({ type: 'task_start', id });
      try {
        const result = await runAgentLoop(task, {
          cwd: opts.cwd,
          mode,
          model: opts.model,
          provider: opts.provider,
          systemPrompt: opts.systemPrompt,
          maxTurns: opts.maxTurns,
          budgetUsd: opts.budgetUsd !== undefined ? Math.max(0, opts.budgetUsd - sessionCost) : undefined,
          logSessions: opts.logSessions,
          sessionId: id,
          history,
          protectedPaths: opts.protectedPaths,
          showDiffs: false,
          mcp: opts.mcp,
          approvalFn,
          onText: (text) => send({ type: 'text', id, text }),
          onToolStart: (call) => send({ type: 'tool_start', id, call: { name: call.name, input: call.input } }),
          onToolEnd: (call, result) => send({
            type: 'tool_end',
            id,
            name: call.name,
            success: result.success,
            error: result.error,
            duration_ms: result.duration_ms,
            outputPreview: (result.output || '').slice(0, 2000),
          }),
          askUserFn: async (question: string): Promise<string> => {
            const requestId = randomUUID();
            send({ type: 'ask_user', requestId, question });
            return waitForClient(requestId);
          },
        });

        sessionCost += result.totalCost;
        send({ type: 'task_result', id, result, sessionCost });
      } catch (err) {
        send({ type: 'task_error', id, message: err instanceof Error ? err.message : String(err) });
      } finally {
        busy = false;
      }
    }
  });

  socket.on('close', () => {
    pending.clear();
  });
}
