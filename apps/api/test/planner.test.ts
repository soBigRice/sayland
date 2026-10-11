import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialScene, VoxelEngine } from '../../../packages/scene/src/index.ts';
import { type ChatRequest, type SceneBatch, snapshotDigest } from '../../../packages/protocol/src/index.ts';
import { createProviders } from '../src/providers.ts';
import { ApiError, diagnoseBatchFailure, type PlanDiagnostic, type PlanTrace } from '../src/errors.ts';
import { createApp } from '../src/app.ts';
import type { ApiConfig } from '../src/config.ts';

// Deterministic model fixtures, never a live provider, environment file or microphone.
const config: ApiConfig = {
  port: 4311, allowedOrigins: ['http://127.0.0.1:4310'],
  deepseek: { apiKey: 'fixture-only', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
  mimo: { apiKey: 'fixture-only', baseUrl: 'https://api.xiaomimimo.com/v1', asrModel: 'mimo-v2.5-asr', ttsModel: 'mimo-v2.5-tts', voice: 'mimo_default' },
};
const original = createInitialScene();
const snapshot = VoxelEngine.fromSnapshot(original).executeBatch({ protocolVersion: 1, baseRevision: original.revision,
  operations: [{ op: 'paint_part', partId: 'home-roof', color: '#AA66CC', region: null }] }, 'fixture-purple-roof').snapshot;
const input: ChatRequest = { requestId: 'fixture-river-boat', text: '我要让河流的面积再大一点，然后上面有一个小船', snapshot,
  messages: [{ role: 'user', content: '把屋顶变成紫色。' }, { role: 'assistant', content: '屋顶变成紫色啦。' }] };
const bad: SceneBatch['operations'] = [
  { op: 'define_part', part: { id: 'river-north', name: '新增河水', role: 'water', origin: { x: -20, y: 0, z: -17 } } },
  { op: 'fill_shape', partId: 'river-north', color: '#48BFDE', shape: { kind: 'box', offset: { x: 0, y: -3, z: 0 }, size: { x: 40, y: 3, z: 34 } } },
  { op: 'carve_shape', partId: 'river-north', shape: { kind: 'box', offset: { x: 5, y: -3, z: 4 }, size: { x: 30, y: 3, z: 20 } } },
];
// Whole composite request retained: wider existing water plus a separate boat above it.
const repaired: SceneBatch['operations'] = [
  { op: 'define_group', group: { id: 'boat', name: '小船' } },
  { op: 'fill_shape', partId: 'lagoon', color: '#48BFDE', shape: { kind: 'box', offset: { x: -21, y: -3, z: -16 }, size: { x: 2, y: 4, z: 33 } } },
  { op: 'define_part', part: { id: 'boat-hull', name: '小船', role: 'other', origin: { x: -21, y: 1, z: -3 }, groupId: 'boat' } },
  { op: 'fill_shape', partId: 'boat-hull', color: '#BA854A', shape: { kind: 'box', offset: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 1, z: 5 } } },
  { op: 'define_part', part: { id: 'boat-mast', name: '小船桅杆', role: 'detail', origin: { x: -21, y: 2, z: -1 }, groupId: 'boat' } },
  { op: 'fill_shape', partId: 'boat-mast', color: '#F3D7AA', shape: { kind: 'box', offset: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 2, z: 1 } } },
];
const reply = '河流变宽了，小船也在水面上啦。';
const region = { min: { x: -21, y: -3, z: -17 }, max: { x: 20, y: 20, z: 17 } };
function tool(id: string, name: string, args: unknown) {
  return { id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } };
}
function completion(id: string, name: string, args: unknown) {
  return { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [tool(id, name, args)] } }] };
}
interface Body { messages: Array<{ role: string; content: string | null; tool_call_id?: string; tool_calls?: Array<{ id: string }> }>; tool_choice: unknown }
function lastTool(body: Body): { ok: boolean; committed: boolean; error: { code: string; operationIndex: number; conflict: { cell: unknown; occupiedBy: { partId: string }; targetLocalCell: unknown } }; originalRequest?: string; result: { nextOffset: number | null; offset: number; runs: unknown[]; complete: boolean } } {
  return JSON.parse(body.messages.at(-1)!.content!);
}

