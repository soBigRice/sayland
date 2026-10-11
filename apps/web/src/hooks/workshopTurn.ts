import { VoxelEngine, type EngineSerialized } from '../../../../packages/scene/src/index.ts';
import { snapshotDigest, type ChatRequest, type ScenePlan } from '../../../../packages/protocol/src/index.ts';
import type { ChatMessage } from '../components/SceneShell.tsx';
import type { DebugTurn } from '../components/DebugPanel.tsx';
import { acknowledge, chat } from '../lib/api.ts';

const messageOf = (error: unknown) => error instanceof Error ? error.message : '这次没有完成，请再试一下。';
const interruptedReply = '上一次搭建中断了，已经搭好的部分保留着。';
const MAX_PROGRESS_MESSAGES = 88;

/** Drop complete older turns rather than orphaning the current user/error pair. */
export function boundedChatMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  let start = 0;
  while (messages.length - start > 100) {
    const nextUser = messages.findIndex((message, index) => index > start && message.role === 'user');
    if (nextUser < 0) break;
    start = nextUser;
  }
  return messages.slice(start);
}
export function conversationContext(messages: readonly ChatMessage[]): ChatRequest['messages'] {
  return messages.filter(message => message.id !== 'welcome' && message.kind !== 'progress' && !message.status)
    .slice(-10).map(message => ({ role: message.role, content: message.text.slice(0, 3000) }));
}
export function appendTurnProgress(messages: readonly ChatMessage[], answerId: string, message: { id: string; text: string }): ChatMessage[] {
  const index = messages.findIndex(item => item.id === answerId);
  if (index < 0 || messages.some(item => item.id === message.id)) return [...messages];
  let start = index;
  while (start > 0 && messages[start].role !== 'user') start--;
  if (messages.slice(start, index).filter(item => item.kind === 'progress').length >= MAX_PROGRESS_MESSAGES) return [...messages];
  return boundedChatMessages([...messages.slice(0, index), { ...message, role: 'assistant', kind: 'progress' }, ...messages.slice(index)]);
}

function precedingUser(messages: readonly ChatMessage[], index: number): ChatMessage | undefined {
  for (let previous = index - 1; previous >= 0; previous--) if (messages[previous].role === 'user') return messages[previous];
}

/** Recover the exact failed turn from persisted messages, never from a page-lifetime ref. */
export function retryPromptForMessage(messages: readonly ChatMessage[], messageId: string): string | null {
  const index = messages.findIndex(message => message.id === messageId), message = messages[index];
  if (!message || message.role !== 'assistant' || message.status !== 'error' || message.retryable !== true) return null;
  const user = precedingUser(messages, index);
  if (!user || message.id !== `${user.id}-answer`) return null;
  const prompt = user.text.trim();
  return prompt && prompt.length <= 1500 ? prompt : null;
}

export interface AppliedTurnEvidence { ids: ReadonlySet<string>; complete: boolean }
/** Use the existing history group, never a batch-ID naming convention, to recover a turn. */
export function appliedTurnEvidence(saved: EngineSerialized): AppliedTurnEvidence {
  const ids = new Set<string>(); let complete = saved.requests.length < 64;
  for (const [id, fingerprint] of saved.requests) {
    ids.add(id);
    try {
      const value: unknown = JSON.parse(fingerprint);
      if (!value || typeof value !== 'object' || Array.isArray(value)) { complete = false; continue; }
      const group = (value as Record<string, unknown>).historyGroup;
      if (typeof group === 'string') ids.add(group);
      else if (group !== undefined) complete = false;
    } catch { complete = false; }
  }
  for (const entry of [...saved.past, ...saved.future]) if (entry.group) ids.add(entry.group);
  return { ids, complete };
}

export function restoreChatMessages(messages: readonly ChatMessage[], evidence: ReadonlySet<string> | AppliedTurnEvidence): ChatMessage[] {
  const { ids: appliedRequestIds, complete } = 'ids' in evidence ? evidence : { ids: evidence, complete: evidence.size < 64 };
  return messages.map((message, index) => {
    if (message.kind === 'progress') return { ...message, status: undefined, retryable: false };
    if (message.status === 'pending') return { ...message, status: 'error', text: interruptedReply, retryable: false };
    if (message.status !== 'error') return message;
    const user = precedingUser(messages, index);
    // The core retains at most 64 committed request IDs. A full cache may have evicted this turn;
    // absence then cannot prove it was never applied, so leave the original text for manual editing.
    const retryable = complete && Boolean(user && message.id === `${user.id}-answer`
      && user.text.trim() && user.text.trim().length <= 1500 && !appliedRequestIds.has(user.id));
    return { ...message, retryable };
  });
}

