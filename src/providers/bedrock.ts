// AWS Bedrock provider for Claude models
// Uses the Bedrock Converse API streaming endpoint
// Requires: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION env vars
// SigV4 signing implemented manually to avoid AWS SDK dependency

import { createHmac, createHash } from 'crypto';
import type { ToolCall } from '../agent/tools.js';
import type { ChatMessage, StreamChunk, ContentBlock } from './anthropic.js';

export interface BedrockOptions {
  model: string;
  maxTokens: number;
  systemPrompt: string;
  tools: unknown[];
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

// ---- SigV4 signing helpers ----

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf-8').digest();
}

function sha256hex(data: string): string {
  return createHash('sha256').update(data, 'utf-8').digest('hex');
}

function getSignatureKey(secretKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  return kSigning;
}

function formatDate(d: Date): { dateStamp: string; amzDate: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateStamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const amzDate = `${dateStamp}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  return { dateStamp, amzDate };
}

interface SigV4Headers {
  Authorization: string;
  'x-amz-date': string;
  'x-amz-security-token'?: string;
  host: string;
}

function signRequest(opts: {
  method: string;
  host: string;
  path: string;
  body: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  now?: Date;
}): SigV4Headers {
  const now = opts.now ?? new Date();
  const { dateStamp, amzDate } = formatDate(now);
  const payloadHash = sha256hex(opts.body);

  const canonicalHeaders =
    `host:${opts.host}\n` +
    `x-amz-date:${amzDate}\n` +
    (opts.sessionToken ? `x-amz-security-token:${opts.sessionToken}\n` : '');

  const signedHeaders = opts.sessionToken
    ? 'host;x-amz-date;x-amz-security-token'
    : 'host;x-amz-date';

  const canonicalRequest = [
    opts.method,
    opts.path,
    '', // query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256hex(canonicalRequest),
  ].join('\n');

  const signingKey = getSignatureKey(opts.secretAccessKey, dateStamp, opts.region, opts.service);
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf-8').digest('hex');

  const authHeader =
    `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers: SigV4Headers = {
    Authorization: authHeader,
    'x-amz-date': amzDate,
    host: opts.host,
  };
  if (opts.sessionToken) {
    headers['x-amz-security-token'] = opts.sessionToken;
  }
  return headers;
}

// ---- Bedrock message format conversion ----

interface BedrockContentBlock {
  text?: string;
  toolUse?: { toolUseId: string; name: string; input: unknown };
  toolResult?: { toolUseId: string; content: Array<{ text: string }> };
}

interface BedrockMessage {
  role: 'user' | 'assistant';
  content: BedrockContentBlock[];
}

function toBedrockMessages(messages: ChatMessage[]): BedrockMessage[] {
  return messages.map((msg) => {
    if (typeof msg.content === 'string') {
      return { role: msg.role, content: [{ text: msg.content }] };
    }

    const blocks: BedrockContentBlock[] = [];
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === 'text' && block.text) {
        blocks.push({ text: block.text });
      } else if (block.type === 'tool_use') {
        blocks.push({
          toolUse: {
            toolUseId: block.id ?? '',
            name: block.name ?? '',
            input: block.input ?? {},
          },
        });
      } else if (block.type === 'tool_result') {
        blocks.push({
          toolResult: {
            toolUseId: block.tool_use_id ?? '',
            content: [{ text: block.content ?? '' }],
          },
        });
      }
    }
    return { role: msg.role, content: blocks };
  });
}

interface BedrockTool {
  toolSpec: {
    name: string;
    description?: string;
    inputSchema: { json: unknown };
  };
}

function toBedrockTools(tools: unknown[]): BedrockTool[] {
  return (tools as Array<{ name: string; description?: string; input_schema: unknown }>).map((t) => ({
    toolSpec: {
      name: t.name,
      description: t.description,
      inputSchema: { json: t.input_schema },
    },
  }));
}

// ---- Bedrock streaming parser (event-stream binary protocol) ----

/**
 * AWS event stream framing:
 *   [prelude: 4B total length][4B headers length][4B prelude CRC][headers][payload][4B message CRC]
 */
function parseEventStreamMessages(buffer: Buffer): Array<{ headers: Record<string, string>; payload: Buffer }> {
  const results: Array<{ headers: Record<string, string>; payload: Buffer }> = [];
  let offset = 0;

  while (offset + 12 <= buffer.length) {
    const totalLength = buffer.readUInt32BE(offset);
    if (offset + totalLength > buffer.length) break; // incomplete message

    const headersLength = buffer.readUInt32BE(offset + 4);
    const headersStart = offset + 12;
    const headersEnd = headersStart + headersLength;
    const payloadEnd = offset + totalLength - 4; // exclude trailing CRC

    // Parse headers
    const headers: Record<string, string> = {};
    let hi = headersStart;
    while (hi < headersEnd) {
      if (hi >= headersEnd) break;
      const nameLen = buffer.readUInt8(hi);
      hi += 1;
      if (hi + nameLen > headersEnd) break; // malformed
      const name = buffer.toString('utf-8', hi, hi + nameLen);
      hi += nameLen;
      if (hi >= headersEnd) break; // malformed
      const valueType = buffer.readUInt8(hi);
      hi += 1;
      // AWS event stream header value types:
      //   0=bool true, 1=bool false, 2=byte, 3=short, 4=int, 5=long, 6=bytes, 7=string, 8=timestamp, 9=uuid
      if (valueType === 7) {
        // string value: 2-byte length prefix
        if (hi + 2 > headersEnd) break; // malformed
        const valueLen = buffer.readUInt16BE(hi);
        hi += 2;
        if (hi + valueLen > headersEnd) break; // malformed
        const value = buffer.toString('utf-8', hi, hi + valueLen);
        hi += valueLen;
        headers[name] = value;
      } else if (valueType === 0 || valueType === 1) {
        // bool: no extra bytes
      } else if (valueType === 2) {
        hi += 1; // byte
      } else if (valueType === 3) {
        hi += 2; // short
      } else if (valueType === 4) {
        hi += 4; // int
      } else if (valueType === 5 || valueType === 8) {
        hi += 8; // long or timestamp
      } else if (valueType === 9) {
        hi += 16; // uuid
      } else if (valueType === 6) {
        // variable-length bytes: 2-byte length prefix (same as string)
        if (hi + 2 > headersEnd) break; // malformed
        const valueLen = buffer.readUInt16BE(hi);
        hi += 2 + valueLen;
      } else {
        // Unknown type — cannot safely skip; stop parsing headers for this message
        break;
      }
    }

    const payload = buffer.subarray(headersEnd, payloadEnd);
    results.push({ headers, payload });
    offset += totalLength;
  }

  return results;
}

