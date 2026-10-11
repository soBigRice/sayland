import type { ChatRequest, ScenePlan, ServiceHealth } from '../../../../packages/protocol/src/index.ts';

const session = crypto.randomUUID();
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, { ...init, headers: { 'X-Sayland-Session': session, ...init.headers } });
}
async function responseError(response: Response, fallback: string): Promise<Error> {
  const value: unknown = await response.json().catch(() => null);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const data = value as Record<string, unknown>;
    if (typeof data.message === 'string' && data.message.trim()) return new Error(data.message);
    if (typeof data.error === 'string' && data.error.trim()) return new Error(data.error);
    if (data.error && typeof data.error === 'object' && !Array.isArray(data.error)) {
      const message = (data.error as Record<string, unknown>).message;
      if (typeof message === 'string' && message.trim()) return new Error(message);
    }
  }
  return new Error(fallback);
}
export async function jsonRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) throw await responseError(response, '小岛伙伴暂时没有连接上，请再试一次。');
  return response.json() as Promise<T>;
}
export const readHealth = () => jsonRequest<ServiceHealth>('/api/health');
export interface ChatHandlers {
  onStatus(text: string): void;
  onCommentary?(message: { messageId: string; text: string }): void;
  onPlan(plan: ScenePlan): Promise<void>;
  onReply(text: string): void;
}
export async function chat(request: ChatRequest, signal: AbortSignal, handlers: ChatHandlers) {
  signal.throwIfAborted();
  const response = await apiFetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal });
  if (!response.ok) throw await responseError(response, '暂时没能连接上小岛伙伴。');
  if (!response.body) throw new Error('没有收到伙伴的回应。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', finished = false;
  async function dispatch(block: string) {
    signal.throwIfAborted();
    let event = 'message'; const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    const value = JSON.parse(data.join('\n')) as Record<string, unknown>;
    if (value.requestId !== undefined && value.requestId !== request.requestId) throw new Error('伙伴的回应对应了另一次搭建。');
    if (event === 'status') handlers.onStatus(String(value.message ?? value.text ?? '伙伴正在想办法…'));
    else if (event === 'commentary') {
      if (value.requestId !== request.requestId || typeof value.messageId !== 'string' || !value.messageId.trim() || value.messageId.length > 200
        || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 600) throw new Error('伙伴的中途对话格式不完整。');
      handlers.onCommentary?.({ messageId: value.messageId, text: value.text });
    }
    else if (event === 'plan') await handlers.onPlan(value as unknown as ScenePlan);
    else if (event === 'reply') handlers.onReply(String(value.reply ?? value.text ?? ''));
    else if (event === 'error') throw new Error(String(value.message ?? value.error ?? '这次没能搭好，原来的作品还在。'));
    else if (event === 'done') finished = true;
  }
  const abortRead = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', abortRead, { once: true });
  try {
    while (!finished) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n');
      let end: number;
      while (!finished && (end = buffer.indexOf('\n\n')) !== -1) { const block = buffer.slice(0, end); buffer = buffer.slice(end + 2); await dispatch(block); }
      if (done) break;
    }
    if (!finished && buffer.trim()) await dispatch(buffer);
    if (!finished && !signal.aborted) throw new Error('连接中断了，已搭好的部分会保留。');
  } finally { signal.removeEventListener('abort', abortRead); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

function turnState(value: unknown, requestId: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).requestId !== requestId) {
    throw new Error('伙伴的确认对应了另一次搭建，当前作品仍然保留着。');
  }
  return value as Record<string, unknown>;
}
function committedReceipt(value: unknown, requestId: string, revision: number, digest: string, batchId?: string): { reply: string } {
  const turn = turnState(value, requestId);
  if (turn.status !== 'committed' || turn.revision !== revision || turn.batchId !== batchId
    || (batchId ? turn.digest !== digest : turn.digest !== undefined && turn.digest !== digest)
    || typeof turn.reply !== 'string' || !turn.reply.trim()) {
    throw new Error('搭建的确认信息没有对上，当前作品仍然保留着。');
  }
  return { reply: turn.reply };
}
function responseWasLost(error: unknown): boolean {
  // A fetch/body transport failure or a truncated JSON body leaves the commit unknown.
  // Explicit HTTP rejections from jsonRequest are plain Errors and must not be retried.
  return error instanceof TypeError || error instanceof SyntaxError || (error instanceof DOMException && error.name === 'NetworkError');
}

export async function acknowledge(requestId: string, revision: number, digest: string, signal: AbortSignal, batchId?: string): Promise<{ reply: string }> {
  const path = `/api/turns/${encodeURIComponent(requestId)}`;
  const body = JSON.stringify({ revision, digest, ...(batchId ? { batchId } : {}) });
  // Retry only the receipt for the already applied transaction, never the scene or chat.
  // The caller's deadline covers every POST, status query, and response-body read.
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    try {
      const receipt = await jsonRequest<unknown>(`${path}/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal });
      signal.throwIfAborted();
      return committedReceipt(receipt, requestId, revision, digest, batchId);
    } catch (error) {
      signal.throwIfAborted();
      if (!responseWasLost(error)) throw error;
    }
    signal.throwIfAborted();
    const turn = turnState(await jsonRequest<unknown>(path, { method: 'GET', signal }), requestId);
    signal.throwIfAborted();
    // A committed batch remains committed while the same turn generates another
    // batch, fails or is cancelled. Only its exact receipt can recover a lost ACK.
    if (batchId && Array.isArray(turn.receipts)) {
      const receipt = turn.receipts.find(value => value && typeof value === 'object' && (value as Record<string, unknown>).batchId === batchId);
      if (receipt) return committedReceipt(receipt, requestId, revision, digest, batchId);
    }
    if (!batchId && turn.status === 'committed') return committedReceipt(turn, requestId, revision, digest);
    if (turn.status === 'cancelled') throw new Error('这次搭建已停止，不能继续确认。');
    if (turn.status === 'failed') throw new Error('这次搭建的确认已过期或失败，当前作品仍然保留着。');
    const pending = turn.plan && typeof turn.plan === 'object' ? turn.plan as Record<string, unknown> : undefined;
    if (turn.status !== 'awaiting_ack' || (batchId && pending?.batchId !== batchId) || attempt === 1) {
      throw new Error('搭建已保留，但确认信息暂时没有收齐。');
    }
  }
  throw new Error('搭建已保留，但确认信息暂时没有收齐。');
}
export async function cancelTurn(requestId: string) {
  await apiFetch(`/api/turns/${encodeURIComponent(requestId)}/cancel`, { method: 'POST' });
}
export async function transcribe(audio: Blob, signal: AbortSignal) {
  const data = await jsonRequest<{ text: string }>('/api/speech/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: audio, signal });
  return data.text;
}
export async function synthesize(text: string, signal: AbortSignal) {
  const response = await apiFetch('/api/speech/synthesize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal });
  if (!response.ok) throw await responseError(response, '朗读暂时不可用，可以继续打字或说话。');
  return response.blob();
}

/** Read-only, current-page session diagnostics. No background polling. */
export async function readTurnDiagnostics(requestId: string, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const value = await jsonRequest<unknown>(`/api/turns/${encodeURIComponent(requestId)}`, { signal });
  signal.throwIfAborted();
  return turnState(value, requestId);
}