test('historical second-operation river collision returns local facts, permits paged inspection, then commits only a complete repaired plan', async (t) => {
  const before = JSON.stringify(snapshot);
  let call = 0, nextOffset = 0;
  const providers = createProviders(config, async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Body;
    call++;
    if (call === 1) return Response.json(completion('original-model-id', 'apply_scene', { operations: bad, reply }));
    if (call === 2) {
      const feedback = lastTool(body);
      assert.equal(body.messages.at(-2)!.tool_calls![0].id, 'original-model-id');
      assert.equal(body.messages.at(-1)!.tool_call_id, 'original-model-id');
      assert.equal(feedback.committed, false);
      assert.equal(feedback.error.code, 'COLLISION');
      assert.equal(feedback.error.operationIndex, 1);
      assert.deepEqual(feedback.error.conflict.cell, { x: -15, y: -3, z: -16 });
      assert.deepEqual(feedback.error.conflict.targetLocalCell, { x: 5, y: -3, z: 1 });
      assert.equal(feedback.error.conflict.occupiedBy.partId, 'lagoon');
      assert.equal(feedback.originalRequest, input.text);
      return Response.json(completion('query-page-one', 'inspect_scene', { region, partId: null, offset: 0 }));
    }
    if (call === 3) {
      const feedback = lastTool(body);
      assert.equal(feedback.ok, true); assert.equal(feedback.committed, false);
      assert.equal(feedback.result.complete, false); assert.equal(feedback.result.runs.length, 256);
      nextOffset = feedback.result.nextOffset!;
      return Response.json(completion('query-page-two', 'inspect_scene', { region, partId: null, offset: nextOffset }));
    }
    assert.equal(call, 4);
    assert.equal(lastTool(body).result.offset, nextOffset);
    return Response.json(completion('repaired-model-id', 'apply_scene', { operations: repaired, reply }));
  });
  const app = createApp(config, { providers }); t.after(() => app.close());
  const headers = { host: '127.0.0.1:4311', 'x-sayland-session': 'fixture-repair-session' };
  const response = await app.inject({ method: 'POST', url: '/api/chat', headers, payload: input });
  const eventData = response.body.split('\n\n').filter(Boolean).map(chunk => ({ event: chunk.split('\n')[0], data: JSON.parse(chunk.split('\n')[1].slice(6)) }));
  assert.equal(eventData.filter(event => event.event === 'event: plan').length, 1);
  const plan = eventData.find(event => event.event === 'event: plan')!.data;
  assert.deepEqual(plan.batch.operations, repaired);
  assert.equal(JSON.stringify(snapshot), before);
  const projected = VoxelEngine.fromSnapshot(snapshot).executeBatch(plan.batch, input.requestId).snapshot;
  for (const voxel of snapshot.voxels) assert.deepEqual(projected.voxels.find(other => other.id === voxel.id), voxel);
  assert.equal(projected.voxels.filter(voxel => voxel.partId === 'lagoon').length - snapshot.voxels.filter(voxel => voxel.partId === 'lagoon').length, 264);
  assert.equal(projected.voxels.filter(voxel => voxel.partId.startsWith('boat-')).length, 12);
  const state = (await app.inject({ method: 'GET', url: `/api/turns/${input.requestId}`, headers })).json();
  assert.equal(state.diagnostics.modelCalls, 4); assert.equal(state.diagnostics.queryCalls, 2); assert.equal(state.diagnostics.applyAttempts, 2);
  assert.equal(state.diagnostics.failures[0].code, 'COLLISION');
  assert.ok(!JSON.stringify(state.diagnostics).includes(input.text));
  assert.ok(!('reply' in state));
  assert.equal((await app.inject({ method: 'POST', url: '/api/speech/synthesize', headers, payload: { text: reply } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'GET', url: `/api/turns/${input.requestId}`, headers: { ...headers, 'x-sayland-session': 'fixture-another-session' } })).statusCode, 404);
  const ack = await app.inject({ method: 'POST', url: `/api/turns/${input.requestId}/ack`, headers, payload: { revision: projected.revision, digest: await snapshotDigest(projected) } });
  assert.equal(ack.statusCode, 200); assert.equal(ack.json().reply, reply);
});

