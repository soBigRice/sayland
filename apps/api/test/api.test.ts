import test from 'node:test';
import assert from 'node:assert/strict';
import { VoxelEngine } from '../../../packages/scene/src/index.ts';
import { snapshotDigest, type SceneBatch } from '../../../packages/protocol/src/index.ts';
import { createApp } from '../src/app.ts';
import type { ApiConfig } from '../src/config.ts';
import { ApiError } from '../src/errors.ts';
import { createProviders, type Providers } from '../src/providers.ts';

// Synthetic fixtures only: fetch is replaced and no environment file/provider is accessed.
const config: ApiConfig = {
  port: 4311, allowedOrigins: ['http://127.0.0.1:4310'],
  deepseek: { apiKey: 'fixture-not-a-live-key', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
  mimo: { apiKey: 'sk-fixture-not-a-live-key', baseUrl: 'https://api.xiaomimimo.com/v1', asrModel: 'mimo-v2.5-asr', ttsModel: 'mimo-v2.5-tts', voice: 'mimo_default' },
};
const headers = { host: '127.0.0.1:4311', origin: 'http://127.0.0.1:4310', 'x-sayland-session': 'fixture-session-0001' };
const snapshot = new VoxelEngine().snapshot();
const batch: SceneBatch = {
  protocolVersion: 1, baseRevision: snapshot.revision,
  operations: [
    { op: 'define_group', group: { id: 'test-house', name: '测试房子' } },
    { op: 'define_part', part: { id: 'test-roof', name: '测试屋顶', role: 'roof', origin: { x: 0, y: 0, z: 0 }, groupId: 'test-house' } },
    { op: 'fill_shape', partId: 'test-roof', color: '#55AAFF', shape: { kind: 'box', offset: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 1, z: 2 } } },
  ],
};
const input = { requestId: 'fixture-turn-0001', text: '搭一个蓝屋顶', snapshot, messages: [] };
const replyText = '蓝色屋顶搭好啦！';
function fixtures(overrides: Partial<Providers> = {}): Providers {
  return { plan: async () => ({ batch, reply: replyText }), transcribe: async () => '搭一棵树', synthesize: async () => wavFixture(), ...overrides };
}
function events(source: string): Array<{ event: string; data: Record<string, unknown> }> {
  return source.trim().split('\n\n').filter(Boolean).map((part) => {
    const lines = part.split('\n');
    return { event: lines[0].replace('event: ', ''), data: JSON.parse(lines[1].replace('data: ', '')) as Record<string, unknown> };
  });
}

