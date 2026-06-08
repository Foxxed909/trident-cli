import chalk from 'chalk';
import { extname } from 'path';
import { execa } from 'execa';
import { createDiffView } from '../ui/diff.js';
import { streamCompletion, calculateCost } from '../providers/anthropic.js';
import { streamOpenRouter, calculateOpenRouterCost } from '../providers/openrouter.js';
import { streamVertex, calculateVertexCost } from '../providers/vertex.js';
import { streamBedrock, calculateBedrockCost } from '../providers/bedrock.js';
import { executeTool, TOOL_DEFINITIONS, resolveWorkspacePath, type ToolCall, type ToolResult } from './tools.js';
import { classifyRisk, requestApproval, SessionLogger } from '../warden/index.js';
import type { ChatMessage } from '../providers/anthropic.js';
import type { ApprovalMode, PermitRule } from '../warden/index.js';

export type ProviderName = 'anthropic' | 'openrouter' | 'vertex' | 'bedrock';

const READ_ONLY_TOOLS = new Set<string>(['read_file', 'list_dir', 'search_codebase']);
const WRITE_TOOLS = new Set<string>(['write_file', 'edit_file']);

export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'claude-opus-4-7':           200000,
  'claude-opus-4-5':           200000,
  'claude-sonnet-4-6':         200000,
  'claude-sonnet-4-5':         200000,
  'claude-haiku-4-5-20251001': 200000,
};

export function getContextLimit(model: string): number {
  return MODEL_CONTEXT_LIMITS[model] ?? 200000;
}

const FORMATTERS: Record<string, string> = {
  '.ts': 'npx --yes prettier --write',
  '.tsx': 'npx --yes prettier --write',
  '.js': 'npx --yes prettier --write',
  '.jsx': 'npx --yes prettier --write',
  '.json': 'npx --yes prettier --write',
  '.css': 'npx --yes prettier --write',
  '.html': 'npx --yes prettier --write',
  '.py': 'black',
  '.go': 'gofmt -w',
  '.rs': 'rustfmt',
};

export interface AgentOptions {
  cwd: string;
  mode: ApprovalMode;
  model: string;
  provider: ProviderName;
  systemPrompt: string;
  maxTurns: number;
  budgetUsd?: number;
  logSessions: boolean;
  sessionId: string;
  thinking?: boolean;
  thinkingBudget?: number;
  abortSignal?: AbortSignal;
  onText?: (text: string) => void;
  onToolStart?: (call: ToolCall) => void | Promise<void>;
  beforeToolExecute?: (call: ToolCall) => void | Promise<void>;
  onToolEnd?: (call: ToolCall, result: ToolResult) => void;
  onCostUpdate?: (totalCost: number, tokens: { input: number; output: number }) => void;
  onTurnComplete?: (turn: number, turnCost: number, turnTokens: { input: number; output: number }) => void;
  onTurnStart?: (turn: number, maxTurns: number) => (() => void) | void;
  onContextPressure?: () => void;
  autoTest?: boolean;
  testCommand?: string;
  autoFormat?: boolean;
  toolResultCaching?: boolean;
  cacheTools?: boolean;
  permitRules?: PermitRule[];
  askUserFn: (question: string) => Promise<string>;
}

export interface AgentResult {
  success: boolean;
  summary: string;
  turns: number;
  totalCost: number;
  totalTokens: { input: number; output: number };
  turnCosts: Array<{ turn: number; cost: number }>;
}

function calcCost(provider: ProviderName, model: string, input: number, output: number): number {
  switch (provider) {
    case 'openrouter': return calculateOpenRouterCost(model, input, output);
    case 'vertex':     return calculateVertexCost(model, input, output);
    case 'bedrock':    return calculateBedrockCost(model, input, output);
    default:           return calculateCost(model, input, output);
  }
}

