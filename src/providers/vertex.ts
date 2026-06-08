// Vertex AI provider for Anthropic models
// Uses direct REST API with VERTEX_AI_ACCESS_TOKEN env var
// Requires: GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_REGION (defaults to us-east5)
// Optional: VERTEX_AI_ACCESS_TOKEN for manual token

import type { ToolCall } from '../agent/tools.js';
import type { ChatMessage, StreamChunk } from './anthropic.js';

export interface VertexOptions {
  model: string;
  maxTokens: number;
  systemPrompt: string;
  tools: unknown[];
  project?: string;
  region?: string;
  accessToken?: string;
}

function getVertexEndpoint(project: string, region: string, model: string): string {
  // Map short model names to Vertex AI publisher model IDs
  // Vertex AI uses the full versioned model ID
  const modelId = mapToVertexModelId(model);
  return `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/publishers/anthropic/models/${modelId}:streamRawPredict`;
}

function mapToVertexModelId(model: string): string {
  // If it already looks like a full versioned Vertex model id, return as-is
  if (model.startsWith('claude-') && model.includes('@')) return model;
  // Map common shorthand names to Vertex versioned IDs
  const vertexModelMap: Record<string, string> = {
    'claude-opus-4-8':           'claude-opus-4-8@20260601',
    'claude-opus-4-7':           'claude-opus-4-7@20260401',
    'claude-opus-4-5':           'claude-opus-4-5@20251101',
    'claude-sonnet-4-6':         'claude-sonnet-4-6@20260101',
    'claude-sonnet-4-5':         'claude-sonnet-4-5@20251001',
    'claude-haiku-4-5-20251001': 'claude-haiku-4-5@20251001',
  };
  return vertexModelMap[model] ?? model;
}

export async function* streamVertex(
  messages: ChatMessage[],
  opts: VertexOptions
): AsyncGenerator<StreamChunk> {
  const project = opts.project ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
  const region = opts.region ?? process.env.GOOGLE_CLOUD_REGION ?? 'us-east5';
  const accessToken = opts.accessToken ?? process.env.VERTEX_AI_ACCESS_TOKEN;

  if (!project) {
    throw new Error('Vertex AI requires GOOGLE_CLOUD_PROJECT env var or project option');
  }
  if (!accessToken) {
    throw new Error('Vertex AI requires VERTEX_AI_ACCESS_TOKEN env var or accessToken option');
  }

  const endpoint = getVertexEndpoint(project, region, opts.model);

  // Build the request body in Anthropic's messages API format
  const body: Record<string, unknown> = {
    anthropic_version: 'vertex-2023-10-16',
    max_tokens: opts.maxTokens,
    system: opts.systemPrompt,
    tools: opts.tools,
    messages: messages,
    stream: true,
  };

  const resp = await fetch(endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Vertex AI API error ${resp.status}: ${errText}`);
  }

  if (!resp.body) {
    throw new Error('No response body from Vertex AI');
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  let currentToolId: string | null = null;
  let currentToolName: string | null = null;
  let currentToolInput = '';
  let inputTokens = 0;
  let outputTokens = 0;

  // Parse SSE stream from Vertex AI (same format as Anthropic's SSE)
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data || data === '[DONE]') continue;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }

      const eventType = event.type as string | undefined;

      if (eventType === 'content_block_start') {
        const block = event.content_block as Record<string, unknown> | undefined;
        if (block?.type === 'tool_use') {
          currentToolId = block.id as string;
          currentToolName = block.name as string;
          currentToolInput = '';
        }
      } else if (eventType === 'content_block_delta') {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta') {
          yield { type: 'text', text: delta.text as string };
        } else if (delta?.type === 'input_json_delta') {
          currentToolInput += delta.partial_json as string;
        }
      } else if (eventType === 'content_block_stop') {
        if (currentToolId && currentToolName) {
          try {
            const input = JSON.parse(currentToolInput || '{}') as Record<string, unknown>;
            yield {
              type: 'tool_call',
              toolCall: {
                id: currentToolId,
                name: currentToolName as ToolCall['name'],
                input,
              },
            };
          } catch {
            // Malformed tool input — skip
          }
          currentToolId = null;
          currentToolName = null;
          currentToolInput = '';
        }
      } else if (eventType === 'message_start') {
        const msg = event.message as Record<string, unknown> | undefined;
        const usage = msg?.usage as Record<string, unknown> | undefined;
        if (usage) {
          inputTokens = (usage.input_tokens as number) ?? 0;
        }
      } else if (eventType === 'message_delta') {
        const usage = event.usage as Record<string, unknown> | undefined;
        if (usage) {
          outputTokens = (usage.output_tokens as number) ?? 0;
        }
      } else if (eventType === 'message_stop') {
        yield { type: 'usage', usage: { inputTokens, outputTokens } };
        yield { type: 'done' };
        return;
      }
    }
  }

  // If stream ended without message_stop, emit usage and done
  yield { type: 'usage', usage: { inputTokens, outputTokens } };
  yield { type: 'done' };
}

// Vertex AI uses same pricing as Anthropic direct (pass-through)
const VERTEX_PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-8':           { input: 15,   output: 75   },
  'claude-opus-4-7':           { input: 15,   output: 75   },
  'claude-opus-4-5':           { input: 15,   output: 75   },
  'claude-sonnet-4-6':         { input: 3,    output: 15   },
  'claude-sonnet-4-5':         { input: 3,    output: 15   },
  'claude-haiku-4-5-20251001': { input: 0.25, output: 1.25 },
};

export function calculateVertexCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = VERTEX_PRICING[model] ?? { input: 3, output: 15 };
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}
