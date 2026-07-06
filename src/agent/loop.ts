import chalk from 'chalk';
import { createDiffView } from '../ui/diff.js';
import { resetToolLineTracking } from '../ui/renderer.js';
import { streamCompletion, calculateCost } from '../providers/anthropic.js';
import { streamOpenRouter, calculateOpenRouterCost } from '../providers/openrouter.js';
import { executeTool, applyEdits, TOOL_DEFINITIONS, resolveWorkspacePath, type ToolCall, type ToolResult } from './tools.js';
import { classifyRisk, requestApproval, SessionLogger } from '../warden/index.js';
import type { ChatMessage, ContentBlock } from '../providers/anthropic.js';
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
  /**
   * Persistent conversation history. When provided, the loop appends to it in
   * place so follow-up tasks in the same session share context.
   */
  history?: ChatMessage[];
  /** Paths/globs from TRIDENT.md "Do Not Touch" that writes must never modify. */
  protectedPaths?: string[];
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
  const messages: ChatMessage[] = opts.history ?? [];
  appendUserText(messages, initialTask);
  trimHistoryInPlace(messages);

  let turns = 0;
  const callCounts = new Map<string, number>();
  let loopBlocks = 0;
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
              maxTokens: 8192,
              systemPrompt: opts.systemPrompt,
              tools: TOOL_DEFINITIONS,
              apiKey: process.env.OPENROUTER_API_KEY || '',
            })
          : streamCompletion(messages, {
              model: opts.model,
              maxTokens: 8192,
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
      // Keep persistent history consistent: every tool_use needs a tool_result.
      if (pendingToolCalls.length > 0) {
        messages.push({
          role: 'user',
          content: pendingToolCalls.map((tc) => ({
            type: 'tool_result',
            tool_use_id: tc.id,
            content: 'Not executed: session budget reached.',
          })) as unknown as ChatMessage['content'],
        });
      }
      break;
    }

    const finalAnswerCall = pendingToolCalls.find((tc) => tc.name === 'final_answer');

    if (pendingToolCalls.length === 0) {
      // The model finished with a plain-text answer instead of final_answer.
      // That is still a natural completion, not a failure.
      if (assistantText.trim()) {
        finalSummary = assistantText.trim().slice(0, 1000);
      }
      finalAnswerFound = true;
      break;
    }

    const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];

    // Execute every non-final tool call first so that a final_answer issued in
    // the same turn as a write/edit does not silently drop those actions.
    const executableCalls = pendingToolCalls.filter((tc) => tc.name !== 'final_answer');

    for (const tc of executableCalls) {
      const call: ToolCall = { name: tc.name, input: tc.input };
      const risk = classifyRisk(call);

      // Loop detection: an identical call repeated many times means the agent
      // is stuck; short-circuit instead of burning budget on it.
      const signature = `${call.name}:${JSON.stringify(call.input)}`;
      const timesSeen = (callCounts.get(signature) || 0) + 1;
      callCounts.set(signature, timesSeen);
      if (timesSeen > 3) {
        loopBlocks++;
        const result: ToolResult = {
          success: false,
          output: '',
          error: 'Loop detection: this exact tool call was already made 3 times with the same input. Change approach or call final_answer.',
          duration_ms: 0,
        };
        opts.onToolEnd?.(call, result);
        toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: JSON.stringify(result) });
        await logger.log({ toolName: call.name, input: call.input, result, approved: false, riskLevel: risk });
        continue;
      }

      if (opts.onToolStart) {
        await opts.onToolStart(call);
      }

      let printedBetween = false;
      if (call.name === 'write_file' || call.name === 'edit_file') {
        printedBetween = await showDiffPreview(call, opts.cwd);
      }

      const willPrompt =
        opts.mode === 'lockdown' || (opts.mode === 'review' && risk !== 'read');
      if (printedBetween || willPrompt) {
        // Output appeared between tool-start and tool-end lines, so the
        // renderer must not rewind the cursor over it.
        resetToolLineTracking();
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

      const result = await executeTool(call, opts.cwd, opts.askUserFn, opts.protectedPaths);
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

    if (finalAnswerCall) {
      finalSummary = (finalAnswerCall.input.summary as string) || 'Task completed.';
      finalAnswerFound = true;
      toolResults.push({ type: 'tool_result', tool_use_id: finalAnswerCall.id, content: 'Acknowledged.' });
      messages.push({ role: 'user', content: toolResults as unknown as ChatMessage['content'] });
      break;
    }

    messages.push({ role: 'user', content: toolResults as unknown as ChatMessage['content'] });

    if (loopBlocks >= 6) {
      finalSummary = 'Stopped: the agent kept repeating the same tool calls without progress. Rephrase the task or narrow the scope, then retry.';
      break;
    }
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

/**
 * Append a new user task to the conversation. If the last message is already a
 * user message (e.g. trailing tool results from a max-turns stop), merge the
 * task in as a text block so message roles keep alternating.
 */
function appendUserText(messages: ChatMessage[], text: string): void {
  const last = messages[messages.length - 1];
  if (last && last.role === 'user') {
    if (typeof last.content === 'string') {
      last.content = [
        { type: 'text', text: last.content },
        { type: 'text', text },
      ];
    } else {
      (last.content as ContentBlock[]).push({ type: 'text', text });
    }
    return;
  }
  messages.push({ role: 'user', content: text });
}

const HISTORY_KEEP_RECENT_MESSAGES = 10;
const HISTORY_TOOL_RESULT_TRIM_AT = 2_000;
const HISTORY_TOOL_RESULT_KEEP = 500;

/**
 * Bound long-session context growth by truncating old tool_result payloads
 * (the bulkiest content) while leaving the recent turns untouched. The
 * message structure itself is never altered, so tool_use/tool_result pairing
 * stays valid for the providers.
 */
function trimHistoryInPlace(messages: ChatMessage[]): void {
  const cutoff = Math.max(0, messages.length - HISTORY_KEEP_RECENT_MESSAGES);
  for (let i = 0; i < cutoff; i++) {
    const msg = messages[i];
    if (msg.role !== 'user' || !Array.isArray(msg.content)) {
      continue;
    }
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > HISTORY_TOOL_RESULT_TRIM_AT) {
        block.content = `${block.content.slice(0, HISTORY_TOOL_RESULT_KEEP)}\n[...trimmed from session history to save context...]`;
      }
    }
  }
}

async function showDiffPreview(call: ToolCall, cwd: string): Promise<boolean> {
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
      return true;
    }
    return false;
  }

  if (call.name === 'edit_file') {
    const { path: filePath, edits } = call.input as { path: string; edits: Array<{ old_str: string; new_str: string }> };
    let originalContent = '';
    try {
      originalContent = await readFile(resolveWorkspacePath(cwd, filePath), 'utf-8');
    } catch {
      return false;
    }

    const { content: newContent } = applyEdits(originalContent, edits);

    if (newContent !== originalContent) {
      console.log('');
      console.log(chalk.dim(`--- Diff: ${filePath} ---`));
      console.log(createDiffView(originalContent, newContent));
      return true;
    }
  }

  return false;
}