test('health reports capabilities without credentials; cross-origin and invalid Host are rejected', async (t) => {
  const app = createApp(config, { providers: fixtures() }); t.after(() => app.close());
  const health = await app.inject({ method: 'GET', url: '/api/health', headers });
  assert.deepEqual(health.json(), { ok: true, model: 'deepseek-flash', aiConfigured: true, asrConfigured: true, ttsConfigured: true });
  assert.ok(!health.body.includes('key'));
  assert.equal((await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/health', headers: { ...headers, origin: 'https://evil.example' } })).statusCode, 403);
});

test('scene plan needs the exact local revision and digest ACK before speech; duplicate submission is idempotent', async (t) => {
  let plans = 0; let speeches = 0;
  const app = createApp(config, { providers: fixtures({
    plan: async () => { plans += 1; return { batch, reply: replyText }; },
    synthesize: async () => { speeches += 1; return wavFixture(); },
  }) }); t.after(() => app.close());
  const first = await app.inject({ method: 'POST', url: '/api/chat', headers, payload: input });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(events(first.body).map((event) => event.event), ['status', 'plan', 'done']);
  const before = await app.inject({ method: 'POST', url: '/api/speech/synthesize', headers, payload: { text: replyText } });
  assert.equal(before.statusCode, 409); assert.equal(speeches, 0);
  const invalid = await app.inject({ method: 'POST', url: `/api/turns/${input.requestId}/ack`, headers, payload: { revision: 1, digest: '0'.repeat(64) } });
  assert.equal(invalid.statusCode, 409);
  const duplicate = await app.inject({ method: 'POST', url: '/api/chat', headers, payload: input });
  assert.equal(duplicate.statusCode, 200); assert.equal(plans, 1);
  const projected = VoxelEngine.fromSnapshot(snapshot).executeBatch(batch, input.requestId).snapshot;
  const receipt = { revision: projected.revision, digest: await snapshotDigest(projected) };
  const acknowledged = await app.inject({ method: 'POST', url: `/api/turns/${input.requestId}/ack`, headers, payload: receipt });
  assert.equal(acknowledged.statusCode, 200); assert.equal(acknowledged.json().reply, replyText);
  assert.equal((await app.inject({ method: 'POST', url: `/api/turns/${input.requestId}/ack`, headers, payload: receipt })).statusCode, 200);
  const spoken = await app.inject({ method: 'POST', url: '/api/speech/synthesize', headers, payload: { text: replyText } });
  assert.equal(spoken.statusCode, 200); assert.equal(spoken.headers['content-type'], 'audio/wav'); assert.equal(speeches, 1);
  const cancelled = await app.inject({ method: 'POST', url: `/api/turns/${input.requestId}/cancel`, headers });
  assert.equal(cancelled.json().status, 'committed');
});

test('invalid or infeasible model batches never become plans or approvable speech', async (t) => {
  const invalidBatch: SceneBatch = { ...batch, operations: [{ op: 'paint_part', partId: 'missing-part', color: '#FFFFFF', region: null }] };
  const app = createApp(config, { providers: fixtures({ plan: async () => ({ batch: invalidBatch, reply: replyText }) }) });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/chat', headers, payload: input });
  assert.deepEqual(events(response.body).map((event) => event.event), ['status', 'error']);
  assert.equal(events(response.body)[1].data.code, 'PLAN_PART_NOT_FOUND');
  assert.ok(!response.body.includes('放不下'));
  const state = await app.inject({ method: 'GET', url: `/api/turns/${input.requestId}`, headers });
  assert.equal(state.json().status, 'failed'); assert.ok(!('reply' in state.json()));
  assert.equal(state.json().diagnostics.failures[0].operationIndex, 0);
  assert.equal(state.json().diagnostics.failures[0].operation.partId, 'missing-part');
  assert.equal((await app.inject({ method: 'GET', url: `/api/turns/${input.requestId}`, headers: { ...headers, 'x-sayland-session': 'fixture-session-other' } })).statusCode, 404);
});

test('an injected provider cannot bypass new-part group membership before plan delivery and ACK', async (t) => {
  const ungrouped: SceneBatch = { ...batch, operations: batch.operations.filter(operation => operation.op !== 'define_group').map(operation => {
    if (operation.op !== 'define_part') return operation;
    const { groupId: _groupId, ...part } = operation.part;
    return { ...operation, part };
  }) };
  const app = createApp(config, { providers: fixtures({ plan: async () => ({ batch: ungrouped, reply: replyText }) }) }); t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/chat', headers, payload: input });
  assert.deepEqual(events(response.body).map(event => event.event), ['status', 'error']);
  assert.equal(events(response.body)[1].data.code, 'PLAN_GROUP_REQUIRED');
  const state = (await app.inject({ method: 'GET', url: `/api/turns/${input.requestId}`, headers })).json();
  assert.equal(state.status, 'failed'); assert.ok(!state.plan); assert.ok(!state.reply);
  assert.deepEqual(state.diagnostics.failures[0].partIds, ['test-roof']);
  assert.equal((await app.inject({ method: 'POST', url: '/api/speech/synthesize', headers, payload: { text: replyText } })).statusCode, 409);
});

test('cancel aborts upstream and releases session concurrency; late model results cannot produce a plan', async (t) => {
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  let wasAborted = false;
  const app = createApp(config, { providers: fixtures({ plan: async (_input, signal) => {
    started();
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => { wasAborted = true; resolve(); }, { once: true }));
    return { batch, reply: replyText };
  } }) }); t.after(() => app.close());
  const pending = app.inject({ method: 'POST', url: '/api/chat', headers, payload: input });
  await start;
  const competing = await app.inject({ method: 'POST', url: '/api/chat', headers, payload: { ...input, requestId: 'fixture-turn-0002' } });
  assert.equal(competing.statusCode, 409);
  await app.inject({ method: 'POST', url: `/api/turns/${input.requestId}/cancel`, headers });
  const result = await pending;
  assert.equal(wasAborted, true); assert.ok(!events(result.body).some((event) => event.event === 'plan'));
  assert.equal((await app.inject({ method: 'GET', url: `/api/turns/${input.requestId}`, headers })).json().status, 'cancelled');
  const audio = await app.inject({ method: 'POST', url: '/api/speech/transcribe', headers: { ...headers, 'content-type': 'audio/wav' }, payload: wavFixture() });
  assert.equal(audio.statusCode, 200);
});