test('invalid tool JSON and schema feed back to the model and can recover within three complete plans', async () => {
  let calls = 0;
  const providers = createProviders(config, async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Body;
    calls++;
    if (calls === 1) return Response.json(completion('bad-json', 'apply_scene', '{"operations":'));
    if (calls === 2) {
      assert.equal(lastTool(body).error.code, 'INVALID_JSON');
      return Response.json(completion('bad-shape', 'apply_scene', { operations: [{ op: 'fill_shape', partId: 'lagoon', shape: { kind: 'boat' }, color: '#FFFFFF' }], reply }));
    }
    assert.equal(lastTool(body).error.code, 'INVALID_ARGUMENT');
    return Response.json(completion('valid-shape', 'apply_scene', { operations: repaired, reply }));
  });
  const plan = await providers.plan(input, new AbortController().signal);
  assert.deepEqual(plan.batch!.operations, repaired); assert.equal(calls, 3);
});

test('three infeasible atomic plans stop with the real cause and never return a success reply', async () => {
  let calls = 0, trace: PlanTrace | undefined;
  const providers = createProviders(config, async () => { calls++; return Response.json(completion(`collision-${calls}`, 'apply_scene', { operations: bad, reply })); });
  await assert.rejects(providers.plan(input, new AbortController().signal, { onDiagnostics: value => { trace = value; } }),
    (error: unknown) => error instanceof ApiError && error.code === 'PLAN_COLLISION' && !error.publicMessage.includes('小一点'));
  assert.equal(calls, 3); assert.equal(trace!.applyAttempts, 3); assert.equal(trace!.failures.length, 3);
});

test('uneven layer rows retain the precise kernel reason so the model can correct the geometry', async () => {
  const layerGroup: SceneBatch['operations'][number] = { op: 'define_group', group: { id: 'layer-work', name: '自由造型' } };
  const layerPart: SceneBatch['operations'][number] = { op: 'define_part', part: { id: 'layer-object', name: '自由造型', role: 'other', origin: { x: -30, y: 1, z: 0 }, groupId: 'layer-work' } };
  const layerWrite: SceneBatch['operations'][number] = { op: 'write_layers', partId: 'layer-object', offset: { x: 0, y: 0, z: 0 },
    palette: [{ symbol: 'A', color: '#FFFFFF' }], layers: [{ y: 0, rows: ['AA', 'A'] }], mode: 'add' };
  let calls = 0;
  const providers = createProviders(config, async (_url, init) => {
    calls++;
    if (calls === 2) {
      const body = JSON.parse(String(init?.body)) as Body;
      const feedback = JSON.parse(body.messages.at(-1)!.content!);
      assert.equal(feedback.error.code, 'INVALID_GEOMETRY');
      assert.equal(feedback.error.operationIndex, 2);
      assert.equal(feedback.error.message, 'Y=0、Z=1 的行宽应为 2');
    }
    return Response.json(completion(`layers-${calls}`, 'apply_scene', { operations: [layerGroup, layerPart, calls === 1 ? layerWrite
      : { ...layerWrite, layers: [{ y: 0, rows: ['AA', 'AA'] }] }], reply: '自由造型搭好了。' }));
  });
  const plan = await providers.plan({ ...input, text: '搭一个自由造型' }, new AbortController().signal);
  assert.equal(calls, 2);
  assert.equal(VoxelEngine.fromSnapshot(snapshot).executeBatch(plan.batch!, input.requestId).snapshot.voxels.length - snapshot.voxels.length, 4);
});

