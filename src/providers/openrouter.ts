// OpenRouter provider — compatible with OpenAI chat completions API
// Supports hundreds of models: GPT-4o, Gemini, Llama, Mistral, DeepSeek, etc.

import type { ToolCall } from '../agent/tools.js';
import type { ChatMessage, StreamChunk } from './anthropic.js';

export const OPENROUTER_MODELS = {
  // Anthropic via OpenRouter
  'anthropic/claude-opus-4-5': { input: 15, output: 75 },
  'anthropic/claude-sonnet-4-5': { input: 3, output: 15 },
  // OpenAI
  'openai/gpt-4o': { input: 5, output: 15 },
  'openai/gpt-4.1': { input: 2, output: 8 },
  'openai/o3-mini': { input: 1.1, output: 4.4 },
  'openai/gpt-oss-120b:free': { input: 0, output: 0 },
  'openai/gpt-oss-20b:free': { input: 0, output: 0 },
  // Nvidia
  'nvidia/nemotron-3-super-120b-a12b:free': { input: 0, output: 0 },
  // Google
  'google/gemini-2.5-pro-preview': { input: 1.25, output: 10 },
  'google/gemini-2.0-flash-001': { input: 0.1, output: 0.4 },
  // Meta
  'meta-llama/llama-4-maverick': { input: 0.2, output: 0.6 },
  'meta-llama/llama-4-scout': { input: 0.1, output: 0.3 },
  // DeepSeek
  'deepseek/deepseek-r1': { input: 0.55, output: 2.19 },
  'deepseek/deepseek-chat-v3-0324': { input: 0.27, output: 1.1 },
  // Mistral
  'mistralai/mistral-large': { input: 2, output: 6 },
  // Qwen
  'qwen/qwen3-235b-a22b': { input: 0.13, output: 0.6 },
} as const;

export type OpenRouterModel = keyof typeof OPENROUTER_MODELS;

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// Convert Anthropic-style tool definitions to OpenAI function-calling format
function toOpenAITools(tools: unknown[]): unknown[] {
  return (tools as Array<{ name: string; description: string; input_schema: unknown }>).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

// Convert our internal message format to OpenAI format
function toOpenAIMessages(
  messages: ChatMessage[],
  systemPrompt: string
): unknown[] {
  const result: unknown[] = [{ role: 'system', content: systemPrompt }];

  for (const msg of messages) {
    if (msg.role === 'user') {
      // Could be tool results array or plain string
      if (Array.isArray(msg.content)) {
        // Tool results
        for (const block of msg.content as Array<{ type: string; tool_use_id?: string; content?: string }>) {
          if (block.type === 'tool_result') {
            result.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: block.content || '',
            });
          } else {
            result.push({ role: 'user', content: block.content || '' });
          }
        }
      } else {
        result.push({ role: 'user', content: msg.content });
      }
    } else if (msg.role === 'assistant') {
      if (Array.isArray(msg.content)) {
        const textBlocks = (msg.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>)
          .filter((b) => b.type === 'text')
          .map((b) => b.text || '')
          .join('');
        const toolBlocks = (msg.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>)
          .filter((b) => b.type === 'tool_use');

        const assistantMsg: Record<string, unknown> = { role: 'assistant' };
        if (textBlocks) assistantMsg.content = textBlocks;
        if (toolBlocks.length > 0) {
          assistantMsg.tool_calls = toolBlocks.map((b) => ({
            id: b.id,
            type: 'function',
            function: {
              name: b.name,
              arguments: JSON.stringify(b.input),
            },
          }));
        }
        result.push(assistantMsg);
      } else {
        result.push({ role: 'assistant', content: msg.content });
      }
    }
  }

  return result;
}

export interface OpenRouterOptions {
  model: string;
  maxTokens: number;
  systemPrompt: string;
  tools: unknown[];
  apiKey: string;
  siteUrl?: string;
  siteName?: string;
}

export async function* streamOpenRouter(
  messages: ChatMessage[],
  opts: OpenRouterOptions
): AsyncGenerator<StreamChunk> {
  const openAIMessages = toOpenAIMessages(messages, opts.systemPrompt);
  const openAITools = toOpenAITools(opts.tools);

  const body = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    messages: openAIMessages,
    tools: openAITools,
    tool_choice: 'auto',
    stream: true,
  };

  const resp = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': opts.siteUrl || 'https://github.com/trident-cli',
      'X-Title': opts.siteName || 'TRIDENT CLI',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenRouter API error ${resp.status}: ${err}`);
  }

  if (!resp.body) throw new Error('No response body from OpenRouter');

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Track streaming tool calls (may come in fragments)
  const toolCallAccumulators: Record<number, {
    id: string;
    name: string;
    arguments: string;
  }> = {};

  let receivedDone = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') {
        receivedDone = true;
        // Flush any accumulated tool calls
        for (const tc of Object.values(toolCallAccumulators)) {
          try {
            const input = JSON.parse(tc.arguments || '{}');
            yield {
              type: 'tool_call',
              toolCall: { id: tc.id, name: tc.name as ToolCall['name'], input },
            };
          } catch {
            // Malformed tool args
          }
        }
        yield { type: 'done' };
        return;
      }

      try {
        const chunk = JSON.parse(data);
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        // Text content
        if (delta.content) {
          yield { type: 'text', text: delta.content };
        }

        // Tool calls (streamed in fragments)
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallAccumulators[idx]) {
              toolCallAccumulators[idx] = { id: '', name: '', arguments: '' };
            }
            if (tc.id) toolCallAccumulators[idx].id = tc.id;
            if (tc.function?.name) toolCallAccumulators[idx].name = tc.function.name;
            if (tc.function?.arguments) toolCallAccumulators[idx].arguments += tc.function.arguments;
          }
        }

        // Usage stats
        if (chunk.usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: chunk.usage.prompt_tokens || 0,
              outputTokens: chunk.usage.completion_tokens || 0,
            },
          };
        }
      } catch {
        // Skip malformed SSE chunks
      }
    }
  }

  // Stream ended without a [DONE] line — flush any buffered tool calls and signal an error
  if (!receivedDone) {
    for (const tc of Object.values(toolCallAccumulators)) {
      try {
        const input = JSON.parse(tc.arguments || '{}');
        yield {
          type: 'tool_call',
          toolCall: { id: tc.id, name: tc.name as ToolCall['name'], input },
        };
      } catch {
        // Malformed tool args
      }
    }
    yield { type: 'text', text: '\n[OpenRouter stream ended unexpectedly without [DONE]]' };
    yield { type: 'done' };
  }
}

export function calculateOpenRouterCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = OPENROUTER_MODELS[model as OpenRouterModel] || { input: 1, output: 3 };
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

export function listOpenRouterModels(): string {
  const lines: string[] = ['\nAvailable OpenRouter models:\n'];
  const groups: Record<string, string[]> = {};

  for (const model of Object.keys(OPENROUTER_MODELS)) {
    const provider = model.split('/')[0];
    if (!groups[provider]) groups[provider] = [];
    groups[provider].push(model);
  }

  for (const [provider, models] of Object.entries(groups)) {
    lines.push(`  ${provider.toUpperCase()}`);
    for (const m of models) {
      const p = OPENROUTER_MODELS[m as OpenRouterModel];
      lines.push(`    ${m.padEnd(45)} $${p.input}/$${p.output} per M tokens`);
    }
  }

  return lines.join('\n');
}
