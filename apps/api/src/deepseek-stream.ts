import { z } from 'zod';
import { ApiError, throwIfAborted } from './errors.ts';

export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type ModelContent = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail: 'original' } };
export type ModelMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | ModelContent[] | null;
  reasoning_content?: string; tool_calls?: ToolCall[]; tool_call_id?: string };
export type ModelPhase = 'thinking' | 'answering' | 'tool-input';
export const MODEL_THINKING_MODE = 'enabled' as const;
export const MODEL_REASONING_EFFORT = 'high' as const;
export const DEFAULT_OUTPUT_TOKENS = 32768;
export const RECOVERY_OUTPUT_TOKENS = 65536;
// SSE repeats its envelope per token. Bound decoded output separately from transport
// overhead, and bound a single unfinished frame so a missing delimiter cannot grow memory.
const MAX_CONTENT_BYTES = 4 * 1024 * 1024;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_TRANSPORT_BYTES = 64 * 1024 * 1024;
export class CompletionBudgetError extends Error {
  constructor(readonly kind: 'tokens' | 'content' | 'frame' | 'transport', readonly limit: number | null, readonly observed?: number) {
    super('本批响应超过资源预算，未执行不完整数据。');
  }
}
const toolSchema = z.object({ id: z.string().min(1).max(200), type: z.literal('function'),
  function: z.object({ name: z.string().min(1).max(100), arguments: z.string() }) });
const messageSchema = z.object({ content: z.string().nullish(), reasoning_content: z.string().nullish(), tool_calls: z.array(toolSchema).max(64).nullish() });
const completeSchema = z.object({ choices: z.array(z.object({ message: messageSchema, finish_reason: z.string().nullish() })).min(1) });
const chunkSchema = z.object({ choices: z.array(z.object({
  delta: z.object({ content: z.string().nullish(), reasoning_content: z.string().nullish(),
    tool_calls: z.array(z.object({ index: z.number().int().min(0).max(63), id: z.string().optional(), type: z.literal('function').optional(),
      function: z.object({ name: z.string().optional(), arguments: z.string().optional() }).optional() })).optional() }),
  finish_reason: z.string().nullish(),
})) });
function invalid(): ApiError { return new ApiError('INVALID_PLAN', 502, '伙伴的搭建步骤没有传完整，本批没有提交。'); }
function validate(message: z.infer<typeof messageSchema>, finish: string | null | undefined, outputTokens: number | null): ModelMessage {
  if (finish === 'length') throw new CompletionBudgetError('tokens', outputTokens);
  if (!finish || !['stop', 'tool_calls'].includes(finish)) throw invalid();
  const calls = message.tool_calls ?? [];
  if (new Set(calls.map(call => call.id)).size !== calls.length) throw invalid();
  return { role: 'assistant', content: message.content || null, reasoning_content: message.reasoning_content ?? '', ...(calls.length ? { tool_calls: calls } : {}) };
}

/** Thinking is retained only in this server-side history; only phase metadata leaves this boundary. */
export async function completeModel(fetcher: typeof fetch, url: string, apiKey: string, body: Record<string, unknown>, signal: AbortSignal,
  onPhase?: (phase: ModelPhase) => void): Promise<ModelMessage> {
  try {
    throwIfAborted(signal);
    const response = await fetcher(url, { method: 'POST', signal, redirect: 'error', headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true }, thinking: { type: MODEL_THINKING_MODE }, reasoning_effort: MODEL_REASONING_EFFORT }) });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429) throw new ApiError('PROVIDER_BUSY', 503, '伙伴现在有点忙，请稍后再试。');
      if ([401, 403].includes(response.status)) throw new ApiError('PROVIDER_ACCESS', 503, '伙伴的连接需要检查，请先用方块工具继续玩。');
      throw new ApiError('PROVIDER_ERROR', 502, '伙伴暂时没有连上，请再试一次。');
    }
    if (!response.body) throw invalid();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0, contentBytes = 0, buffer = '', content = '', reasoning = '', finish = '', ended = false;
    const outputTokens = typeof body.max_tokens === 'number' ? body.max_tokens : null;
    const calls = new Map<number, { id: string; name: string; args: string }>();
    const json = response.headers.get('content-type')?.includes('application/json');
    const accountContent = (value: string | null | undefined) => {
      contentBytes += Buffer.byteLength(value ?? '', 'utf8');
      if (contentBytes > MAX_CONTENT_BYTES) throw new CompletionBudgetError('content', MAX_CONTENT_BYTES, contentBytes);
    };
    const checkFrame = (value: string) => {
      const size = Buffer.byteLength(value, 'utf8');
      if (size > MAX_FRAME_BYTES) throw new CompletionBudgetError('frame', MAX_FRAME_BYTES, size);
    };
    const consume = (event: string) => {
      checkFrame(event);
      const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) return;
      if (data === '[DONE]') { ended = true; return; }
      const parsed = chunkSchema.safeParse(JSON.parse(data));
      if (!parsed.success) throw invalid();
      const choice = parsed.data.choices[0];
      if (!choice) return;
      accountContent(choice.delta.reasoning_content); accountContent(choice.delta.content);
      if (choice.delta.reasoning_content) { reasoning += choice.delta.reasoning_content; onPhase?.('thinking'); }
      if (choice.delta.content) { content += choice.delta.content; onPhase?.('answering'); }
      for (const patch of choice.delta.tool_calls ?? []) {
        accountContent(patch.function?.name); accountContent(patch.function?.arguments);
        const call = calls.get(patch.index) ?? { id: '', name: '', args: '' };
        if (patch.id) call.id = patch.id;
        call.name += patch.function?.name ?? '';
        call.args += patch.function?.arguments ?? '';
        calls.set(patch.index, call); onPhase?.('tool-input');
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    };
    try {
      while (!ended) {
        throwIfAborted(signal);
        const next = await reader.read();
        if (next.done) { buffer += decoder.decode(); break; }
        bytes += next.value.byteLength;
        if (bytes > MAX_TRANSPORT_BYTES) throw new CompletionBudgetError('transport', MAX_TRANSPORT_BYTES, bytes);
        buffer += decoder.decode(next.value, { stream: true });
        if (json) { checkFrame(buffer); continue; }
        // Normalize CRLF after decoding; a CR/LF can straddle a transport chunk.
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2); consume(event);
          if (ended) break;
        }
        if (!ended) checkFrame(buffer);
      }
      throwIfAborted(signal);
      // Some OpenAI-compatible endpoints return a complete JSON message despite stream=true.
      if (json) {
        const parsed = completeSchema.safeParse(JSON.parse(buffer));
        if (!parsed.success) throw invalid();
        const { message, finish_reason } = parsed.data.choices[0];
        accountContent(message.reasoning_content); accountContent(message.content);
        for (const call of message.tool_calls ?? []) { accountContent(call.function.name); accountContent(call.function.arguments); }
        return validate(message, finish_reason, outputTokens);
      }
      if (!ended || !finish) throw invalid();
      const tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: call.args } }));
      const parsed = messageSchema.safeParse({ content, reasoning_content: reasoning, tool_calls });
      if (!parsed.success) throw invalid();
      return validate(parsed.data, finish, outputTokens);
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof ApiError || error instanceof CompletionBudgetError) throw error;
    throw new ApiError('PROVIDER_UNAVAILABLE', 502, '暂时没连上伙伴，已提交的部分仍保留在作品中。');
  }
}