export async function* streamBedrock(
  messages: ChatMessage[],
  opts: BedrockOptions
): AsyncGenerator<StreamChunk> {
  const region = opts.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
  const accessKeyId = opts.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID ?? '';
  const secretAccessKey = opts.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY ?? '';
  const sessionToken = opts.sessionToken ?? process.env.AWS_SESSION_TOKEN;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'Bedrock requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY env vars (or accessKeyId/secretAccessKey options)'
    );
  }

  const modelId = opts.model; // e.g. anthropic.claude-sonnet-4-5-20251001-v1:0
  const host = `bedrock-runtime.${region}.amazonaws.com`;
  const path = `/model/${encodeURIComponent(modelId)}/converse-stream`;
  const url = `https://${host}${path}`;

  const bedrockMessages = toBedrockMessages(messages);
  const bedrockTools = toBedrockTools(opts.tools);

  const requestBody: Record<string, unknown> = {
    system: [{ text: opts.systemPrompt }],
    messages: bedrockMessages,
    inferenceConfig: { maxTokens: opts.maxTokens },
  };
  if (bedrockTools.length > 0) {
    requestBody.toolConfig = { tools: bedrockTools };
  }

  const bodyStr = JSON.stringify(requestBody);

  const sigHeaders = signRequest({
    method: 'POST',
    host,
    path,
    body: bodyStr,
    region,
    service: 'bedrock',
    accessKeyId,
    secretAccessKey,
    sessionToken,
  });

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      ...sigHeaders,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.amazon.eventstream',
    },
    body: bodyStr,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Bedrock API error ${resp.status}: ${errText}`);
  }

  if (!resp.body) {
    throw new Error('No response body from Bedrock');
  }

  const reader = resp.body.getReader();
  let rawBuffer = Buffer.alloc(0);

  let currentToolId: string | null = null;
  let currentToolName: string | null = null;
  let currentToolInput = '';
  let inputTokens = 0;
  let outputTokens = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    rawBuffer = Buffer.concat([rawBuffer, Buffer.from(value)]);

    // Try to parse event-stream messages from the accumulated buffer
    while (rawBuffer.length >= 12) {
      const totalLength = rawBuffer.readUInt32BE(0);
      if (rawBuffer.length < totalLength) break;

      const [msg] = parseEventStreamMessages(rawBuffer.subarray(0, totalLength));
      rawBuffer = rawBuffer.subarray(totalLength);

      if (!msg) continue;

      const eventType = msg.headers[':event-type'];
      if (!eventType) continue;

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(msg.payload.toString('utf-8')) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (eventType === 'contentBlockStart') {
        const start = payload.start as Record<string, unknown> | undefined;
        const toolUse = start?.toolUse as Record<string, unknown> | undefined;
        if (toolUse) {
          currentToolId = toolUse.toolUseId as string;
          currentToolName = toolUse.name as string;
          currentToolInput = '';
        }
      } else if (eventType === 'contentBlockDelta') {
        const delta = payload.delta as Record<string, unknown> | undefined;
        if (delta?.text !== undefined) {
          yield { type: 'text', text: delta.text as string };
        } else if (delta?.toolUse !== undefined) {
          const tu = delta.toolUse as Record<string, unknown>;
          currentToolInput += (tu.input as string) ?? '';
        }
      } else if (eventType === 'contentBlockStop') {
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
            // Malformed tool input
          }
          currentToolId = null;
          currentToolName = null;
          currentToolInput = '';
        }
      } else if (eventType === 'messageStart') {
        // No token info at message start in Bedrock Converse
      } else if (eventType === 'messageStop') {
        yield { type: 'usage', usage: { inputTokens, outputTokens } };
        yield { type: 'done' };
        return;
      } else if (eventType === 'metadata') {
        const usage = payload.usage as Record<string, unknown> | undefined;
        if (usage) {
          inputTokens = (usage.inputTokens as number) ?? 0;
          outputTokens = (usage.outputTokens as number) ?? 0;
        }
      }
    }
  }

  // Fallback if stream ended without messageStop
  yield { type: 'usage', usage: { inputTokens, outputTokens } };
  yield { type: 'done' };
}

// Bedrock pricing mirrors Anthropic direct API rates (approximate)
const BEDROCK_PRICING: Record<string, { input: number; output: number }> = {
  'anthropic.claude-opus-4-5-20251101-v1:0':  { input: 15,   output: 75   },
  'anthropic.claude-sonnet-4-5-20251001-v1:0': { input: 3,    output: 15   },
  'anthropic.claude-haiku-4-5-20251001-v1:0':  { input: 0.25, output: 1.25 },
};

export function calculateBedrockCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = BEDROCK_PRICING[model] ?? { input: 3, output: 15 };
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}
