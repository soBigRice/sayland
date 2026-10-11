import test from 'node:test';
import assert from 'node:assert/strict';
import { VoxelEngine } from '../../../packages/scene/src/index.ts';
import type { ChatRequest, SceneBatch } from '../../../packages/protocol/src/index.ts';
import type { ApiConfig } from '../src/config.ts';
import { compileCreation } from '../src/layout.ts';
import { createProviders } from '../src/providers.ts';
import { ApiError, type PlanTrace } from '../src/errors.ts';
const config: ApiConfig = { port: 4311, allowedOrigins: [], deepseek: { apiKey: 'fixture', baseUrl: 'https://fixture.invalid', model: 'deepseek-flash' },
  mimo: { apiKey: '', baseUrl: '', asrModel: '', ttsModel: '', voice: '' } };
const snapshot = new VoxelEngine().snapshot();
const input: ChatRequest = { requestId: 'fixture-progressive', text: '搭机器人', snapshot, messages: [] };
const body: SceneBatch['operations'] = [
  { op: 'define_group', group: { id: 'robot', name: '机器人' } },
  { op: 'define_part', part: { id: 'body', name: '身体', role: 'other', groupId: 'robot', origin: { x: 0, y: 0, z: 0 } } },
  { op: 'patch_cells', partId: 'body', cells: [{ cell: { x: 0, y: 0, z: 0 }, color: '#44AAFF' }] },
];
const creation = { creations: [{ operations: body, placement: { mode: 'absolute', position: { x: 0, y: 0, z: 0 } } }], reply: '身体好了。' };
const details = { operations: [
  { op: 'define_part', part: { id: 'head', name: '头', role: 'detail', groupId: 'robot', origin: { x: 0, y: 1, z: 0 } } },
  { op: 'patch_cells', partId: 'head', cells: [{ cell: { x: 0, y: 0, z: 0 }, color: '#FFAA44' }] },
], reply: '头好了。' };
const call = (name: string, args: unknown, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
function tool(name: string, args: unknown, id = name) { return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { reasoning_content: `private-${id}`, content: null, tool_calls: [call(name, args, id)] } }] }); }
function done() { return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '机器人完成啦。', reasoning_content: 'private-final' } }] }); }

test('real provider commits then reads current region/views, retains reasoning internally and continues the SAME anchored group', async () => {
  const engine = VoxelEngine.fromSnapshot(snapshot); let calls = 0, commits = 0; let trace: PlanTrace | undefined;
  const providers = createProviders(config, async (_url, init) => {
    const request = JSON.parse(String(init?.body)); calls++;
    assert.equal(request.stream, true); assert.equal(request.max_tokens, 32768); assert.equal(request.tool_choice, 'auto');
    if (calls === 1) return tool('apply_scene', creation, 'body-1');
    assert.ok(request.messages.some((message: { reasoning_content?: string }) => message.reasoning_content === 'private-body-1'));
    if (calls === 2) {
      assert.equal(commits, 1); assert.equal(JSON.parse(request.messages.findLast((message: { role: string }) => message.role === 'tool').content).revision, 1);
      return tool('read_region', { revision: 1, partId: 'body', region: null });
    }
    if (calls === 3) {
      const read = JSON.parse(request.messages.at(-1).content).result; assert.equal(read.complete, true); assert.equal(read.count, 1);
      return tool('get_views', { revision: 1, groupIds: ['robot'], partIds: null, region: null });
    }
    if (calls === 4) {
      const image = request.messages.at(-1).content.find((part: { type: string }) => part.type === 'image_url'); assert.match(image.image_url.url, /^data:image\/png;base64,/);
      return tool('apply_scene', details, 'head-2');
    }
    assert.equal(calls, 5); assert.equal(commits, 2);
    const currentImages = request.messages.filter((message: { content: unknown }) => Array.isArray(message.content));
    assert.equal(currentImages.length, 1, 'ACK must replace old views with the newly committed object');
    assert.match(currentImages[0].content[0].text, /"revision":2/);
    const oldView = request.messages.find((message: { tool_call_id?: string }) => message.tool_call_id === 'get_views');
    assert.equal(JSON.parse(oldView.content).archived, true);
    return done();
  });
  const result = await providers.plan(input, new AbortController().signal, { onDiagnostics: value => { trace = value; },
    commitBatch: async batch => engine.executeBatch(batch, `batch-${++commits}`, input.requestId).snapshot });
  assert.deepEqual(result, { reply: '机器人完成啦。' });
  assert.equal(engine.snapshot().groups!.length, 1); assert.equal(engine.snapshot().parts.length, 2);
  assert.equal(engine.snapshot().voxels[0].cell.y, 0); assert.equal(engine.snapshot().voxels[1].cell.y, 1);
  assert.equal(trace!.committedBatches, 2); assert.equal(trace!.readRegionCalls, 1); assert.equal(trace!.viewCalls, 1); assert.equal(trace!.currentRevision, 2);
  assert.ok(!JSON.stringify(trace).includes('private')); assert.ok(!JSON.stringify(trace).includes('base64'));
});