test('request ID reuse, expired ACK and another browser session cannot confirm an old turn', async (t) => {
  let time = 1000;
  const app = createApp(config, { providers: fixtures(), now: () => time }); t.after(() => app.close());
  await app.inject({ method: 'POST', url: '/api/chat', headers, payload: input });
  assert.equal((await app.inject({ method: 'POST', url: '/api/chat', headers, payload: { ...input, text: '另一件事' } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'GET', url: `/api/turns/${input.requestId}`, headers: { ...headers, 'x-sayland-session': 'fixture-session-0002' } })).statusCode, 404);
  time += 121_000;
  const projected = VoxelEngine.fromSnapshot(snapshot).executeBatch(batch, input.requestId).snapshot;
  assert.equal((await app.inject({ method: 'POST', url: `/api/turns/${input.requestId}/ack`, headers,
    payload: { revision: projected.revision, digest: await snapshotDigest(projected) } })).statusCode, 409);
});

test('bad WAV is rejected before the provider and upstream error details are redacted', async (t) => {
  let calls = 0;
  const app = createApp(config, { providers: fixtures({
    transcribe: async () => { calls += 1; throw new Error('private-key-and-transcript'); },
  }) }); t.after(() => app.close());
  const invalid = await app.inject({ method: 'POST', url: '/api/speech/transcribe', headers: { ...headers, 'content-type': 'audio/wav' }, payload: Buffer.from('not wav') });
  assert.equal(invalid.statusCode, 400); assert.equal(calls, 0);
  const failed = await app.inject({ method: 'POST', url: '/api/speech/transcribe', headers: { ...headers, 'content-type': 'audio/wav' }, payload: wavFixture() });
  assert.equal(failed.statusCode, 500); assert.ok(!failed.body.includes('private-key'));
});

test('MiMo adapters use official WAV contracts; provider failures never echo response bodies', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const mockFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return Response.json(body.model === 'mimo-v2.5-asr'
      ? { choices: [{ message: { content: '一棵树' } }] }
      : { choices: [{ message: { audio: { data: wavFixture().toString('base64') } } }] });
  };
  const providers = createProviders(config, mockFetch);
  assert.equal(await providers.transcribe(wavFixture(), new AbortController().signal), '一棵树');
  assert.ok((await providers.synthesize('你好', new AbortController().signal)).equals(wavFixture()));
  assert.equal(bodies[0].model, 'mimo-v2.5-asr'); assert.equal(bodies[0].stream, false);
  assert.deepEqual(bodies[1].audio, { format: 'wav', voice: 'mimo_default' });
  const denied = createProviders(config, async () => new Response('private-provider-body', { status: 401 }));
  await assert.rejects(() => denied.transcribe(wavFixture(), new AbortController().signal), (error: unknown) => error instanceof ApiError && error.code === 'PROVIDER_ACCESS' && !error.message.includes('private'));
});

test('DeepSeek can return one validated tool or a conversational reply; truncated calls are never retried', async () => {
  const tool = { id: 'model-issued-call-1', type: 'function', function: { name: 'apply_scene', arguments: JSON.stringify({ operations: batch.operations, reply: replyText }) } };
  const responses = [
    { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [tool] } }] },
    { choices: [{ finish_reason: 'stop', message: { content: '你好，想造什么呢？', tool_calls: null } }] },
    { choices: [{ finish_reason: 'length', message: { content: null, tool_calls: [tool] } }] },
  ];
  const providers = createProviders(config, async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.stream, false);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    return Response.json(responses.shift());
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await providers.plan(input, signal), { batch, reply: replyText });
  assert.deepEqual(await providers.plan(input, signal), { reply: '你好，想造什么呢？' });
  await assert.rejects(() => providers.plan(input, signal), (error: unknown) => error instanceof ApiError && error.code === 'INVALID_PLAN');
  assert.equal(responses.length, 0);
});

test('every subsequent model call consumes the session rate limit; progress is provisional', async (t) => {
  let modelCalls = 0;
  const app = createApp(config, { providers: fixtures({ plan: async (_input, _signal, options) => {
    for (let call = 1; call <= 6; call++) {
      options?.beforeModelCall?.(call);
      modelCalls++;
      if (call > 1) options?.onProgress?.();
    }
    return { reply: '我们可以继续聊喜欢的颜色。' };
  } }) }); t.after(() => app.close());
  for (let turn = 0; turn < 4; turn++) {
    const response = await app.inject({ method: 'POST', url: '/api/chat', headers, payload: { ...input, requestId: `fixture-rate-turn-${turn}` } });
    assert.equal(events(response.body).filter(event => event.event === 'status' && event.data.message === '正在调整搭建方法…').length, 5);
  }
  const limited = await app.inject({ method: 'POST', url: '/api/chat', headers, payload: { ...input, requestId: 'fixture-rate-turn-5' } });
  assert.equal(limited.statusCode, 429);
  assert.equal(modelCalls, 24);
});

function wavFixture(): Buffer {
  const samples = 1600;
  const audio = Buffer.alloc(44 + samples * 2);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(samples * 2, 40);
  return audio;
}
