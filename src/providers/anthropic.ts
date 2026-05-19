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
}

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic();
  }
  return _client;
}

export async function* streamCompletion(
  messages: ChatMessage[],
  opts: ProviderOptions
): AsyncGenerator<StreamChunk> {
  const stream = getClient().messages.stream({
    model: opts.model,
    max_tokens: opts.maxTokens,
    system: opts.systemPrompt,
    tools: opts.tools as Anthropic.Tool[],
    messages: messages as Anthropic.MessageParam[],
  });

  let currentToolId: string | null = null;
  let currentToolName: string | null = null;
  let currentToolInput = '';
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const event of stream) {
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