test('only real advanced ACK resets consecutive failures; queries and empty edits cannot extend the repair budget', async () => {
  let calls = 0; let commits = 0; const engine = VoxelEngine.fromSnapshot(snapshot);
  const providers = createProviders(config, async () => {
    calls++;
    if ([1, 2, 4, 5].includes(calls)) return tool('apply_scene', { operations: [{ op: 'paint_part', partId: 'missing', color: '#FFFFFF', region: null }], reply: 'fixture' });
    if (calls === 3) return tool('apply_scene', creation);
    if (calls === 6) return tool('apply_scene', details);
    return done();
  });
  await providers.plan(input, new AbortController().signal, { commitBatch: async batch => engine.executeBatch(batch, `batch-${++commits}`, input.requestId).snapshot });
  assert.equal(commits, 2); assert.equal(calls, 7);
  calls = 0; commits = 0;
  const noProgress = createProviders(config, async () => {
    calls++;
    if (calls === 2) return tool('inspect_scene', { region: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }, partId: null, offset: 0 });
    return tool('apply_scene', { operations: [], reply: '没有改变' });
  });
  await assert.rejects(noProgress.plan(input, new AbortController().signal, { commitBatch: async () => { commits++; return snapshot; } }), error => error instanceof ApiError && error.code === 'PLAN_EMPTY_EDIT');
  assert.equal(calls, 4); assert.equal(commits, 0);
});

test('cancellation while awaiting commit makes no further paid call even when receipt arrives later', async () => {
  let calls = 0, resolveCommit!: (snapshot: typeof input.snapshot) => void; const controller = new AbortController();
  const providers = createProviders(config, async () => { calls++; return tool('apply_scene', creation); });
  const pending = providers.plan(input, controller.signal, { commitBatch: () => new Promise(resolve => { resolveCommit = resolve; controller.abort(); }) });
  await assert.rejects(pending, error => error instanceof ApiError && error.code === 'CANCELLED');
  resolveCommit(VoxelEngine.fromSnapshot(snapshot).executeBatch({ protocolVersion: 1, baseRevision: snapshot.revision, operations: body }, 'late').snapshot);
  assert.equal(calls, 1);
});

test('view feedback must be observed on a later model call before a following apply in the same response can run', async () => {
  const engine = VoxelEngine.fromSnapshot(snapshot); let calls = 0, commits = 0;
  const providers = createProviders(config, async (_url, init) => {
    calls++;
    if (calls === 1) return tool('apply_scene', creation);
    if (calls === 2) return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [
      call('get_views', { revision: 1, groupIds: ['robot'], partIds: null, region: null }), call('apply_scene', details),
    ] } }] });
    if (calls === 3) { const request = JSON.parse(String(init?.body)); assert.equal(commits, 1); assert.ok(JSON.stringify(request.messages).includes('VIEW_BEFORE_EDIT')); return tool('apply_scene', details); }
    return done();
  });
  await providers.plan(input, new AbortController().signal, { commitBatch: async batch => engine.executeBatch(batch, `batch-${++commits}`, input.requestId).snapshot });
  assert.equal(commits, 2); assert.equal(calls, 4);
});

test('read-only loops stop at 24 model calls and at 64 tools without resetting the shared budget', async () => {
  for (const count of [1, 8]) {
    let calls = 0, trace: PlanTrace | undefined;
    const providers = createProviders(config, async () => {
      calls++; return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: Array.from({ length: count }, (_, i) => call('inspect_scene', {
        region: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }, partId: null, offset: 0,
      }, `query-${calls}-${i}`)) } }] });
    });
    await assert.rejects(providers.plan(input, new AbortController().signal, { onDiagnostics: value => { trace = value; } }), error => error instanceof ApiError && error.code === (count === 1 ? 'PLAN_PLANNING_LIMIT' : 'PLAN_TOOL_LIMIT'));
    assert.equal(calls, count === 1 ? 24 : 9); assert.equal(trace!.queryCalls, count === 1 ? 24 : 64);
  }
});