test('new mast blocking four sail layers returns full prefix geometry and repairs all overlapping layers without changing the original scene', async () => {
  const origin = { x: 20, y: 1, z: 12 };
  const prefix: SceneBatch['operations'] = [
    { op: 'define_group', group: { id: 'boat', name: '小船' } },
    { op: 'fill_shape', partId: 'lagoon', color: '#48BFDE', shape: { kind: 'box', offset: { x: 19, y: 0, z: 12 }, size: { x: 7, y: 1, z: 6 } } },
    { op: 'define_part', part: { id: 'boat-hull', name: '小船', role: 'other', origin, groupId: 'boat' } },
    { op: 'fill_shape', partId: 'boat-hull', color: '#BA854A', shape: { kind: 'box', offset: { x: 0, y: 0, z: 0 }, size: { x: 6, y: 1, z: 6 } } },
    { op: 'define_part', part: { id: 'boat-mast', name: '桅杆', role: 'detail', origin, groupId: 'boat' } },
    { op: 'fill_shape', partId: 'boat-mast', color: '#BA854A', shape: { kind: 'box', offset: { x: 2, y: 1, z: 2 }, size: { x: 1, y: 7, z: 1 } } },
    { op: 'define_part', part: { id: 'boat-sail', name: '帆', role: 'detail', origin, groupId: 'boat' } },
    { op: 'patch_cells', partId: 'boat-sail', cells: [{ cell: { x: 0, y: 3, z: 0 }, color: '#FFFFFF' }] },
    { op: 'define_part', part: { id: 'boat-rudder', name: '船舵', role: 'detail', origin, groupId: 'boat' } },
    { op: 'patch_cells', partId: 'boat-rudder', cells: [{ cell: { x: 6, y: 0, z: 3 }, color: '#BA854A' }] },
  ];
  const layers = (fixed: boolean): SceneBatch['operations'][number] => ({ op: 'write_layers', partId: 'boat-sail',
    offset: { x: 0, y: 0, z: 0 }, mode: 'add', palette: [{ symbol: 'S', color: '#FFFFFF' }],
    layers: [4, 5, 6, 7].map(y => ({ y, rows: ['SSSSSS', 'SSSSSS', fixed ? 'SS.SSS' : 'SSSSSS', 'SSSSSS', 'SSSSSS', 'SSSSSS'] })) });
  const before = JSON.stringify(snapshot);
  let calls = 0;
  const providers = createProviders(config, async (_url, init) => {
    calls++;
    if (calls === 2) {
      const body = JSON.parse(String(init?.body)) as Body;
      const feedback = JSON.parse(body.messages.at(-1)!.content!) as { error: PlanDiagnostic; instruction: string; originalRequest: string };
      const diagnostic = feedback.error;
      assert.equal(diagnostic.operationIndex, 10);
      assert.equal(diagnostic.code, 'COLLISION');
      assert.equal(diagnostic.conflict!.source, 'before-failed-operation');
      assert.equal(diagnostic.conflict!.boundsAreSolid, false);
      assert.deepEqual(diagnostic.conflict!.cell, { x: 22, y: 5, z: 14 });
      const blocker = diagnostic.conflict!.occupiedBy!;
      assert.equal(blocker.partId, 'boat-mast'); assert.equal(blocker.voxelCount, 7);
      assert.deepEqual(blocker.worldBounds, { min: { x: 22, y: 2, z: 14 }, max: { x: 22, y: 8, z: 14 } });
      assert.deepEqual(blocker.localBounds, { min: { x: 2, y: 1, z: 2 }, max: { x: 2, y: 7, z: 2 } });
      assert.deepEqual(blocker.localCell, { x: 2, y: 4, z: 2 });
      assert.equal(blocker.occupancy.complete, true); assert.equal(blocker.occupancy.truncated, false);
      assert.equal(blocker.occupancy.returnedVoxelCount, 7);
      assert.deepEqual(blocker.occupancy.runs.filter(run => run.y >= 5).map(run => run.y), [5, 6, 7, 8]);
      const target = diagnostic.conflict!.targetPart!;
      assert.equal(target.partId, 'boat-sail'); assert.equal(target.voxelCount, 1);
      assert.deepEqual(target.worldBounds, { min: { x: 20, y: 4, z: 12 }, max: { x: 20, y: 4, z: 12 } });
      assert.deepEqual(target.localBounds, { min: { x: 0, y: 3, z: 0 }, max: { x: 0, y: 3, z: 0 } });
      assert.ok(!snapshot.parts.some(part => part.id === blocker.partId));
      assert.equal(feedback.originalRequest, input.text);
      assert.match(feedback.instruction, /整个重叠区域及所有相关层/);
    }
    return Response.json(completion(`multi-layer-${calls}`, 'apply_scene', { operations: [...prefix, layers(calls === 2)], reply }));
  });
  const plan = await providers.plan(input, new AbortController().signal);
  assert.equal(calls, 2); assert.equal(JSON.stringify(snapshot), before);
  assert.deepEqual(plan.batch!.operations.slice(0, prefix.length), prefix);
  const projected = VoxelEngine.fromSnapshot(snapshot).executeBatch(plan.batch!, input.requestId).snapshot;
  for (const voxel of snapshot.voxels) assert.deepEqual(projected.voxels.find(other => other.id === voxel.id), voxel);
  assert.equal(projected.voxels.filter(voxel => voxel.partId === 'lagoon').length - snapshot.voxels.filter(voxel => voxel.partId === 'lagoon').length, 42);
  assert.equal(projected.voxels.filter(voxel => voxel.partId === 'boat-mast').length, 7);
  assert.equal(projected.voxels.filter(voxel => voxel.partId === 'boat-sail').length, 141);
});

