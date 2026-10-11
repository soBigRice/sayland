import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  batchSchema, chatRequestSchema, snapshotDigest, canonicalSnapshotJson,
  type ChatRequest, type ScenePlan, type ServiceHealth,
} from '../../../packages/protocol/src/index.ts';
import { VoxelEngine } from '../../../packages/scene/src/index.ts';
import type { ApiConfig } from './config.ts';
import { ApiError, diagnoseBatchFailure, planningError, publicError, throwIfAborted, type PlanTrace } from './errors.ts';
import { createProviders, mimoConfigured, type Providers } from './providers.ts';
import { MAX_WAV_BYTES, validateRecording } from './wav.ts';
import { newPartGroupingIssue } from './grouping.ts';

type TurnStatus = 'generating' | 'awaiting_ack' | 'committed' | 'replied' | 'cancelled' | 'failed';
interface Turn {
  id: string;
  session: string;
  fingerprint: string;
  status: TurnStatus;
  updatedAt: number;
  plan?: ScenePlan;
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
const ackSchema = z.object({ revision: z.number().int().nonnegative(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const speechSchema = z.object({ text: z.string().trim().min(1).max(600) }).strict();

export function createApp(config: ApiConfig, options: { providers?: Providers; now?: () => number } = {}) {
  // Socket inactivity must outlast the complete bounded planning loop (65 seconds).
  const app = Fastify({ logger: false, bodyLimit: 8_388_608, requestTimeout: 75_000, connectionTimeout: 75_000 });
  const providers = options.providers ?? createProviders(config);
  const now = options.now ?? Date.now;
  const turns = new Map<string, Turn>();
  const sessions = new Map<string, Session>();
  const active = new Map<string, AbortController>();
  const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`, `[::1]:${config.port}`,
    ...config.allowedOrigins.map((origin) => new URL(origin).host)]);

  function cleanup(): void {
    const time = now();
    for (const [key, turn] of turns) {
      if (turn.status === 'awaiting_ack' && time - turn.updatedAt > ACK_TTL) {
        turn.status = 'failed';
        turn.plan = undefined;
        turn.reply = undefined;
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

  function begin(session: string, request: FastifyRequest, reply: FastifyReply): { signal: AbortSignal; finish(): void } {
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
    asrConfigured: mimoConfigured(config), ttsConfigured: mimoConfigured(config),
  }));

  app.post('/api/chat', async (request, reply) => {
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
      if (existing.status === 'awaiting_ack' && existing.plan) {
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
    const turn: Turn = { id: input.requestId, session, fingerprint, status: 'generating', updatedAt: now() };
    turns.set(key, turn);
    openStream(reply);
    writeEvent(reply, 'status', { requestId: turn.id, message: '让我想想怎么搭……', phase: 'thinking' });
    try {
      const proposed = await providers.plan(input, job.signal, {
        // begin() reserves the first call; each subsequent paid call consumes the same rate budget.
        beforeModelCall(callNumber) { throwIfAborted(job.signal); if (callNumber > 1) consumeRate(session); },
        onProgress() { writeEvent(reply, 'status', { requestId: turn.id, phase: 'thinking', message: '正在调整搭建方法…' }); },
        onDiagnostics(trace) { turn.diagnostics = structuredClone(trace); },
      });
      throwIfAborted(job.signal);
      const safeReply = z.string().trim().min(1).max(600).safeParse(proposed.reply);
      if (!safeReply.success) throw new ApiError('INVALID_PLAN', 502, '这次想法还没有准备完整，世界没有改变。');
      turn.reply = safeReply.data;
      if (proposed.batch) {
        const batch = batchSchema.safeParse(proposed.batch);
        if (!batch.success) throw new ApiError('INVALID_PLAN', 502, '这次搭建计划还不完整，世界没有改变。');
        let result;
        try { result = VoxelEngine.fromSnapshot(input.snapshot).executeBatch(batch.data, input.requestId); }
        catch (error) {
          const diagnostic = diagnoseBatchFailure(input.snapshot, batch.data, error, job.signal);
          turn.diagnostics ??= { modelCalls: 0, queryCalls: 0, applyAttempts: 0, failures: [] };
          turn.diagnostics.failures.push(diagnostic);
          throw planningError(diagnostic);
        }
        const groupingIssue = newPartGroupingIssue(input.snapshot, result.snapshot, batch.data);
        if (groupingIssue) {
          turn.diagnostics ??= { modelCalls: 0, queryCalls: 0, applyAttempts: 0, failures: [] };
          turn.diagnostics.failures.push(groupingIssue);
          throw planningError(groupingIssue);
        }
        turn.expectedRevision = result.snapshot.revision;
        turn.expectedDigest = await snapshotDigest(result.snapshot);
        throwIfAborted(job.signal);
        turn.plan = { requestId: input.requestId, batch: batch.data, reply: safeReply.data };
        turn.status = 'awaiting_ack';
        turn.updatedAt = now();
        writeEvent(reply, 'plan', turn.plan);
      } else {
        turn.status = 'replied';
        approveSpeech(session, safeReply.data);
        writeEvent(reply, 'reply', { requestId: input.requestId, reply: safeReply.data });
      }
      writeEvent(reply, 'done', { requestId: input.requestId, status: turn.status });
    } catch (error) {
      turn.status = job.signal.aborted ? 'cancelled' : 'failed';
      turn.reply = undefined;
      turn.plan = undefined;
      turn.error = publicError(error);
      writeEvent(reply, 'error', { requestId: input.requestId, ...turn.error });
    } finally {
      turn.updatedAt = now();
      job.finish();
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
    if (!['awaiting_ack', 'committed'].includes(turn.status)) throw new ApiError('TURN_NOT_ACKNOWLEDGEABLE', 409, '这次搭建已经结束，无法再确认。');
    if (ack.data.revision !== turn.expectedRevision || ack.data.digest !== turn.expectedDigest) {
      throw new ApiError('ACK_MISMATCH', 409, '作品已发生变化，这次搭建还没有确认成功。');
    }
    turn.status = 'committed';
    turn.updatedAt = now();
    approveSpeech(session, turn.reply!);
    return { requestId: turn.id, reply: turn.reply, revision: turn.expectedRevision, status: turn.status };
  });

  app.post<{ Params: { id: string } }>('/api/turns/:id/cancel', async (request) => {
    const session = sessionFor(request);
    const turn = getTurn(session, request.params.id);
    if (turn.status === 'generating') active.get(session)?.abort();
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
    if (!sessions.get(session)?.speech.has(input.data.text)) {
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
    requestId: turn.id, status: turn.status,
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
