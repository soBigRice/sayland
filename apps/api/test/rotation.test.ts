import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { VoxelEngine } from '../../../packages/scene/src/index.ts';
import { snapshotDigest, type AiOperation, type ChatRequest, type ScenePlan } from '../../../packages/protocol/src/index.ts';
import { createApp } from '../src/app.ts';
import { createProviders } from '../src/providers.ts';
import type { ApiConfig } from '../src/config.ts';

// Synthetic model responses only: no environment, provider request or user storage.
const config: ApiConfig = { port: 4311, allowedOrigins: [], deepseek: { apiKey: 'fixture', baseUrl: 'https://fixture.invalid', model: 'fixture' },
  mimo: { apiKey: 'fixture', baseUrl: 'https://fixture.invalid', asrModel: 'fixture', ttsModel: 'fixture', voice: 'fixture' } };
const headers = { host: '127.0.0.1:4311', 'x-sayland-session': 'fixture-rotation-session' };
const rotation = { op: 'rotate_group', groupId: 'boat', axis: 'y', quarterTurns: 1, pivot: { x: 11, y: 0, z: 11 } } as const;
function scene(blocked = false) {
  const engine = new VoxelEngine();
  engine.executeBatch({ protocolVersion: 1, baseRevision: 0, operations: [
    { op: 'define_group', group: { id: 'boat', name: '小船' } },
    { op: 'define_part', part: { id: 'hull', name: '船身', role: 'other', groupId: 'boat', origin: { x: 10, y: 2, z: 10 } } },
    { op: 'patch_cells', partId: 'hull', cells: [
      { cell: { x: 0, y: 0, z: 0 }, color: '#AA4400' }, { cell: { x: 1, y: 0, z: 0 }, color: '#FF9900' },
    ] },
    { op: 'define_part', part: { id: 'sail', name: '船帆', role: 'detail', groupId: 'boat', origin: { x: 10, y: 3, z: 10 } } },
    { op: 'patch_cells', partId: 'sail', cells: [{ cell: { x: 0, y: 0, z: 0 }, color: '#FFFFFF' }] },
    { op: 'define_part', part: { id: 'neighbor', name: '旁边物件', role: 'other', origin: { x: blocked ? 10 : 20, y: 2, z: 11 } } },
    { op: 'patch_cells', partId: 'neighbor', cells: [{ cell: { x: 0, y: 0, z: 0 }, color: '#00AA00' }] },
  ] }, 'rotation-fixture');
  return engine;
}
function tool(operation: AiOperation) {
  return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
    { id: crypto.randomUUID(), type: 'function', function: { name: 'apply_scene', arguments: JSON.stringify({ operations: [operation], reply: '小船转了90度。' }) } },
  ] } }] });
}

