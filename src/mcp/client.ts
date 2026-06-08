import { spawn, ChildProcess } from 'child_process';

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPServerConfig {
  command: string;         // e.g. "npx"
  args?: string[];         // e.g. ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
  env?: Record<string, string>;
  name?: string;           // display name
}

export class MCPClient {
  private proc: ChildProcess;
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private tools: MCPToolDefinition[] = [];
  private serverName: string;
  private buffer = '';

  constructor(config: MCPServerConfig) {
    this.serverName = config.name || config.command;
    this.proc = spawn(config.command, config.args || [], {
      env: { ...process.env, ...(config.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as {
            id?: number;
            error?: { message?: string };
            result?: unknown;
          };
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const handler = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) handler.reject(new Error(msg.error.message || 'MCP error'));
            else handler.resolve(msg.result);
          }
        } catch {
          // ignore parse errors
        }
      }
    });

    this.proc.stderr?.on('data', () => {}); // silence stderr — errors surface via rejected promises

    // Fail all pending requests immediately if the server exits or errors
    const rejectAll = (reason: string) => {
      for (const [, handler] of this.pending) {
        handler.reject(new Error(reason));
      }
      this.pending.clear();
    };
    this.proc.on('exit', (code) => rejectAll(`MCP server exited (code ${code ?? 'null'})`));
    this.proc.on('error', (err) => rejectAll(`MCP server error: ${err.message}`));
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.proc.stdin?.write(msg + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, 30000);
    });
  }

  /** Send a JSON-RPC notification (no id, no response expected). */
  private notify(method: string, params?: unknown): void {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.proc.stdin?.write(msg + '\n');
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'trident-cli', version: '1.0.0' },
    });
    // 'notifications/initialized' is a JSON-RPC notification (no id, no response).
    // Sending it as a request would cause an unresolvable pending promise / timeout.
    this.notify('notifications/initialized');
    await this.listTools();
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    const result = await this.request('tools/list') as {
      tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    };
    this.tools = (result?.tools || []).map(t => ({
      name: `${this.serverName}__${t.name}`,
      description: `[${this.serverName}] ${t.description}`,
      inputSchema: t.inputSchema,
    }));
    return this.tools;
  }

  getTools(): MCPToolDefinition[] { return this.tools; }

  getServerName(): string { return this.serverName; }

  async callTool(name: string, input: Record<string, unknown>): Promise<string> {
    // Strip server prefix from name
    const rawName = name.replace(`${this.serverName}__`, '');
    const result = await this.request('tools/call', { name: rawName, arguments: input }) as {
      content: Array<{ type: string; text?: string }>;
    };
    return (result?.content || []).map(c => c.text || '').join('\n');
  }

  destroy(): void {
    try {
      // Close stdin first so the child process gets EOF and can shut down cleanly
      this.proc.stdin?.end();
    } catch {
      // ignore
    }
    try {
      this.proc.kill();
    } catch {
      // ignore errors on destroy
    }
    // Reject any pending requests so callers don't hang
    for (const [, handler] of this.pending) {
      handler.reject(new Error('MCP client destroyed'));
    }
    this.pending.clear();
  }
}

export interface MCPConfig {
  servers: MCPServerConfig[];
}

export async function loadMCPConfig(): Promise<MCPConfig> {
  const { homedir } = await import('os');
  const { readFile } = await import('fs/promises');
  const { join } = await import('path');
  const { existsSync } = await import('fs');
  const configPath = join(homedir(), '.trident', 'mcp.json');
  if (!existsSync(configPath)) return { servers: [] };
  try {
    return JSON.parse(await readFile(configPath, 'utf-8')) as MCPConfig;
  } catch { return { servers: [] }; }
}