export async function runAgentLoop(
  initialTask: string,
  opts: AgentOptions
): Promise<AgentResult> {
  const logger = new SessionLogger(opts.sessionId, opts.logSessions);
  const messages: ChatMessage[] = [{ role: 'user', content: initialTask }];

  const enableToolCache = opts.toolResultCaching !== false && opts.cacheTools !== false;
  const toolCache = new Map<string, ToolResult>();

  let turns = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalSummary = 'Task completed.';
  let finalAnswerFound = false;
  let budgetExceeded = false;
  let warnedMaxTurns = false;
  const turnCostHistory: Array<{ turn: number; cost: number }> = [];

  while (turns < opts.maxTurns) {
    // Check for abort before each turn
    if (opts.abortSignal?.aborted) {
      finalSummary = 'Interrupted by user.';
      break;
    }

    turns++;

    // Start per-turn spinner; returns a stop function called on first output
    const _stopSpinFn = opts.onTurnStart?.(turns, opts.maxTurns);
    let spinStopped = false;
    const stopSpin = () => {
      if (!spinStopped) {
        spinStopped = true;
        _stopSpinFn?.();
      }
    };

    let assistantText = '';
    let pendingToolCalls: Array<{ id: string; name: ToolCall['name']; input: Record<string, unknown> }> = [];

    let streamAttempt = 0;
    let turnInputTokens = 0;
    let turnOutputTokens = 0;
    while (true) {
      assistantText = '';
      pendingToolCalls = [];
      turnInputTokens = 0;
      turnOutputTokens = 0;
      try {
        let stream: AsyncGenerator<import('../providers/anthropic.js').StreamChunk>;
        switch (opts.provider) {
          case 'openrouter':
            stream = streamOpenRouter(messages, {
              model: opts.model,
              maxTokens: 8096,
              systemPrompt: opts.systemPrompt,
              tools: TOOL_DEFINITIONS,
              apiKey: process.env.OPENROUTER_API_KEY || '',
            });
            break;
          case 'vertex':
            stream = streamVertex(messages, {
              model: opts.model,
              maxTokens: 8096,
              systemPrompt: opts.systemPrompt,
              tools: TOOL_DEFINITIONS,
            });
            break;
          case 'bedrock':
            stream = streamBedrock(messages, {
              model: opts.model,
              maxTokens: 8096,
              systemPrompt: opts.systemPrompt,
              tools: TOOL_DEFINITIONS,
            });
            break;
          default:
            stream = streamCompletion(messages, {
              model: opts.model,
              maxTokens: 8096,
              systemPrompt: opts.systemPrompt,
              tools: TOOL_DEFINITIONS,
              thinking: opts.thinking,
              thinkingBudget: opts.thinkingBudget,
              signal: opts.abortSignal,
            });
        }

        for await (const chunk of stream) {
          if (opts.abortSignal?.aborted) {
            break;
          }
          if (chunk.type === 'text' && chunk.text) {
            stopSpin();
            assistantText += chunk.text;
            opts.onText?.(chunk.text);
          } else if (chunk.type === 'tool_call' && chunk.toolCall) {
            stopSpin();
            pendingToolCalls.push(chunk.toolCall);
          } else if (chunk.type === 'usage' && chunk.usage) {
            turnInputTokens = chunk.usage.inputTokens;
            turnOutputTokens = chunk.usage.outputTokens;
          }
        }

        stopSpin(); // ensure stopped even on usage-only responses

        totalInputTokens += turnInputTokens;
        totalOutputTokens += turnOutputTokens;
        const cost = calcCost(opts.provider, opts.model, totalInputTokens, totalOutputTokens);
        opts.onCostUpdate?.(cost, { input: totalInputTokens, output: totalOutputTokens });

        const turnCost = calcCost(opts.provider, opts.model, turnInputTokens, turnOutputTokens);
        turnCostHistory.push({ turn: turns, cost: turnCost });
        opts.onTurnComplete?.(turns, turnCost, { input: turnInputTokens, output: turnOutputTokens });
        break;
      } catch (err) {
        stopSpin();
        const error = err instanceof Error ? err : new Error(String(err));
        // If aborted, exit gracefully
        if (opts.abortSignal?.aborted) {
          finalSummary = 'Interrupted by user.';
          return {
            success: false,
            summary: finalSummary,
            turns,
            totalCost: calcCost(opts.provider, opts.model, totalInputTokens, totalOutputTokens),
            totalTokens: { input: totalInputTokens, output: totalOutputTokens },
            turnCosts: turnCostHistory,
          };
        }
        const isTransient = /ECONNRESET|ETIMEDOUT|rate.?limit|overloaded|503|529/i.test(error.message);
        if (!isTransient || streamAttempt >= 2) {
          throw error;
        }
        streamAttempt++;
        console.log(chalk.yellow(`\n  retrying after API error (${error.message.slice(0, 60)}) ${streamAttempt}/2...`));
        await new Promise((r) => setTimeout(r, 1500 * streamAttempt));
      }
    }

    // If aborted mid-stream, exit
    if (opts.abortSignal?.aborted) {
      finalSummary = 'Interrupted by user.';
      break;
    }

    const assistantContent: ChatMessage['content'] = [];

    if (assistantText) {
      (assistantContent as Array<{ type: string; text?: string }>).push({ type: 'text', text: assistantText });
    }

    for (const tc of pendingToolCalls) {
      (assistantContent as Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }>).push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: tc.input,
      });
    }

    messages.push({ role: 'assistant', content: assistantContent });

    if (!warnedMaxTurns && turns >= Math.floor(opts.maxTurns * 0.8)) {
      console.log(chalk.yellow(`\n  [TRIDENT] Approaching turn limit (${turns}/${opts.maxTurns}). Use /compact or increase --max-turns if needed.`));
      warnedMaxTurns = true;
    }

    const contextPct = Math.round(((totalInputTokens + totalOutputTokens) / getContextLimit(opts.model)) * 100);
    if (contextPct >= 80 && !warnedMaxTurns) {
      opts.onContextPressure?.();
    }

    const runningCost = calcCost(opts.provider, opts.model, totalInputTokens, totalOutputTokens);
    if (opts.budgetUsd !== undefined && runningCost >= opts.budgetUsd) {
      finalSummary = `Stopped after reaching the session budget of $${opts.budgetUsd.toFixed(2)}. Increase --budget or reduce scope to continue.`;
      budgetExceeded = true;
      break;
    }

    const finalAnswerCall = pendingToolCalls.find((tc) => tc.name === 'final_answer');
    if (finalAnswerCall || pendingToolCalls.length === 0) {
      if (finalAnswerCall) {
        finalSummary = (finalAnswerCall.input.summary as string) || 'Task completed.';
        finalAnswerFound = true;
      }
      break;
    }

    const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];

    for (const tc of pendingToolCalls) {
      const call: ToolCall = { name: tc.name, input: tc.input };
      const risk = classifyRisk(call);

      if (opts.onToolStart) {
        await opts.onToolStart(call);
      }

      if (call.name === 'write_file' || call.name === 'edit_file') {
        await showDiffPreview(call, opts.cwd);
      }

      const approved = await requestApproval(call, opts.mode, risk, opts.permitRules);

      if (!approved) {
        const result: ToolResult = {
          success: false,
          output: '',
          error: 'User denied this action.',
          duration_ms: 0,
        };
        opts.onToolEnd?.(call, result);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: JSON.stringify(result),
        });
        await logger.log({ toolName: call.name, input: call.input, result, approved: false, riskLevel: risk });
        continue;
      }

      if (opts.beforeToolExecute) {
        await opts.beforeToolExecute(call);
      }

      let result: ToolResult;
      if (enableToolCache && READ_ONLY_TOOLS.has(call.name)) {
        const cacheKey = `${call.name}:${JSON.stringify(call.input)}`;
        const cached = toolCache.get(cacheKey);
        if (cached) {
          result = cached;
        } else {
          result = await executeTool(call, opts.cwd, opts.askUserFn);
          if (result.success) toolCache.set(cacheKey, result);
        }
      } else {
        result = await executeTool(call, opts.cwd, opts.askUserFn);
        if (enableToolCache && WRITE_TOOLS.has(call.name)) {
          const filePath = call.input.path as string | undefined;
          if (filePath) {
            for (const key of toolCache.keys()) {
              if (key.startsWith('read_file:')) {
                try {
                  const keyInput = JSON.parse(key.slice('read_file:'.length)) as { path?: string };
                  if (keyInput.path === filePath) toolCache.delete(key);
                } catch { /* skip */ }
              }
            }
          }
        }
      }
      opts.onToolEnd?.(call, result);

      await logger.log({ toolName: call.name, input: call.input, result, approved: true, riskLevel: risk });

      let baseContent = result.success
        ? result.output
        : `ERROR: ${result.error}\n${result.output}`;

      // Auto-format after successful writes
      if (result.success && opts.autoFormat && (call.name === 'write_file' || call.name === 'edit_file')) {
        const filePath = call.input.path as string;
        const ext = extname(filePath);
        const fmtCmd = FORMATTERS[ext];
        if (fmtCmd) {
          const isWin = process.platform === 'win32';
          await execa(isWin ? 'cmd' : 'bash', [isWin ? '/c' : '-c', `${fmtCmd} "${filePath}"`], { cwd: opts.cwd, reject: false, timeout: 15000 }).catch(() => {});
          baseContent += '\n[auto-formatted]';
        }
      }

      // Auto-test after successful writes
      if (result.success && opts.autoTest && opts.testCommand && (call.name === 'write_file' || call.name === 'edit_file')) {
        const isWin = process.platform === 'win32';
        const testRes = await execa(isWin ? 'cmd' : 'bash', [isWin ? '/c' : '-c', opts.testCommand], { cwd: opts.cwd, reject: false, timeout: 60000, all: true });
        const testOut = (typeof testRes.all === 'string' ? testRes.all : '').slice(-3000);
        const testStatus = testRes.exitCode === 0 ? 'PASS' : 'FAIL';
        baseContent += `\n\n[auto-test: ${testStatus}]\n${testOut}`;
      }

      // Auto-retry hint when an edit was ambiguous so the agent knows to use more context
      const isAmbiguousEdit = !result.success && typeof result.error === 'string' && result.error.includes('Ambiguous edit');
      const messageContent = isAmbiguousEdit
        ? `${baseContent}\n\nHINT: Retry edit_file with a more specific old_str — include additional surrounding lines above and below the target so the match is unique.`
        : baseContent;

      toolResults.push({
        type: 'tool_result',
        tool_use_id: tc.id,
        content: messageContent || '(no output)',
      });
    }

    messages.push({ role: 'user', content: toolResults as unknown as ChatMessage['content'] });
  }

  const totalCost = calcCost(opts.provider, opts.model, totalInputTokens, totalOutputTokens);

  if (!finalAnswerFound && !budgetExceeded && turns >= opts.maxTurns) {
    finalSummary = `Stopped after ${turns} turns (max turn limit reached). The task may be incomplete - resume by re-running with a continuation prompt.`;
  }

  return {
    success: finalAnswerFound,
    summary: finalSummary,
    turns,
    totalCost,
    totalTokens: { input: totalInputTokens, output: totalOutputTokens },
    turnCosts: turnCostHistory,
  };
}