test('only the next truncated-output recovery uses 65536 tokens; later batches return to 32768', async () => {
  let calls = 0; let trace: PlanTrace | undefined; const budgets: number[] = []; const engine = VoxelEngine.fromSnapshot(snapshot);
  const providers = createProviders(config, async (_url, init) => {
    const request = JSON.parse(String(init?.body)); budgets.push(request.max_tokens); calls++;
    if (calls === 1) return Response.json({ choices: [{ finish_reason: 'length', message: { content: null } }] });
    if (calls === 2) return tool('apply_scene', creation);
    return done();
  });
  await providers.plan(input, new AbortController().signal, { onDiagnostics: value => { trace = value; }, commitBatch: async batch => engine.executeBatch(batch, 'recovered-batch', input.requestId).snapshot });
  assert.deepEqual(budgets, [32768, 65536, 32768]); assert.equal(calls, 3);
  assert.deepEqual(trace!.failures[0].budget, { scope: 'tokens', unit: 'tokens', limit: 32768, modelCall: 1 });
});

test('content overflow retries only the uncommitted batch without increasing tokens or replaying confirmed edits', async () => {
  const engine = VoxelEngine.fromSnapshot(snapshot); let calls = 0, commits = 0; let trace: PlanTrace | undefined;
  const providers = createProviders(config, async (_url, init) => {
    const request = JSON.parse(String(init?.body)); assert.equal(request.max_tokens, 32768); calls++;
    if (calls === 1) return tool('apply_scene', creation);
    if (calls === 2) return Response.json({ choices: [{ finish_reason: 'tool_calls', message: {
      tool_calls: [call('apply_scene', details)], reasoning_content: 'x'.repeat(4 * 1024 * 1024),
    } }] });
    if (calls === 3) {
      assert.equal(commits, 1); assert.equal(engine.snapshot().parts.length, 1);
      assert.ok(!JSON.stringify(request.messages).includes('xxxx'), 'oversized response must not enter history');
      return tool('apply_scene', details);
    }
    return done();
  });
  await providers.plan(input, new AbortController().signal, { onDiagnostics: value => { trace = value; },
    commitBatch: async batch => engine.executeBatch(batch, `content-recovery-${++commits}`, input.requestId).snapshot });
  assert.equal(calls, 4); assert.equal(commits, 2); assert.equal(engine.snapshot().parts.length, 2);
  const diagnostic = trace!.failures[0]; assert.equal(diagnostic.code, 'OUTPUT_BUDGET');
  assert.equal(diagnostic.budget!.scope, 'content'); assert.equal(diagnostic.budget!.unit, 'bytes');
  assert.equal(diagnostic.budget!.modelCall, 2); assert.equal(diagnostic.budget!.limit, 4 * 1024 * 1024);
  assert.ok(diagnostic.budget!.observed! > diagnostic.budget!.limit!);
  assert.ok(JSON.stringify(trace).length < 1500);
  engine.undo(); assert.equal(engine.snapshot().voxels.length, 0);
});

test('repeated content overflow stops after two repairs and keeps previously confirmed batches', async () => {
  const engine = VoxelEngine.fromSnapshot(snapshot); let calls = 0, commits = 0;
  const providers = createProviders(config, async () => {
    if (++calls === 1) return tool('apply_scene', creation);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'x'.repeat(4 * 1024 * 1024 + 1) } }] });
  });
  await assert.rejects(providers.plan(input, new AbortController().signal, {
    commitBatch: async batch => engine.executeBatch(batch, `bounded-${++commits}`, input.requestId).snapshot,
  }), error => error instanceof ApiError && error.code === 'PLAN_OUTPUT_BUDGET');
  assert.equal(calls, 4); assert.equal(commits, 1); assert.equal(engine.snapshot().voxels.length, 1);
});