test('AI group rotation travels through planning, local commit and exact ACK before final success', async t => {
  const engine = scene(), before = engine.snapshot();
  const input: ChatRequest = { requestId: 'fixture-boat-rotation', text: '让小船转一下', snapshot: before, messages: [] };
  let calls = 0;
  const providers = createProviders(config, async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    if (calls === 1) {
      const schema = JSON.stringify(body.tools);
      for (const name of ['rotate_group', 'rotate_part', 'quarterTurns', 'pivot']) assert.ok(schema.includes(name));
      return tool(rotation);
    }
    assert.equal(calls, 2);
    const receipt = JSON.parse(body.messages.at(-1).content);
    assert.equal(receipt.committed, true); assert.equal(receipt.revision, before.revision + 1);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '小船已经水平转了90度。' } }] });
  });
  const app = createApp(config, { providers });
  t.after(() => app.close());
  const response = app.inject({ method: 'POST', url: '/api/chat', headers, payload: input }).then(value => value);
  let plan: ScenePlan | undefined;
  for (let i = 0; i < 100 && !plan; i++) {
    const state = (await app.inject({ method: 'GET', url: `/api/turns/${input.requestId}`, headers })).json();
    assert.ok(!['failed', 'cancelled'].includes(state.status), JSON.stringify(state));
    plan = state.plan;
    if (!plan) await setImmediate();
  }
  assert.ok(plan?.batch && plan.batchId);
  assert.deepEqual(plan.batch.operations, [rotation]); assert.equal(calls, 1);
  const after = engine.executeBatch(plan.batch, plan.batchId, input.requestId).snapshot;
  const positions = [{ x: 10, y: 2, z: 11 }, { x: 10, y: 2, z: 10 }, { x: 10, y: 3, z: 11 }, { x: 20, y: 2, z: 11 }];
  assert.deepEqual(after.voxels.toSorted((a, b) => a.id - b.id), before.voxels.map((voxel, index) => ({ ...voxel, cell: positions[index] })));
  const payload = { batchId: plan.batchId, revision: after.revision, digest: await snapshotDigest(after) };
  const ack = await app.inject({ method: 'POST', url: `/api/turns/${input.requestId}/ack`, headers, payload });
  assert.equal(ack.statusCode, 200, ack.body);
  const final = await response;
  assert.equal(calls, 2); assert.ok(final.body.includes('event: reply')); assert.ok(final.body.includes('"status":"replied"'));
  assert.equal((await app.inject({ method: 'POST', url: `/api/turns/${input.requestId}/ack`, headers, payload })).statusCode, 200);
  engine.undo();
  assert.deepEqual(engine.snapshot().voxels.toSorted((a, b) => a.id - b.id), before.voxels);
  assert.deepEqual(engine.snapshot().parts, before.parts);
});

test('AI can rotate one part without modifying its sibling or group membership', async () => {
  const engine = scene(), before = engine.snapshot();
  const operation = { op: 'rotate_part', partId: 'sail', axis: 'y', quarterTurns: -1, pivot: rotation.pivot } as const;
  const provider = createProviders(config, async () => tool(operation));
  const plan = await provider.plan({ requestId: 'fixture-sail-rotation', text: '只把船帆转90度', snapshot: before, messages: [] }, new AbortController().signal);
  assert.deepEqual(plan.batch!.operations, [operation]);
  const after = engine.executeBatch(plan.batch, 'fixture-sail-rotation').snapshot;
  assert.deepEqual(after.voxels.toSorted((a, b) => a.id - b.id), before.voxels.map(voxel => voxel.partId === 'sail'
    ? { ...voxel, cell: { x: 11, y: 3, z: 10 } } : voxel));
  assert.deepEqual(after.groups, before.groups);
  assert.deepEqual(after.parts.filter(part => part.id !== 'sail'), before.parts.filter(part => part.id !== 'sail'));
});

test('AI receives the rejected rotation and blocker, then can correct the uncommitted direction', async () => {
  const engine = scene(true), before = engine.serialize();
  let calls = 0;
  const provider = createProviders(config, async (_url, init) => {
    if (++calls === 1) return tool(rotation);
    const body = JSON.parse(String(init?.body));
    const result = JSON.parse(body.messages.at(-1).content);
    assert.equal(result.committed, false); assert.equal(result.error.code, 'COLLISION');
    assert.equal(result.error.operation.op, 'rotate_group');
    assert.deepEqual(result.error.operation.pivot, rotation.pivot);
    assert.ok(JSON.stringify(result.error).includes('neighbor'));
    return tool({ ...rotation, quarterTurns: -1 });
  });
  const plan = await provider.plan({ requestId: 'fixture-rotation-correction', text: '小船转一下', snapshot: engine.snapshot(), messages: [] }, new AbortController().signal);
  assert.equal(calls, 2); assert.deepEqual(engine.serialize(), before);
  assert.deepEqual(plan.batch!.operations, [{ ...rotation, quarterTurns: -1 }]);
  const after = engine.executeBatch(plan.batch, 'fixture-rotation-correction').snapshot;
  assert.deepEqual(after.voxels.find(voxel => voxel.partId === 'neighbor'), before.snapshot.voxels.find(voxel => voxel.partId === 'neighbor'));
});
