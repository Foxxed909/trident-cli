import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export const MCP_TOOL_PREFIX = 'mcp__';
const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 60_000;

export function mcpConfigPath(cwd: string): string {
  return join(cwd, '.trident', 'mcp.json');
}

const MCP_TRUST_FILE = join(homedir(), '.trident', 'mcp-trust.json');
const SAFE_PARENT_ENV = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM',
  'TMP', 'TEMP', 'TMPDIR',
  'USERNAME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT',
];

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + stableJson(obj[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function canonicalWorkspace(cwd: string): string {
  try { return realpathSync(cwd); } catch { return resolve(cwd); }
}

export function mcpConfigFingerprint(config: McpConfig): string {
  return createHash('sha256').update(stableJson(config)).digest('hex');
}

async function loadMcpTrust(): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(MCP_TRUST_FILE, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, string>
      : {};
  } catch {
    return {};
  }
}

export async function isMcpConfigTrusted(cwd: string, config: McpConfig): Promise<boolean> {
  const trust = await loadMcpTrust();
  return trust[canonicalWorkspace(cwd)] === mcpConfigFingerprint(config);
}

export async function trustMcpConfig(cwd: string, config: McpConfig): Promise<void> {
  const trust = await loadMcpTrust();
  trust[canonicalWorkspace(cwd)] = mcpConfigFingerprint(config);
  await mkdir(join(homedir(), '.trident'), { recursive: true, mode: 0o700 });
  await writeFile(MCP_TRUST_FILE, JSON.stringify(trust, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

function expandConfiguredEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined) throw new Error(`MCP config requested missing environment variable ${name}`);
    return resolved;
  });
}

export function buildMcpEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_PARENT_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    env[key] = expandConfiguredEnv(String(value));
  }
  return env;
}

/** Load .trident/mcp.json. Returns null when absent; throws on malformed JSON. */
export async function loadMcpConfig(cwd: string): Promise<McpConfig | null> {
  const path = mcpConfigPath(cwd);
  if (!existsSync(path)) {
    return null;
  }
  const raw = await readFile(path, 'utf-8');
  const parsed = JSON.parse(raw) as McpConfig;
  if (!parsed || typeof parsed.mcpServers !== 'object' || parsed.mcpServers === null) {
    throw new Error('.trident/mcp.json must contain an "mcpServers" object.');
  }
  for (const [name, server] of Object.entries(parsed.mcpServers)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new Error(`Invalid MCP server name "${name}". Use letters, digits, - and _ only.`);
    }
    if (!server || typeof server.command !== 'string' || !server.command.trim()) {
      throw new Error(`MCP server "${name}" needs a "command" string.`);
    }
  }
  return parsed;
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!isMcpToolName(name)) {
    return null;
  }
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const sep = rest.indexOf('__');
  if (sep <= 0) {
    return null;
  }
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

interface ConnectedServer {
  name: string;
  client: Client;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}

export interface McpServerStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

/**
 * Manages stdio MCP server connections for one session. Tools are exposed to
 * the agent as mcp__<server>__<tool>.
 */
export class McpManager {
  private servers = new Map<string, ConnectedServer>();
  private statuses: McpServerStatus[] = [];

  static async connect(config: McpConfig, cwd: string): Promise<McpManager> {
    const manager = new McpManager();

    await Promise.all(Object.entries(config.mcpServers).map(async ([name, serverConfig]) => {
      try {
        const client = new Client({ name: 'trident-cli', version: '1.0.0' });
        const transport = new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args ?? [],
          env: buildMcpEnvironment(serverConfig.env ?? {}),
          cwd,
          stderr: 'ignore',
        });

        await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `MCP server "${name}" did not connect within ${CONNECT_TIMEOUT_MS / 1000}s`);
        const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `MCP server "${name}" did not list tools in time`);

        const tools = (listed.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description ?? '',
          inputSchema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
        }));

        manager.servers.set(name, { name, client, tools });
        manager.statuses.push({ name, connected: true, toolCount: tools.length });
      } catch (err) {
        manager.statuses.push({
          name,
          connected: false,
          toolCount: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }));

    return manager;
  }

  getStatuses(): McpServerStatus[] {
    return [...this.statuses];
  }

  /** Tool definitions in the provider (Anthropic-style) format, namespaced. */
  getToolDefinitions(): McpToolDefinition[] {
    const defs: McpToolDefinition[] = [];
    for (const server of this.servers.values()) {
      for (const tool of server.tools) {
        defs.push({
          name: `${MCP_TOOL_PREFIX}${server.name}__${tool.name}`,
          description: `[MCP:${server.name}] ${tool.description}`.slice(0, 1024),
          input_schema: tool.inputSchema,
        });
      }
    }
    return defs;
  }

  async callTool(namespacedName: string, input: Record<string, unknown>): Promise<{ success: boolean; output: string; error?: string }> {
    const parsed = parseMcpToolName(namespacedName);
    if (!parsed) {
      return { success: false, output: '', error: `Malformed MCP tool name: ${namespacedName}` };
    }
    const server = this.servers.get(parsed.server);
    if (!server) {
      return { success: false, output: '', error: `MCP server "${parsed.server}" is not connected.` };
    }

    try {
      const result = await withTimeout(
        server.client.callTool({ name: parsed.tool, arguments: input }),
        CALL_TIMEOUT_MS,
        `MCP tool ${namespacedName} timed out after ${CALL_TIMEOUT_MS / 1000}s`
      );

      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .map((block: { type?: string; text?: string; data?: string; mimeType?: string }) => {
          if (block.type === 'text') return block.text ?? '';
          if (block.type === 'image') return `[image ${block.mimeType ?? ''}]`;
          return JSON.stringify(block);
        })
        .join('\n');

      if (result.isError) {
        return { success: false, output: '', error: text.slice(0, 4000) || 'MCP tool reported an error.' };
      }
      return { success: true, output: text.slice(0, 16_000) };
    } catch (err) {
      return { success: false, output: '', error: err instanceof Error ? err.message : String(err) };
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.servers.values()].map(async (server) => {
      try {
        await server.client.close();
      } catch {
        // Best-effort shutdown.
      }
    }));
    this.servers.clear();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}