test('prefix blocker geometry discloses query-region and run-page truncation without replacing the collision', () => {
  const empty = new VoxelEngine().snapshot();
  const diagnose = (blockerWrites: SceneBatch['operations'], collision: { x: number; y: number; z: number }) => {
    const batch: SceneBatch = { protocolVersion: 1, baseRevision: empty.revision, operations: [
      { op: 'define_part', part: { id: 'blocker', name: '测试阻挡', role: 'other', origin: { x: 0, y: 0, z: 0 } } },
      ...blockerWrites,
      { op: 'define_part', part: { id: 'target', name: '测试目标', role: 'other', origin: { x: 0, y: 0, z: 0 } } },
      { op: 'patch_cells', partId: 'target', cells: [{ cell: collision, color: '#FFFFFF' }] },
    ] };
    let failure: unknown;
    try { VoxelEngine.fromSnapshot(empty).executeBatch(batch, 'bounded-prefix-test'); } catch (error) { failure = error; }
    const diagnostic = diagnoseBatchFailure(empty, batch, failure);
    assert.equal(diagnostic.code, 'COLLISION');
    assert.equal(diagnostic.conflict!.targetPart!.voxelCount, 0);
    assert.equal(diagnostic.conflict!.targetPart!.worldBounds, null);
    return diagnostic.conflict!.occupiedBy!;
  };
  const broad = diagnose([{ op: 'patch_cells', partId: 'blocker', cells: [
    { cell: { x: -100, y: 0, z: 0 }, color: '#FFFFFF' }, { cell: { x: 100, y: 0, z: 0 }, color: '#FFFFFF' },
  ] }], { x: -100, y: 0, z: 0 });
  assert.equal(broad.voxelCount, 2); assert.equal(broad.occupancy.matchedVoxelCount, 1);
  assert.equal(broad.occupancy.regionCoversWholePart, false); assert.equal(broad.occupancy.truncated, true);
  assert.equal(broad.occupancy.complete, false);
  assert.equal(broad.worldBounds!.max.x, 100); assert.ok(broad.occupancy.region.max.x < 100);
  const paged = diagnose([{ op: 'fill_shape', partId: 'blocker', color: '#FFFFFF', shape: {
    kind: 'box', offset: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 20, z: 20 },
  } }], { x: 0, y: 0, z: 0 });
  assert.equal(paged.voxelCount, 400); assert.equal(paged.occupancy.regionCoversWholePart, true);
  assert.equal(paged.occupancy.matchedVoxelCount, 400); assert.equal(paged.occupancy.returnedVoxelCount, 256);
  assert.equal(paged.occupancy.runs.length, 256); assert.equal(paged.occupancy.totalRunsInRegion, 400);
  assert.equal(paged.occupancy.complete, false); assert.equal(paged.occupancy.truncated, true);
});

test('prefix diagnosis retains the real cumulative batch-budget failure and operation index', () => {
  const empty = new VoxelEngine().snapshot();
  const candidate: SceneBatch = { protocolVersion: 1, baseRevision: empty.revision, operations: [
    { op: 'define_part', part: { id: 'many', name: '额度验证', role: 'other', origin: { x: 0, y: 0, z: 0 } } },
    { op: 'fill_shape', partId: 'many', color: '#FFFFFF', shape: { kind: 'box', offset: { x: 0, y: 0, z: 0 }, size: { x: 20, y: 20, z: 20 } } },
    { op: 'fill_shape', partId: 'many', color: '#FFFFFF', shape: { kind: 'box', offset: { x: 21, y: 0, z: 0 }, size: { x: 20, y: 20, z: 20 } } },
    { op: 'patch_cells', partId: 'many', cells: [{ cell: { x: 42, y: 0, z: 0 }, color: '#FFFFFF' }] },
  ] };
  let caught: unknown;
  try { VoxelEngine.fromSnapshot(empty).executeBatch(candidate, 'budget-test'); } catch (error) { caught = error; }
  assert.ok(caught);
  const diagnostic = diagnoseBatchFailure(empty, candidate, caught);
  assert.equal(diagnostic.code, 'BATCH_BUDGET'); assert.equal(diagnostic.operationIndex, 3);
});

