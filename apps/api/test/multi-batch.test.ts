import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { VoxelEngine } from '../../../packages/scene/src/index.ts';
import { snapshotDigest, type ChatRequest, type SceneBatch, type ScenePlan, type SceneSnapshot } from '../../../packages/protocol/src/index.ts';
import { createApp } from '../src/app.ts';
import { ApiError } from '../src/errors.ts';
import type { ApiConfig } from '../src/config.ts';
import type { Providers } from '../src/providers.ts';

const config: ApiConfig = { port: 4311, allowedOrigins: [], deepseek: { apiKey: 'fixture', baseUrl: 'https://fixture.invalid', model: 'deepseek-flash' },
  mimo: { apiKey: 'fixture', baseUrl: 'https://fixture.invalid', asrModel: 'fixture', ttsModel: 'fixture', voice: 'fixture' } };
const headers = { host: '127.0.0.1:4311', 'x-sayland-session': 'fixture-batched-session' };
const initial = new VoxelEngine().snapshot();
const input: ChatRequest = { requestId: 'fixture-batched-turn', text: '搭个机器人', snapshot: initial, messages: [] };
const first: SceneBatch = { protocolVersion: 1, baseRevision: initial.revision, operations: [
  { op: 'define_group', group: { id: 'robot', name: '机器人' } },
  { op: 'define_part', part: { id: 'body', name: '身体', role: 'other', groupId: 'robot', origin: { x: 0, y: 0, z: 0 } } },
  { op: 'patch_cells', partId: 'body', cells: [{ cell: { x: 0, y: 0, z: 0 }, color: '#44AAFF' }] },
] };
const second = (snapshot: SceneSnapshot): SceneBatch => ({ protocolVersion: 1, baseRevision: snapshot.revision, operations: [
  { op: 'define_part', part: { id: 'head', name: '头', role: 'detail', groupId: 'robot', origin: { x: 0, y: 1, z: 0 } } },
  { op: 'patch_cells', partId: 'head', cells: [{ cell: { x: 0, y: 0, z: 0 }, color: '#FFAA44' }] },
] });
function providers(plan: Providers['plan']): Providers { return { plan, transcribe: async () => 'fixture', synthesize: async () => Buffer.from('audio') }; }
async function pending(app: ReturnType<typeof createApp>, suffix: string): Promise<ScenePlan> {
  for (let i = 0; i < 100; i++) {
    const state = (await app.inject({ method: 'GET', url: `/api/turns/${input.requestId}`, headers })).json();
    if (state.plan?.batchId?.endsWith(suffix)) return state.plan;
    assert.ok(!['failed', 'cancelled', 'replied'].includes(state.status), JSON.stringify(state));
    await setImmediate();
  }
  throw new Error('Expected a pending batch');
}
async function acknowledge(app: ReturnType<typeof createApp>, plan: ScenePlan, engine: VoxelEngine) {
  const snapshot = engine.executeBatch(plan.batch, plan.batchId!, plan.requestId).snapshot;
  const payload = { batchId: plan.batchId, revision: snapshot.revision, digest: await snapshotDigest(snapshot) };
  const response = await app.inject({ method: 'POST', url: `/api/turns/${plan.requestId}/ack`, headers, payload });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().digest, payload.digest);
  return { payload, receipt: response.json() };
}

test('each batch awaits exact ACK, advances authority, and only final reply approves speech; one undo restores whole turn', async t => {
  let steps = 0;
  const app = createApp(config, { providers: providers(async (_input, signal, options) => {
    const after = await options!.commitBatch!(first, '身体先搭好了。'); steps++;
    assert.equal(after.revision, 1); assert.equal(signal.aborted, false);
    const final = await options!.commitBatch!(second(after), '头也搭好了。'); steps++;
    assert.equal(final.parts.length, 2); return { reply: '机器人完成啦。' };
  }) }); t.after(() => app.close());
  const response = app.inject({ method: 'POST', url: '/api/chat', headers, payload: input }).then(value => value);
  const engine = VoxelEngine.fromSnapshot(initial);
  const plan1 = await pending(app, '-b1'); assert.equal(steps, 0);
  assert.equal((await app.inject({ method: 'POST', url: '/api/chat', headers, payload: { ...input, requestId: 'fixture-other-turn' } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: `/api/turns/${input.requestId}/ack`, headers, payload: { revision: 1, digest: '0'.repeat(64) } })).statusCode, 409);
  const ack1 = await acknowledge(app, plan1, engine);
  const plan2 = await pending(app, '-b2'); assert.equal(steps, 1);
  const state = (await app.inject({ method: 'GET', url: `/api/turns/${input.requestId}`, headers })).json();
  assert.deepEqual(state.receipts, [ack1.receipt]); assert.equal(state.status, 'awaiting_ack');
  assert.equal((await app.inject({ method: 'POST', url: '/api/speech/synthesize', headers, payload: { text: '身体先搭好了。' } })).statusCode, 409);
  assert.deepEqual((await app.inject({ method: 'POST', url: `/api/turns/${input.requestId}/ack`, headers, payload: ack1.payload })).json(), ack1.receipt);
  await acknowledge(app, plan2, engine);
  const finished = await response; assert.equal(steps, 2);
  assert.equal((finished.body.match(/event: plan/g) ?? []).length, 2); assert.equal((finished.body.match(/event: reply/g) ?? []).length, 1);
  assert.ok(finished.body.includes('"status":"replied"'));
  assert.equal((await app.inject({ method: 'POST', url: '/api/speech/synthesize', headers, payload: { text: '机器人完成啦。' } })).statusCode, 200);
  engine.undo(); assert.equal(engine.snapshot().parts.length, 0); assert.equal(engine.snapshot().voxels.length, 0);
});

