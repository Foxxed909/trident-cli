import chalk from 'chalk';
import { createDiffView } from '../ui/diff.js';
import { streamCompletion, calculateCost } from '../providers/anthropic.js';
import { streamOpenRouter, calculateOpenRouterCost } from '../providers/openrouter.js';
import { executeTool, TOOL_DEFINITIONS, resolveWorkspacePath, type ToolCall, type ToolResult } from './tools.js';
import { classifyRisk, requestApproval, SessionLogger } from '../warden/index.js';
import type { ChatMessage } from '../providers/anthropic.js';
import type { ApprovalMode } from '../warden/index.js';

export type ProviderName = 'anthropic' | 'openrouter';

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
  onText?: (text: string) => void;
  onToolStart?: (call: ToolCall) => void | Promise<void>;
  beforeToolExecute?: (call: ToolCall) => void | Promise<void>;
  onToolEnd?: (call: ToolCall, result: ToolResult) => void;
  onCostUpdate?: (totalCost: number, tokens: { input: number; output: number }) => void;
  askUserFn: (question: string) => Promise<string>;
}

export interface AgentResult {
  success: boolean;
  summary: string;
  turns: number;
  totalCost: number;
  totalTokens: { input: number; output: number };
}

export async function runAgentLoop(
  initialTask: string,
  opts: AgentOptions
): Promise<AgentResult> {
  const logger = new SessionLogger(opts.sessionId, opts.logSessions);
  const messages: ChatMessage[] = [{ role: 'user', content: initialTask }];

  let turns = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalSummary = 'Task completed.';
  let finalAnswerFound = false;
  let budgetExceeded = false;
  const isOpenRouter = opts.provider === 'openrouter';

  while (turns < opts.maxTurns) {
    turns++;

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
        const stream = isOpenRouter
          ? streamOpenRouter(messages, {
              model: opts.model,
              maxTokens: 8096,
              systemPrompt: opts.systemPrompt,
              tools: TOOL_DEFINITIONS,
              apiKey: process.env.OPENROUTER_API_KEY || '',
            })
          : streamCompletion(messages, {
              model: opts.model,
              maxTokens: 8096,
              systemPrompt: opts.systemPrompt,
              tools: TOOL_DEFINITIONS,
            });

        for await (const chunk of stream) {
          if (chunk.type === 'text' && chunk.text) {
            assistantText += chunk.text;
            opts.onText?.(chunk.text);
          } else if (chunk.type === 'tool_call' && chunk.toolCall) {
            pendingToolCalls.push(chunk.toolCall);
          } else if (chunk.type === 'usage' && chunk.usage) {
            turnInputTokens = chunk.usage.inputTokens;
            turnOutputTokens = chunk.usage.outputTokens;
          }
        }

        totalInputTokens += turnInputTokens;
        totalOutputTokens += turnOutputTokens;
        const cost = isOpenRouter
          ? calculateOpenRouterCost(opts.model, totalInputTokens, totalOutputTokens)
          : calculateCost(opts.model, totalInputTokens, totalOutputTokens);
        opts.onCostUpdate?.(cost, { input: totalInputTokens, output: totalOutputTokens });
        break;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const isTransient = /ECONNRESET|ETIMEDOUT|rate.?limit|overloaded|503|529/i.test(error.message);
        if (!isTransient || streamAttempt >= 2) {
          throw error;
        }
        streamAttempt++;
        console.log(chalk.yellow(`\n  retrying after API error (${error.message.slice(0, 60)}) ${streamAttempt}/2...`));
        await new Promise((r) => setTimeout(r, 1500 * streamAttempt));
      }
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

    const runningCost = isOpenRouter
      ? calculateOpenRouterCost(opts.model, totalInputTokens, totalOutputTokens)
      : calculateCost(opts.model, totalInputTokens, totalOutputTokens);
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

      const approved = await requestApproval(call, opts.mode, risk);

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

      const result = await executeTool(call, opts.cwd, opts.askUserFn);
      opts.onToolEnd?.(call, result);

      await logger.log({ toolName: call.name, input: call.input, result, approved: true, riskLevel: risk });

      const resultContent = result.success
        ? result.output
        : `ERROR: ${result.error}\n${result.output}`;

      toolResults.push({
        type: 'tool_result',
        tool_use_id: tc.id,
        content: resultContent || '(no output)',
      });
    }

    messages.push({ role: 'user', content: toolResults as unknown as ChatMessage['content'] });
  }

  const totalCost = isOpenRouter
    ? calculateOpenRouterCost(opts.model, totalInputTokens, totalOutputTokens)
    : calculateCost(opts.model, totalInputTokens, totalOutputTokens);

  if (!finalAnswerFound && !budgetExceeded && turns >= opts.maxTurns) {
    finalSummary = `Stopped after ${turns} turns (max turn limit reached). The task may be incomplete - resume by re-running with a continuation prompt.`;
  }

  return {
    success: finalAnswerFound,
    summary: finalSummary,
    turns,
    totalCost,
    totalTokens: { input: totalInputTokens, output: totalOutputTokens },
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
    for (const edit of edits) {
      const idx = newContent.indexOf(edit.old_str);
      if (idx !== -1) {
        newContent = newContent.slice(0, idx) + edit.new_str + newContent.slice(idx + edit.old_str.length);
      }
    }

    if (newContent !== originalContent) {
      console.log('');
      console.log(chalk.dim(`--- Diff: ${filePath} ---`));
      console.log(createDiffView(originalContent, newContent));
    }
  }
}