async function showDiffPreview(call: ToolCall, cwd: string): Promise<void> {
  const { readFile } = await import('fs/promises');

  if (call.name === 'write_file') {
    const { path: filePath, content } = call.input as { path: string; content: string };
    let oldContent = '';
    try {
      oldContent = await readFile(resolveWorkspacePath(cwd, filePath), 'utf-8');
    } catch {}
    if (oldContent) {
      console.log('');
      console.log(chalk.dim(`--- Diff: ${filePath} ---`));
      console.log(createDiffView(oldContent, content));
    }
    return;
  }

  if (call.name === 'edit_file') {
    const { path: filePath, edits } = call.input as { path: string; edits: Array<{ old_str: string; new_str: string }> };
    let originalContent = '';
    try {
      originalContent = await readFile(resolveWorkspacePath(cwd, filePath), 'utf-8');
    } catch {
      return;
    }

    let newContent = originalContent;
    let skippedEdits = 0;
    for (const edit of edits) {
      const idx = newContent.indexOf(edit.old_str);
      if (idx !== -1) {
        newContent = newContent.slice(0, idx) + edit.new_str + newContent.slice(idx + edit.old_str.length);
      } else {
        skippedEdits++;
      }
    }
    if (skippedEdits > 0) {
      console.log(chalk.yellow(`  [preview] ${skippedEdits} edit(s) could not be previewed (old_str not found) — will error on execution.`));
    }

    if (newContent !== originalContent) {
      console.log('');
      console.log(chalk.dim(`--- Diff: ${filePath} ---`));
      console.log(createDiffView(originalContent, newContent));
    }
  }
}