interface TurnCallbacks {
  isCurrent(): boolean;
  onStatus(text: string): void;
  onProgress?(message: { id: string; text: string }): void;
  onPlan(plan: ScenePlan): void;
  onCommit(): void;
  onSceneComplete?(): void;
  onAnswer(text: string, status: 'pending' | 'error' | undefined, retryable: boolean): void;
  onTurn(patch: Partial<DebugTurn>): void;
  onError(text: string): void;
}
interface TurnServices { chat: typeof chat; acknowledge: typeof acknowledge }
/** The hook owns UI/persistence; this bounded turn owns batch commits and receipt/final-reply ordering. */
export async function runWorkshopTurn(input: ChatRequest, engine: VoxelEngine, signal: AbortSignal, callbacks: TurnCallbacks,
  services: TurnServices = { chat, acknowledge }): Promise<{ completed: boolean; reply: string; appliedBatches: number }> {
  let reply = '', legacyReply = '', appliedBatches = 0, acknowledgedBatches = 0, settled = false, stopped = false;
  const applied = new Map<string, { revision: number; digest: string; acknowledged: boolean }>();
  const progressIds = new Set<string>();
  const active = () => !settled && !signal.aborted && callbacks.isCurrent();
  const updateTurn = (status: string) => callbacks.onTurn({ status, appliedBatches, acknowledgedBatches });
  const answer = (text: string, status?: 'pending' | 'error') => callbacks.onAnswer(text, status, status === 'error' && appliedBatches === 0);
  const result = (completed = false) => ({ completed, reply: completed ? reply : '', appliedBatches });
  const progress = (kind: 'commentary' | 'receipt', id: string, text: string) => {
    const messageId = `${input.requestId}-${kind}-${id}`;
    if (!active() || !text.trim() || progressIds.has(messageId) || progressIds.size >= MAX_PROGRESS_MESSAGES) return;
    progressIds.add(messageId); callbacks.onProgress?.({ id: messageId, text });
  };
  const onAbort = () => {
    if (settled || stopped || !callbacks.isCurrent()) return;
    stopped = true;
    const timedOut = signal.reason instanceof Error && signal.reason.name === 'TimeoutError';
    updateTurn(appliedBatches ? (timedOut ? 'partial-timeout' : 'partial-cancelled') : timedOut ? 'timeout' : 'cancelled');
    answer(`${timedOut ? '这次搭建达到时间上限了。' : '已停下来。'}${appliedBatches ? '搭好的部分保留着，可以一次撤销这轮搭建。' : '小岛没有改变。'}`, timedOut ? 'error' : undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    await services.chat(input, signal, {
      onStatus: value => { if (active()) { callbacks.onStatus(value); answer(value, 'pending'); } },
      onCommentary: value => progress('commentary', value.messageId, value.text),
      onPlan: async plan => {
        if (!active()) return;
        if (plan.requestId !== input.requestId) throw new Error('伙伴的回复对应了另一个请求，请再试一次。');
        if (plan.batchId !== undefined && (typeof plan.batchId !== 'string' || !plan.batchId.trim() || plan.batchId.length > 160)) {
          throw new Error('这批搭建的编号无效，未执行新的方块。');
        }
        callbacks.onPlan(plan);
        const executionId = plan.batchId ?? input.requestId;
        const commit = engine.executeBatch(plan.batch, executionId, input.requestId);
        if (!commit.replayed) { appliedBatches++; callbacks.onCommit(); }
        updateTurn('applying');
        let local = applied.get(executionId);
        if (!local) {
          local = { revision: commit.snapshot.revision, digest: await snapshotDigest(commit.snapshot), acknowledged: false };
          applied.set(executionId, local);
        }
        if (local.acknowledged) return;
        // A local commit still needs its receipt if playback was just cancelled.
        // This short independent deadline cannot keep a cancelled turn building again.
        const receiptController = new AbortController();
        const timer = setTimeout(() => receiptController.abort(new DOMException('批次确认超时', 'TimeoutError')), 12_000);
        try {
          const receipt = await services.acknowledge(input.requestId, local.revision, local.digest, receiptController.signal, plan.batchId);
          local.acknowledged = true; acknowledgedBatches++;
          if (!active()) return;
          progress('receipt', executionId, receipt.reply);
          if (plan.batchId) {
            updateTurn('building');
            answer(`已完成第${acknowledgedBatches}批，伙伴继续搭建中…`, 'pending');
          } else {
            legacyReply = receipt.reply; reply = legacyReply;
            updateTurn('committed'); answer('这批已经搭好，正在等待伙伴完成回应…', 'pending');
          }
        } finally { clearTimeout(timer); }
      },
      onReply: value => { if (active()) reply = value || legacyReply; },
    });
    if (!active()) return result();
    if (!reply.trim()) throw new Error('这次没有收到完整的回应，作品仍然保留着。');
    updateTurn(legacyReply ? 'committed' : 'replied'); answer(reply);
    if (appliedBatches > 0) callbacks.onSceneComplete?.();
    return result(true);
  } catch (error) {
    if (signal.aborted) { onAbort(); return result(); }
    if (!active()) return result();
    updateTurn(appliedBatches ? acknowledgedBatches === appliedBatches ? 'partial-failed' : 'applied-unconfirmed' : 'failed');
    const text = `${messageOf(error)}${appliedBatches ? ' 已搭好的部分保留着，可以一次撤销这轮搭建。' : ''}`;
    answer(text, 'error'); callbacks.onError(text);
    return result();
  } finally { settled = true; signal.removeEventListener('abort', onAbort); }
}
