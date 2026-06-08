import Anthropic from '@anthropic-ai/sdk';
import type { ToolCall } from '../agent/tools.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  text?: string;
  cache_control?: { type: 'ephemeral' };
}

export interface StreamChunk {
  type: 'text' | 'tool_call' | 'done' | 'usage';
  text?: string;
  toolCall?: ToolCall & { id: string };
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ProviderOptions {
  model: string;
  maxTokens: number;
  systemPrompt: string;
  tools: unknown[];
  cacheEnabled?: boolean;
  thinking?: boolean;
  thinkingBudget?: number;
  signal?: AbortSignal;
}

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic();
  }
  return _client;
}

/**
 * Find the index of the last human (user) message that is NOT a tool result array.
 * Tool result messages are arrays of {type: 'tool_result', ...} blocks.
 */
function findLastHumanMessageIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    // Skip tool result arrays
    if (Array.isArray(msg.content)) {
      const isToolResults = (msg.content as ContentBlock[]).every(
        (b) => b.type === 'tool_result'
      );
      if (isToolResults) continue;
    }
    return i;
  }
  return -1;
}

/** Models that support the prompt-caching beta. Only these should get cache_control headers. */
const CACHE_SUPPORTED_MODEL_PREFIXES = ['claude-'];

function modelSupportsCaching(model: string): boolean {
  return CACHE_SUPPORTED_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
}

export async function* streamCompletion(
  messages: ChatMessage[],
  opts: ProviderOptions
): AsyncGenerator<StreamChunk> {
  // Only enable caching for known Claude models — custom or third-party model names
  // would cause an API error if the prompt-caching beta header is sent.
  const useCache = opts.cacheEnabled !== false && modelSupportsCaching(opts.model);

  // Build params
  const params: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    tools: opts.tools as Anthropic.Tool[],
  };

  if (useCache) {
    // System prompt as content block array with cache_control
    params.system = [
      { type: 'text', text: opts.systemPrompt, cache_control: { type: 'ephemeral' } },
    ];

    // Mark the last human message with cache_control
    const lastHumanIdx = findLastHumanMessageIndex(messages);
    const processedMessages = messages.map((msg, idx) => {
      if (idx !== lastHumanIdx) return msg;
      // Convert string content to a content block with cache_control
      if (typeof msg.content === 'string') {
        return {
          ...msg,
          content: [
            { type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } },
          ],
        };
      }
      // Array content — mark the last block with cache_control
      if (Array.isArray(msg.content) && msg.content.length > 0) {
        const blocks = [...(msg.content as ContentBlock[])];
        blocks[blocks.length - 1] = {
          ...blocks[blocks.length - 1],
          cache_control: { type: 'ephemeral' },
        };
        return { ...msg, content: blocks };
      }
      return msg;
    });

    params.messages = processedMessages as Anthropic.MessageParam[];
    params.betas = ['prompt-caching-2024-07-31'];
  } else {
    params.system = opts.systemPrompt;
    params.messages = messages as Anthropic.MessageParam[];
  }

  // Extended thinking
  if (opts.thinking) {
    params.thinking = { type: 'enabled', budget_tokens: opts.thinkingBudget ?? 8000 };
    params.betas = [...((params.betas as string[] | undefined) ?? []), 'interleaved-thinking-2025-05-14'];
  }

  const stream = getClient().messages.stream(params as unknown as Anthropic.MessageStreamParams);

  let currentToolId: string | null = null;
  let currentToolName: string | null = null;
  let currentToolInput = '';
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const event of stream) {
    if (opts.signal?.aborted) {
      stream.abort();
      return;
    }
    if (event.type === 'content_block_start') {
      if (event.content_block.type === 'tool_use') {
        currentToolId = event.content_block.id;
        currentToolName = event.content_block.name;
        currentToolInput = '';
      }
    } else if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text };
      } else if (event.delta.type === 'input_json_delta') {
        currentToolInput += event.delta.partial_json;
      }
    } else if (event.type === 'content_block_stop') {
      if (currentToolId && currentToolName) {
        try {
          const input = JSON.parse(currentToolInput || '{}');
          yield {
            type: 'tool_call',
            toolCall: {
              id: currentToolId,
              name: currentToolName as ToolCall['name'],
              input,
            },
          };
        } catch {
          // Malformed tool input
        }
        currentToolId = null;
        currentToolName = null;
        currentToolInput = '';
      }
    } else if (event.type === 'message_start' && event.message?.usage) {
      inputTokens = event.message.usage.input_tokens;
    } else if (event.type === 'message_delta' && event.usage) {
      outputTokens = event.usage.output_tokens;
    } else if (event.type === 'message_stop') {
      yield { type: 'usage', usage: { inputTokens, outputTokens } };
      yield { type: 'done' };
    }
  }
}

const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-7':            { input: 15,   output: 75   },
  'claude-opus-4-5':            { input: 15,   output: 75   },
  'claude-sonnet-4-6':          { input: 3,    output: 15   },
  'claude-sonnet-4-5':          { input: 3,    output: 15   },
  'claude-haiku-4-5-20251001':  { input: 0.25, output: 1.25 },
};

export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING[model] || { input: 0, output: 0 };
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}