test('malformed response framing stops without another model call and preserves the confirmed batch', async () => {
  const engine = VoxelEngine.fromSnapshot(snapshot); let calls = 0, commits = 0;
  const providers = createProviders(config, async () => {
    if (++calls === 1) return tool('apply_scene', creation);
    return new Response(' '.repeat(8 * 1024 * 1024 + 1), { headers: { 'content-type': 'text/event-stream' } });
  });
  await assert.rejects(providers.plan(input, new AbortController().signal, {
    commitBatch: async batch => engine.executeBatch(batch, `frame-${++commits}`, input.requestId).snapshot,
  }), error => error instanceof ApiError && error.code === 'PLAN_RESPONSE_FRAME_BUDGET' && error.diagnostic?.budget?.modelCall === 2);
  assert.equal(calls, 2); assert.equal(commits, 1); assert.equal(engine.snapshot().voxels.length, 1);
});

test('a new same-revision view replaces the previous image and its scope metadata', async () => {
  let calls = 0; const engine = VoxelEngine.fromSnapshot(snapshot);
  const providers = createProviders(config, async (_url, init) => {
    calls++;
    if (calls === 1) return tool('apply_scene', creation);
    if (calls === 2) return tool('get_views', { revision: 1, groupIds: ['robot'], partIds: null, region: null }, 'view-group');
    if (calls === 3) return tool('get_views', { revision: 1, groupIds: null, partIds: ['body'], region: null }, 'view-part');
    const request = JSON.parse(String(init?.body));
    const images = request.messages.filter((message: { content: unknown }) => Array.isArray(message.content));
    assert.equal(images.length, 1);
    const oldView = request.messages.find((message: { tool_call_id?: string }) => message.tool_call_id === 'view-group');
    const currentView = request.messages.find((message: { tool_call_id?: string }) => message.tool_call_id === 'view-part');
    assert.equal(JSON.parse(oldView.content).archived, true); assert.equal(JSON.parse(currentView.content).result.revision, 1);
    return done();
  });
  await providers.plan(input, new AbortController().signal, { commitBatch: async batch => engine.executeBatch(batch, 'view-batch', input.requestId).snapshot });
  assert.equal(calls, 4);
});


test('failed model-chosen expansion axis can be corrected without changing the user goal or old water', async () => {
  const engine = new VoxelEngine();
  const terrain = engine.executeBatch({ protocolVersion: 1, baseRevision: 0, operations: [
    { op: 'define_group', group: { id: 'terrain', name: '地形' } },
    { op: 'define_part', part: { id: 'soil', name: '土壤', role: 'terrain', groupId: 'terrain', origin: { x: 0, y: 0, z: 0 } } },
    { op: 'fill_shape', partId: 'soil', color: '#AA8855', shape: { kind: 'box', offset: { x: 0, y: 0, z: 0 }, size: { x: 6, y: 3, z: 8 } } },
  ] }, 'terrain-fixture').snapshot;
  const operations = compileCreation(terrain, [
    { op: 'define_group', group: { id: 'river', name: '河流' } },
    { op: 'define_part', part: { id: 'water', name: '河水', role: 'water', groupId: 'river', origin: { x: 0, y: 0, z: 0 } } },
    { op: 'fill_shape', partId: 'water', color: '#4488FF', shape: { kind: 'box', offset: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 1, z: 8 } } },
  ], { mode: 'in_surface', targetGroupId: 'terrain', depth: 2 });
  const before = engine.executeBatch({ protocolVersion: 1, baseRevision: terrain.revision, operations }, 'river-fixture').snapshot;
  let calls = 0;
  const providers = createProviders(config, async () => {
    calls++; return tool('apply_scene', { surfaceEdits: [{ partId: 'water', amount: 1, axes: calls === 1 ? 'z' : 'x', terrainGroupId: 'terrain' }], reply: '河面扩大了。' });
  });
  const result = await providers.plan({ ...input, text: '河流的面积再大一点', snapshot: before }, new AbortController().signal);
  assert.equal(calls, 2);
  const after = engine.executeBatch(result.batch!, 'expanded').snapshot;
  const oldWater = before.voxels.filter(voxel => voxel.partId === 'water');
  assert.equal(after.voxels.filter(voxel => voxel.partId === 'water').length, oldWater.length + 16);
  const afterIds = new Map(after.voxels.map(voxel => [voxel.id, voxel]));
  for (const voxel of oldWater) assert.deepEqual(afterIds.get(voxel.id), voxel);
});