test('query validation and missing parts are repairable; the fifth query never executes', async () => {
  let calls = 0, trace: PlanTrace | undefined;
  const providers = createProviders(config, async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Body;
    calls++;
    if (calls === 1) return Response.json(completion('invalid-region', 'inspect_scene', { region: { min: region.max, max: region.min }, partId: null, offset: 0 }));
    if (calls === 2) {
      assert.equal(lastTool(body).error.code, 'INVALID_ARGUMENT');
      return Response.json(completion('missing-part', 'inspect_scene', { region, partId: 'does-not-exist', offset: 0 }));
    }
    if (calls === 3) assert.equal(lastTool(body).error.code, 'PART_NOT_FOUND');
    if (calls <= 5) return Response.json(completion(`read-${calls}`, 'inspect_scene', { region, partId: null, offset: 0 }));
    assert.equal(lastTool(body).error.code, 'QUERY_LIMIT');
    assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'apply_scene' } });
    return Response.json(completion('after-query-limit', 'apply_scene', { operations: repaired, reply }));
  });
  const plan = await providers.plan(input, new AbortController().signal, { onDiagnostics: value => { trace = value; } });
  assert.ok(plan.batch); assert.equal(calls, 6); assert.equal(trace!.queryCalls, 4);
});

test('tool protocol errors are bounded by six model calls, with original IDs acknowledged but no execution', async () => {
  let calls = 0;
  const providers = createProviders(config, async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body)) as Body;
    if (calls > 1) assert.equal(body.messages.at(-1)!.tool_call_id, `second-${calls - 1}`);
    return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
      tool(`first-${calls}`, 'apply_scene', { operations: repaired, reply }), tool(`second-${calls}`, 'inspect_scene', { region, partId: null, offset: 0 }),
    ] } }] });
  });
  await assert.rejects(providers.plan(input, new AbortController().signal), (error: unknown) => error instanceof ApiError && error.code === 'PLAN_MULTIPLE_TOOLS');
  assert.equal(calls, 6);
});

test('cancellation after a failed preflight prevents another paid call and leaves input unchanged', async () => {
  const controller = new AbortController();
  let calls = 0;
  const before = JSON.stringify(snapshot);
  const providers = createProviders(config, async () => { calls++; return Response.json(completion('cancel-repair', 'apply_scene', { operations: bad, reply })); });
  await assert.rejects(providers.plan(input, controller.signal, { onDiagnostics(trace) { if (trace.failures.length) controller.abort(); } }),
    (error: unknown) => error instanceof ApiError && error.code === 'CANCELLED');
  assert.equal(calls, 1); assert.equal(JSON.stringify(snapshot), before);
});

test('network/access failures are not retried and plain completion after failed apply cannot claim success', async () => {
  for (const status of [401, 429, 503]) {
    let calls = 0;
    const providers = createProviders(config, async () => { calls++; return new Response('private-provider-body', { status }); });
    await assert.rejects(providers.plan(input, new AbortController().signal), (error: unknown) => error instanceof ApiError && !error.publicMessage.includes('private'));
    assert.equal(calls, 1);
  }
  let calls = 0;
  const providers = createProviders(config, async () => {
    calls++;
    return Response.json(calls === 1 ? completion('failed-before-text', 'apply_scene', { operations: bad, reply })
      : { choices: [{ finish_reason: 'stop', message: { content: reply } }] });
  });
  await assert.rejects(providers.plan(input, new AbortController().signal), (error: unknown) => error instanceof ApiError && error.code === 'PLAN_COLLISION');
  assert.equal(calls, 2);
});