test('later failure preserves prior receipts and suppresses final success/speech; GET recovers a lost earlier ACK', async t => {
  const app = createApp(config, { providers: providers(async (_input, _signal, options) => {
    await options!.commitBatch!(first, '身体好了。'); throw new ApiError('PLAN_COLLISION', 502, '这次没有改动作品。');
  }) }); t.after(() => app.close());
  const response = app.inject({ method: 'POST', url: '/api/chat', headers, payload: input }).then(value => value);
  const plan = await pending(app, '-b1'); const engine = VoxelEngine.fromSnapshot(initial);
  const ack = await acknowledge(app, plan, engine); const finished = await response;
  assert.ok(!finished.body.includes('event: reply')); assert.ok(finished.body.includes('"committedBatches":1'));
  assert.ok(finished.body.includes('已搭好的部分保留')); assert.ok(!finished.body.includes('这次没有改动作品'));
  const state = (await app.inject({ method: 'GET', url: `/api/turns/${input.requestId}`, headers })).json();
  assert.equal(state.status, 'failed'); assert.deepEqual(state.receipts, [ack.receipt]);
  assert.equal((await app.inject({ method: 'POST', url: `/api/turns/${input.requestId}/ack`, headers, payload: ack.payload })).statusCode, 200);
  assert.equal(engine.snapshot().voxels.length, 1);
  assert.equal((await app.inject({ method: 'POST', url: '/api/speech/synthesize', headers, payload: { text: '身体好了。' } })).statusCode, 409);
});

test('cancel during waiting ACK stops generation, but a late actual local commit remains recoverable without TTS', async t => {
  let resumed = false;
  const app = createApp(config, { providers: providers(async (_input, _signal, options) => {
    await options!.commitBatch!(first, '身体好了。'); resumed = true; return { reply: '完成啦。' };
  }) }); t.after(() => app.close());
  const response = app.inject({ method: 'POST', url: '/api/chat', headers, payload: input }).then(value => value);
  const plan = await pending(app, '-b1');
  const cancel = await app.inject({ method: 'POST', url: `/api/turns/${input.requestId}/cancel`, headers });
  assert.equal(cancel.json().status, 'cancelled'); await response;
  const ack = await acknowledge(app, plan, VoxelEngine.fromSnapshot(initial));
  const state = (await app.inject({ method: 'GET', url: `/api/turns/${input.requestId}`, headers })).json();
  assert.equal(resumed, false); assert.equal(state.status, 'cancelled'); assert.deepEqual(state.receipts, [ack.receipt]);
  assert.ok(state.error.message.includes('已搭好的部分保留'));
  assert.equal((await app.inject({ method: 'POST', url: '/api/speech/synthesize', headers, payload: { text: '身体好了。' } })).statusCode, 409);
});

test('server revalidates every later batch grouping before emission and preserves the valid first receipt', async t => {
  const app = createApp(config, { providers: providers(async (_input, _signal, options) => {
    const after = await options!.commitBatch!(first, '身体好了。');
    const invalid = second(after); const part = invalid.operations[0];
    assert.equal(part.op, 'define_part'); if (part.op === 'define_part') part.part.groupId = null;
    await options!.commitBatch!(invalid, '头好了。'); return { reply: '完成。' };
  }) }); t.after(() => app.close());
  const response = app.inject({ method: 'POST', url: '/api/chat', headers, payload: input }).then(value => value);
  const plan = await pending(app, '-b1'); await acknowledge(app, plan, VoxelEngine.fromSnapshot(initial));
  const finished = await response;
  assert.equal((finished.body.match(/event: plan/g) ?? []).length, 1); assert.ok(finished.body.includes('PLAN_GROUP_REQUIRED'));
});
