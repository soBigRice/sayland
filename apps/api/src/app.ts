import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  batchSchema, chatRequestSchema, snapshotDigest, canonicalSnapshotJson, MAX_SCENE_REQUEST_BYTES,
  type ChatRequest, type ScenePlan, type SceneReceipt, type SceneSnapshot, type SceneBatch, type ServiceHealth, type SceneCommentary,
} from '../../../packages/protocol/src/index.ts';
import { VoxelEngine } from '../../../packages/scene/src/index.ts';
import type { ApiConfig } from './config.ts';
import { ApiError, diagnoseBatchFailure, planningError, publicError, throwIfAborted, type PlanTrace } from './errors.ts';
import { createProviders, mimoConfigured, type Providers, type PlannerPhase } from './providers.ts';
import { MAX_WAV_BYTES, validateRecording } from './wav.ts';
import { newPartGroupingIssue } from './grouping.ts';
import { MODEL_THINKING_MODE, MODEL_REASONING_EFFORT } from './deepseek-stream.ts';
import { BackgroundWorkspace, registerWorkspace } from './workspace.ts';
import { WorkspaceStore } from './workspace-store.ts';

type TurnStatus = 'generating' | 'awaiting_ack' | 'committed' | 'replied' | 'cancelled' | 'failed';
interface Turn {
  id: string;
  session: string;
  fingerprint: string;
  status: TurnStatus;
  updatedAt: number;
  plan?: ScenePlan;
  receipts: SceneReceipt[];
  pending?: { plan: ScenePlan; snapshot: SceneSnapshot; digest: string; expiresAt: number; resolve?: (snapshot: SceneSnapshot) => void; reject?: (error: Error) => void };
  reply?: string;
  expectedRevision?: number;
  expectedDigest?: string;
  diagnostics?: PlanTrace;
  error?: { code: string; message: string };
}
interface Session { touchedAt: number; windowStart: number; calls: number; speech: Map<string, number> }
const SESSION_TTL = 10 * 60_000;
const ACK_TTL = 2 * 60_000;
const MAX_SESSIONS = 128;
const MAX_TURNS = 64;
const MAX_GLOBAL_JOBS = 4;
const ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const SESSION_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
const ackSchema = z.object({ batchId: z.string().min(1).max(100).optional(), revision: z.number().int().nonnegative(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const speechSchema = z.object({ text: z.string().trim().min(1).max(600) }).strict();

export function createApp(config: ApiConfig, options: { providers?: Providers; now?: () => number; databasePath?: string } = {}) {
  // The transport outlasts the shared six-minute model + browser-ACK budget.
  const app = Fastify({ logger: false, bodyLimit: 8_388_608, requestTimeout: 390_000, connectionTimeout: 390_000 });
  const providers = options.providers ?? createProviders(config);
  const now = options.now ?? Date.now;
  const turns = new Map<string, Turn>();
  const sessions = new Map<string, Session>();
  const active = new Map<string, AbortController>();
  const workspace = new BackgroundWorkspace(new WorkspaceStore(options.databasePath ?? ':memory:'), providers, now);
  const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`, `[::1]:${config.port}`,
    ...config.allowedOrigins.map((origin) => new URL(origin).host)]);

  function cleanup(): void {
    const time = now();
    for (const [key, turn] of turns) {
      if (turn.pending && time > turn.pending.expiresAt) {
        turn.pending.reject?.(new ApiError('ACK_EXPIRED', 409, '这批确认已超时，剩余搭建已停止。'));
        turn.pending = undefined; turn.plan = undefined;
        if (turn.status === 'awaiting_ack') { turn.status = 'failed'; turn.reply = undefined; }
      }
      if (time - turn.updatedAt > SESSION_TTL && turn.status !== 'generating') turns.delete(key);
    }
    for (const [key, session] of sessions) {
      if (time - session.touchedAt > SESSION_TTL && !active.has(key)) sessions.delete(key);
      for (const [text, timestamp] of session.speech) if (time - timestamp > SESSION_TTL) session.speech.delete(text);
    }
  }

  function sessionFor(request: FastifyRequest): string {
    const value = request.headers['x-sayland-session'];
    if (typeof value !== 'string' || !SESSION_PATTERN.test(value)) {
      throw new ApiError('INVALID_SESSION', 400, '请刷新页面后再试。');
    }
    cleanup();
    let session = sessions.get(value);
    if (!session) {
      if (sessions.size >= MAX_SESSIONS) throw new ApiError('SERVICE_BUSY', 503, '伙伴正忙，稍后再试吧。');
      session = { touchedAt: now(), windowStart: now(), calls: 0, speech: new Map() };
      sessions.set(value, session);
    }
    session.touchedAt = now();
    return value;
  }

  function consumeRate(sessionId: string): void {
    const session = sessions.get(sessionId)!;
    if (now() - session.windowStart >= 60_000) { session.windowStart = now(); session.calls = 0; }
    if (session.calls >= 24) throw new ApiError('RATE_LIMITED', 429, '先玩一会儿，稍后再告诉我新想法吧。');
    session.calls += 1;
  }

  function begin(session: string, request: FastifyRequest, reply: FastifyReply): { signal: AbortSignal; abort(): void; finish(): void } {
    if (active.has(session)) throw new ApiError('SESSION_BUSY', 409, '上一件事还没结束，可以先停下来。');
    if (active.size >= MAX_GLOBAL_JOBS) throw new ApiError('SERVICE_BUSY', 503, '伙伴正忙，稍后再试吧。');
    consumeRate(session);
    const controller = new AbortController();
    active.set(session, controller);
    const disconnected = () => { if (!reply.raw.writableEnded) controller.abort(); };
    const aborted = () => controller.abort();
    request.raw.once('aborted', aborted);
    reply.raw.once('close', disconnected);
    return {
      signal: controller.signal,
      abort() { controller.abort(); },
      finish() {
        request.raw.off('aborted', aborted);
        reply.raw.off('close', disconnected);
        if (active.get(session) === controller) active.delete(session);
      },
    };
  }

  function approveSpeech(sessionId: string, text: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.speech.set(text, now());
    while (session.speech.size > 12) session.speech.delete(session.speech.keys().next().value!);
  }

  function getTurn(session: string, id: unknown): Turn {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new ApiError('INVALID_REQUEST_ID', 400, '这次操作编号不正确。');
    const turn = turns.get(`${session}:${id}`);
    if (!turn) throw new ApiError('TURN_NOT_FOUND', 404, '这次操作已经过期，场景仍保留在你的设备上。');
    return turn;
  }

  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host;
    if (!host || !allowedHosts.has(host.toLowerCase())) throw new ApiError('INVALID_HOST', 403, '仅允许本机访问。');
    const origin = request.headers.origin;
    if (origin !== undefined && !config.allowedOrigins.includes(origin)) throw new ApiError('INVALID_ORIGIN', 403, '这个页面不能访问说说岛服务。');
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    if (origin) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, X-Sayland-Session');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    cleanup();
  });
  app.options('/api/*', async (_request, reply) => reply.code(204).send());
  app.setErrorHandler((error, _request, reply) => {
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : '';
    const failure = error instanceof ApiError ? error
      : code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? new ApiError('BODY_TOO_LARGE', 413, '这次内容太大了，请分成小一点的步骤。')
      : ['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY', 'FST_ERR_CTP_INVALID_MEDIA_TYPE'].includes(code)
        ? new ApiError('INVALID_REQUEST', 400, '这次内容没有传完整，请再试一次。') : error;
    return reply.code(failure instanceof ApiError ? failure.status : 500).send({ error: publicError(failure) });
  });
  app.addContentTypeParser('audio/wav', { parseAs: 'buffer', bodyLimit: MAX_WAV_BYTES }, (_request, body, done) => done(null, body));

  app.get('/api/health', async (): Promise<ServiceHealth> => ({
    ok: true, model: config.deepseek.model, aiConfigured: Boolean(config.deepseek.apiKey),
    thinking: MODEL_THINKING_MODE, reasoningEffort: MODEL_REASONING_EFFORT,
    asrConfigured: mimoConfigured(config), ttsConfigured: mimoConfigured(config),
  }));

  registerWorkspace(app, workspace, sessionFor);

  app.post('/api/chat', { bodyLimit: MAX_SCENE_REQUEST_BYTES }, async (request, reply) => {
    const session = sessionFor(request);
    const parsed = chatRequestSchema.safeParse(request.body);
    if (!parsed.success || !ID_PATTERN.test(parsed.data.requestId)) throw new ApiError('INVALID_REQUEST', 400, '这次想法或场景没有传完整，请再试一次。');
    const input = parsed.data;
    // Structural parsing alone cannot detect duplicate voxel IDs/cells or missing parts.
    try { VoxelEngine.fromSnapshot(input.snapshot); }
    catch { throw new ApiError('INVALID_SCENE', 400, '作品数据需要检查，请重新打开已保存的作品。'); }
    const key = `${session}:${input.requestId}`;
    const fingerprint = requestFingerprint(input);
    const existing = turns.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ApiError('REQUEST_ID_REUSED', 409, '同一次操作的内容发生了变化，请重新发送。');
      if (existing.status === 'awaiting_ack' && existing.plan && !existing.plan.batchId) {
        openStream(reply); writeEvent(reply, 'plan', existing.plan); writeEvent(reply, 'done', { requestId: existing.id, status: existing.status }); reply.raw.end(); return;
      }
      if (['committed', 'replied'].includes(existing.status)) {
        openStream(reply); writeEvent(reply, 'reply', { requestId: existing.id, reply: existing.reply }); writeEvent(reply, 'done', { requestId: existing.id, status: existing.status }); reply.raw.end(); return;
      }
      throw new ApiError('TURN_UNAVAILABLE', 409, '这次操作正在处理或已经结束，请查看当前状态。');
    }
    if ([...turns.values()].some((turn) => turn.session === session && turn.status === 'awaiting_ack')) {
      throw new ApiError('ACK_PENDING', 409, '上一笔搭建正在确认，请稍等一下。');
    }
    if (turns.size >= MAX_TURNS) {
      const disposable = [...turns].find(([, turn]) => !['generating', 'awaiting_ack'].includes(turn.status));
      if (!disposable) throw new ApiError('SERVICE_BUSY', 503, '伙伴正忙，稍后再试吧。');
      turns.delete(disposable[0]);
    }
    const job = begin(session, request, reply);
    const turn: Turn = { id: input.requestId, session, fingerprint, status: 'generating', updatedAt: now(), receipts: [] };
    turns.set(key, turn);
    openStream(reply);
    writeEvent(reply, 'status', { requestId: turn.id, message: '让我想想怎么搭……', phase: 'thinking' });
    let workingSnapshot = input.snapshot, batchNumber = 0, commentaryNumber = 0, timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; job.abort(); }, 360_000);
    // Phase keepalives convey no model content or reasoning, including while waiting for a large batch.
    let phase: PlannerPhase | 'awaiting_ack' = 'thinking', lastProgress = 0;
    const progressText: Record<PlannerPhase | 'awaiting_ack', string> = {
      thinking: '正在思考接下来怎么搭…', answering: '正在整理想法和回复…', 'tool-input': '正在设计这一批方块…',
      inspect: '正在查看小岛的物件和空间…', 'read-region': '正在读取目标部件的实际方块…', 'get-views': '正在准备实际场景的三视图…',
      validate: '正在检查这一批方块的位置和组合…', repair: '这一步还没通过，正在调整方案…', awaiting_ack: '正在确认这一部分是否搭好…',
    };
    const progress = () => { if (!job.signal.aborted) writeEvent(reply, 'status', { requestId: turn.id, phase, message: progressText[phase] }); };
    const heartbeat = setInterval(progress, 15_000);
    const prepare = async (proposed: SceneBatch, text: string, batchId?: string): Promise<NonNullable<Turn['pending']>> => {
      throwIfAborted(job.signal);
      const batch = batchSchema.safeParse(proposed);
      const safeReply = z.string().trim().min(1).max(600).safeParse(text);
      if (!batch.success || !safeReply.success) throw new ApiError('INVALID_PLAN', 502, '这批搭建步骤还不完整，尚未提交。');
      let result;
      try { result = VoxelEngine.fromSnapshot(workingSnapshot).executeBatch(batch.data, batchId ?? input.requestId, input.requestId); }
      catch (error) {
        const diagnostic = diagnoseBatchFailure(workingSnapshot, batch.data, error, job.signal);
        turn.diagnostics ??= { modelCalls: 0, queryCalls: 0, applyAttempts: 0, failures: [] };
        turn.diagnostics.failures.push(diagnostic); throw planningError(diagnostic);
      }
      const groupingIssue = newPartGroupingIssue(workingSnapshot, result.snapshot, batch.data);
      if (groupingIssue) {
        turn.diagnostics ??= { modelCalls: 0, queryCalls: 0, applyAttempts: 0, failures: [] };
        turn.diagnostics.failures.push(groupingIssue); throw planningError(groupingIssue);
      }
      if (batchId && result.snapshot.revision <= workingSnapshot.revision) throw new ApiError('EMPTY_EDIT', 422, '这批没有实际改变，未提交空操作。');
      const digest = await snapshotDigest(result.snapshot);
      throwIfAborted(job.signal);
      const plan: ScenePlan = { requestId: input.requestId, ...(batchId ? { batchId } : {}), batch: batch.data, reply: safeReply.data };
      turn.expectedRevision = result.snapshot.revision; turn.expectedDigest = digest;
      return { plan, snapshot: result.snapshot, digest, expiresAt: now() + ACK_TTL };
    };
    try {
      const proposed = await providers.plan(input, job.signal, {
        beforeModelCall(callNumber) { throwIfAborted(job.signal); if (callNumber > 1) consumeRate(session); },
        onProgress(nextPhase = 'thinking') {
          throwIfAborted(job.signal);
          const changed = phase !== nextPhase; phase = nextPhase;
          // Rapid real transitions must survive throttling; only repeated stream tokens are coalesced.
          if (changed || now() - lastProgress > 1_000) { progress(); lastProgress = now(); }
        },
        onDiagnostics(trace) { turn.diagnostics = structuredClone(trace); },
        onCommentary(text) {
          throwIfAborted(job.signal);
          const safeText = z.string().trim().min(1).max(600).safeParse(text);
          if (!safeText.success) return;
          const event: SceneCommentary = { requestId: turn.id, messageId: `${turn.id}-m${++commentaryNumber}`, text: safeText.data };
          writeEvent(reply, 'commentary', event);
        },
        async commitBatch(batch, text) {
          const pending = await prepare(batch, text, `${input.requestId}-b${++batchNumber}`);
          throwIfAborted(job.signal);
          turn.pending = pending; turn.plan = pending.plan; turn.status = 'awaiting_ack'; turn.updatedAt = now(); phase = 'awaiting_ack'; progress();
          let ackTimer: ReturnType<typeof setTimeout> | undefined;
          const aborted = () => pending.reject?.(new ApiError('CANCELLED', 499, '搭建已停止，已搭好的部分保留。'));
          try {
            const acknowledged = new Promise<SceneSnapshot>((resolve, reject) => {
              pending.resolve = resolve; pending.reject = reject;
              job.signal.addEventListener('abort', aborted, { once: true });
              ackTimer = setTimeout(() => reject(new ApiError('ACK_EXPIRED', 409, '这批确认已超时，剩余搭建已停止。')), ACK_TTL);
              writeEvent(reply, 'plan', pending.plan);
            });
            workingSnapshot = await acknowledged;
            return workingSnapshot;
          } finally {
            if (ackTimer) clearTimeout(ackTimer);
            job.signal.removeEventListener('abort', aborted);
            pending.resolve = undefined; pending.reject = undefined;
          }
        },
      });
      throwIfAborted(job.signal);
      const safeReply = z.string().trim().min(1).max(600).safeParse(proposed.reply);
      if (!safeReply.success) throw new ApiError('INVALID_PLAN', 502, '这次想法还没有准备完整。');
      turn.reply = safeReply.data;
      if (proposed.batch) {
        // Keep injected single-batch providers and older clients compatible.
        const pending = await prepare(proposed.batch, safeReply.data);
        turn.pending = pending; turn.plan = pending.plan; turn.status = 'awaiting_ack'; turn.updatedAt = now();
        writeEvent(reply, 'plan', turn.plan);
      } else {
        turn.status = 'replied'; approveSpeech(session, safeReply.data);
        writeEvent(reply, 'reply', { requestId: input.requestId, reply: safeReply.data });
      }
      writeEvent(reply, 'done', { requestId: input.requestId, status: turn.status });
    } catch (error) {
      turn.status = job.signal.aborted && !timedOut ? 'cancelled' : 'failed';
      turn.reply = undefined; turn.plan = undefined;
      const failure = timedOut ? { code: 'PLANNING_TIMEOUT', message: '这轮搭建时间已用完，剩余部分还没有完成。' } : publicError(error);
      turn.error = { ...failure, ...(turn.receipts.length ? { message: '剩余部分没有完成，已搭好的部分保留，可以一次撤销。' } : {}) };
      writeEvent(reply, 'error', { requestId: input.requestId, ...turn.error, committedBatches: turn.receipts.length });
    } finally {
      clearTimeout(deadline); clearInterval(heartbeat);
      turn.updatedAt = now(); job.finish();
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  });

  app.get<{ Params: { id: string } }>('/api/turns/:id', async (request) => {
    const session = sessionFor(request);
    const turn = getTurn(session, request.params.id);
    return turnView(turn);
  });

  app.post<{ Params: { id: string } }>('/api/turns/:id/ack', async (request) => {
    const session = sessionFor(request);
    const turn = getTurn(session, request.params.id);
    const ack = ackSchema.safeParse(request.body);
    if (!ack.success) throw new ApiError('INVALID_ACK', 400, '作品确认信息没有传完整。');
    const receipt = turn.receipts.find(item => item.batchId === ack.data.batchId);
    if (receipt) {
      if (receipt.revision !== ack.data.revision || receipt.digest !== ack.data.digest) throw new ApiError('ACK_MISMATCH', 409, '这批确认信息与已提交作品不一致。');
      return receipt;
    }
    const pending = turn.pending;
    if (!pending || pending.plan.batchId !== ack.data.batchId || now() > pending.expiresAt) throw new ApiError('TURN_NOT_ACKNOWLEDGEABLE', 409, '这批搭建已经过期或编号不匹配。');
    if (ack.data.revision !== pending.snapshot.revision || ack.data.digest !== pending.digest) throw new ApiError('ACK_MISMATCH', 409, '作品已发生变化，这批搭建尚未确认。');
    const committed: SceneReceipt = { requestId: turn.id, ...(pending.plan.batchId ? { batchId: pending.plan.batchId } : {}),
      status: 'committed', revision: pending.snapshot.revision, digest: pending.digest, reply: pending.plan.reply };
    turn.receipts.push(committed);
    if (turn.error) turn.error = { ...turn.error, message: '剩余部分没有完成，已搭好的部分保留，可以一次撤销。' };
    if (turn.receipts.length > 64) turn.receipts.shift();
    turn.pending = undefined; turn.plan = undefined; turn.updatedAt = now();
    // A late receipt records the actual local commit even after cancellation, but never resumes or speaks.
    if (turn.status === 'awaiting_ack') {
      if (pending.plan.batchId) turn.status = 'generating';
      else { turn.status = 'committed'; turn.reply = committed.reply; approveSpeech(session, committed.reply); }
    }
    pending.resolve?.(pending.snapshot);
    return committed;
  });

  app.post<{ Params: { id: string } }>('/api/turns/:id/cancel', async (request) => {
    const session = sessionFor(request);
    const turn = getTurn(session, request.params.id);
    if (['generating', 'awaiting_ack'].includes(turn.status)) active.get(session)?.abort();
    if (['generating', 'awaiting_ack'].includes(turn.status)) {
      turn.status = 'cancelled'; turn.updatedAt = now(); turn.plan = undefined; turn.reply = undefined;
    }
    // A confirmed local transaction cannot be undone by cancelling a network request.
    return turnView(turn);
  });

  app.post('/api/speech/transcribe', { bodyLimit: MAX_WAV_BYTES }, async (request, reply) => {
    const session = sessionFor(request);
    if (!Buffer.isBuffer(request.body)) throw new ApiError('INVALID_AUDIO', 400, '请发送 WAV 录音。');
    validateRecording(request.body);
    const job = begin(session, request, reply);
    try {
      const text = await providers.transcribe(request.body, job.signal);
      throwIfAborted(job.signal);
      return { text };
    } finally { job.finish(); }
  });

  app.post('/api/speech/synthesize', async (request, reply) => {
    const session = sessionFor(request);
    const input = speechSchema.safeParse(request.body);
    if (!input.success) throw new ApiError('INVALID_SPEECH_TEXT', 400, '这段文字暂时不能朗读。');
    if (!sessions.get(session)?.speech.has(input.data.text) && !workspace.speechApproved(input.data.text)) {
      throw new ApiError('SPEECH_NOT_CONFIRMED', 409, '这次搭建还没有确认成功，先等作品完成吧。');
    }
    const job = begin(session, request, reply);
    try {
      const audio = await providers.synthesize(input.data.text, job.signal);
      throwIfAborted(job.signal);
      return reply.type('audio/wav').send(audio);
    } finally { job.finish(); }
  });

  app.addHook('preClose', async () => {
    for (const controller of active.values()) controller.abort();
    await workspace.close();
  });
  app.addHook('onClose', async () => {
    active.clear(); turns.clear(); sessions.clear();
  });
  return app;
}

function requestFingerprint(input: ChatRequest): string {
  return createHash('sha256').update(JSON.stringify([input.text, input.messages, canonicalSnapshotJson(input.snapshot)])).digest('hex');
}

function turnView(turn: Turn): unknown {
  return {
    requestId: turn.id, status: turn.status, receipts: turn.receipts, committedBatches: turn.receipts.length,
    ...(turn.error ? { error: turn.error } : {}),
    ...(turn.diagnostics ? { diagnostics: turn.diagnostics } : {}),
    ...(turn.status === 'awaiting_ack' ? { plan: turn.plan } : {}),
    ...(['committed', 'replied'].includes(turn.status) ? { reply: turn.reply, revision: turn.expectedRevision } : {}),
  };
}

function openStream(reply: FastifyReply): void {
  reply.hijack();
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) reply.raw.setHeader(name, value);
  }
  reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store', 'x-accel-buffering': 'no', connection: 'keep-alive' });
}

function writeEvent(reply: FastifyReply, event: string, value: unknown): void {
  if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}
