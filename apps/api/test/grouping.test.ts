import test from 'node:test';
import assert from 'node:assert/strict';
import { VoxelEngine } from '../../../packages/scene/src/index.ts';
import type { ChatRequest, SceneBatch } from '../../../packages/protocol/src/index.ts';
import { createProviders } from '../src/providers.ts';
import { ApiError } from '../src/errors.ts';
import { newPartGroupingIssue } from '../src/grouping.ts';
import type { ApiConfig } from '../src/config.ts';

// Local synthetic model fixtures only. No environment, real provider or persistent scene access.
const config: ApiConfig = {
  port: 4311, allowedOrigins: ['http://127.0.0.1:4310'],
  deepseek: { apiKey: 'fixture-only', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
  mimo: { apiKey: 'fixture-only', baseUrl: 'https://api.xiaomimimo.com/v1', asrModel: 'mimo-v2.5-asr', ttsModel: 'mimo-v2.5-tts', voice: 'mimo_default' },
};
const empty = new VoxelEngine().snapshot();
const input: ChatRequest = { requestId: 'fixture-group-plan', text: '搭两个独立的小物件', snapshot: empty, messages: [] };
const ungrouped: SceneBatch['operations'] = [
  { op: 'define_part', part: { id: 'same-prefix-a', name: '第一件主体', role: 'other', origin: { x: 0, y: 0, z: 0 } } },
  { op: 'patch_cells', partId: 'same-prefix-a', cells: [{ cell: { x: 0, y: 0, z: 0 }, color: '#AA3333' }] },
  { op: 'define_part', part: { id: 'same-prefix-b', name: '第二件主体', role: 'other', origin: { x: 4, y: 0, z: 0 } } },
  { op: 'patch_cells', partId: 'same-prefix-b', cells: [{ cell: { x: 0, y: 0, z: 0 }, color: '#3333AA' }] },
];
const grouped: SceneBatch['operations'] = [
  { op: 'define_group', group: { id: 'first-object', name: '第一件' } },
  { op: 'define_group', group: { id: 'second-object', name: '第二件' } },
  ...ungrouped.map(operation => operation.op === 'define_part'
    ? { ...operation, part: { ...operation.part, groupId: operation.part.id === 'same-prefix-a' ? 'first-object' : 'second-object' } }
    : operation),
];
interface ApplyFixture {
  operations: SceneBatch['operations'];
  creations?: Array<{ operations: SceneBatch['operations']; placement: { mode: 'absolute'; position: { x: number; y: number; z: number } } }>;
}
const groupedCreation: ApplyFixture = { operations: [], creations: [
  { operations: [grouped[0], ...grouped.slice(2, 4)], placement: { mode: 'absolute', position: { x: 0, y: 0, z: 0 } } },
  { operations: [grouped[1], ...grouped.slice(4)], placement: { mode: 'absolute', position: { x: 4, y: 0, z: 0 } } },
] };
function completion(args: ApplyFixture, id = 'group-tool') {
  return { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
    { id, type: 'function', function: { name: 'apply_scene', arguments: JSON.stringify({ ...args, reply: '两个小物件搭好啦。' }) } },
  ] } }] };
}

test('new AI parts require explicit groups and missing ownership can be corrected without merging independent objects', async () => {
  let calls = 0;
  const before = JSON.stringify(empty);
  const providers = createProviders(config, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); calls++;
    const schema = JSON.stringify(body.tools);
    for (const operation of ['define_group', 'assign_part_group', 'rename_group', 'translate_group', 'paint_group', 'remove_group']) assert.ok(schema.includes(operation));
    if (calls === 2) {
      const result = JSON.parse(body.messages.at(-1).content);
      assert.equal(result.error.code, 'GROUP_REQUIRED');
      assert.deepEqual(result.error.partIds, ['same-prefix-a', 'same-prefix-b']);
      assert.equal(result.error.partCount, 2); assert.equal(result.error.partIdsComplete, true);
      assert.equal(result.committed, false); assert.equal(result.originalRequest, input.text);
    }
    return Response.json(completion(calls === 1 ? { operations: ungrouped } : groupedCreation, `group-tool-${calls}`));
  });
  const plan = await providers.plan(input, new AbortController().signal);
  assert.equal(calls, 2); assert.equal(JSON.stringify(empty), before);
  const result = VoxelEngine.fromSnapshot(empty).executeBatch(plan.batch!, input.requestId).snapshot;
  assert.deepEqual(result.groups, [{ id: 'first-object', name: '第一件' }, { id: 'second-object', name: '第二件' }]);
  assert.equal(result.parts.find(part => part.id === 'same-prefix-a')!.groupId, 'first-object');
  assert.equal(result.parts.find(part => part.id === 'same-prefix-b')!.groupId, 'second-object');
});

test('repeated missing grouping stops within the existing three-plan budget', async () => {
  let calls = 0;
  const providers = createProviders(config, async () => { calls++; return Response.json(completion({ operations: ungrouped }, `missing-${calls}`)); });
  await assert.rejects(providers.plan(input, new AbortController().signal),
    (error: unknown) => error instanceof ApiError && error.code === 'PLAN_GROUP_REQUIRED');
  assert.equal(calls, 3);
});

test('new grouped parts can be freely created through raw operations without a placement template', async () => {
  let calls = 0;
  const providers = createProviders(config, async () => { calls++; return Response.json(completion({ operations: grouped }, `raw-grouped-${calls}`)); });
  const plan = await providers.plan(input, new AbortController().signal);
  assert.equal(calls, 1); assert.deepEqual(plan.batch!.operations, grouped);
  const result = VoxelEngine.fromSnapshot(empty).executeBatch(plan.batch!, input.requestId).snapshot;
  assert.equal(result.groups!.length, 2); assert.equal(result.voxels.length, 2);
});

test('legacy ungrouped parts can stay ungrouped or be explicitly assigned without a second grouping rule', async () => {
  const legacy = VoxelEngine.fromSnapshot(empty).executeBatch({ protocolVersion: 1, baseRevision: empty.revision, operations: ungrouped }, 'legacy-scene').snapshot;
  const batch: SceneBatch = { protocolVersion: 1, baseRevision: legacy.revision, operations: [
    { op: 'paint_part', partId: 'same-prefix-a', color: '#33AA33', region: null },
    { op: 'define_group', group: { id: 'only-second', name: '归组的旧物件' } },
    { op: 'assign_part_group', partId: 'same-prefix-b', groupId: 'only-second' },
  ] };
  const result = VoxelEngine.fromSnapshot(legacy).executeBatch(batch, 'legacy-edit').snapshot;
  assert.equal(newPartGroupingIssue(legacy, result, batch), undefined);
  assert.equal(result.parts[0].groupId ?? null, null);
  assert.equal(result.parts[1].groupId, 'only-second');
  let calls = 0;
  const providers = createProviders(config, async () => { calls++; return Response.json(completion({ operations: batch.operations })); });
  const plan = await providers.plan({ ...input, snapshot: legacy, text: '把第一件改绿，第二件归到一个组里' }, new AbortController().signal);
  assert.equal(calls, 1);
  assert.deepEqual(plan.batch, batch);
});

test('new ungrouped identities cannot evade validation by clearing or removing old identities first', () => {
  const base = VoxelEngine.fromSnapshot(empty).executeBatch({ protocolVersion: 1, baseRevision: empty.revision, operations: ungrouped }, 'old-identities').snapshot;
  for (const remove of [{ op: 'clear_scene', name: '新作品' }, { op: 'remove_part', partId: 'same-prefix-a' }] satisfies SceneBatch['operations']) {
    const batch: SceneBatch = { protocolVersion: 1, baseRevision: base.revision, operations: [remove, ...ungrouped.slice(0, 2)] };
    const result = VoxelEngine.fromSnapshot(base).executeBatch(batch, `recreate-${remove.op}`).snapshot;
    assert.deepEqual(newPartGroupingIssue(base, result, batch)?.partIds, ['same-prefix-a']);
  }
});

test('detached legacy members survive group removal; recreated members need valid ownership', () => {
  const base = VoxelEngine.fromSnapshot(empty).executeBatch({ protocolVersion: 1, baseRevision: empty.revision, operations: grouped }, 'initial-groups').snapshot;
  const keep: SceneBatch = { protocolVersion: 1, baseRevision: base.revision, operations: [
    { op: 'assign_part_group', partId: 'same-prefix-a', groupId: null }, { op: 'remove_group', groupId: 'first-object' },
  ] };
  assert.equal(newPartGroupingIssue(base, VoxelEngine.fromSnapshot(base).executeBatch(keep, 'detach').snapshot, keep), undefined);
  const replace: SceneBatch = { protocolVersion: 1, baseRevision: base.revision, operations: [
    { op: 'remove_group', groupId: 'first-object' }, ...ungrouped.slice(0, 2),
  ] };
  assert.deepEqual(newPartGroupingIssue(base, VoxelEngine.fromSnapshot(base).executeBatch(replace, 'replace').snapshot, replace)?.partIds, ['same-prefix-a']);
  const redefineThenReplace: SceneBatch = { ...replace, operations: [ungrouped[0], ...replace.operations] };
  assert.deepEqual(newPartGroupingIssue(base, VoxelEngine.fromSnapshot(base).executeBatch(redefineThenReplace, 'redefine-replace').snapshot, redefineThenReplace)?.partIds, ['same-prefix-a']);
});

test('prefab automatic groups pass the same server rule without model-supplied manual membership', async () => {
  const operations: SceneBatch['operations'] = [{ op: 'add_prefab', prefab: 'tree', id: 'tree-one', name: '小树', origin: { x: 0, y: 0, z: 0 } }];
  const providers = createProviders(config, async () => Response.json(completion({ operations: [], creations: [{ operations,
    placement: { mode: 'absolute', position: { x: -3, y: 0, z: -2 } },
  }] })));
  const plan = await providers.plan({ ...input, text: '种一棵树' }, new AbortController().signal);
  const result = VoxelEngine.fromSnapshot(empty).executeBatch(plan.batch!, input.requestId).snapshot;
  assert.deepEqual(result.groups, [{ id: 'tree-one', name: '小树' }]);
  assert.ok(result.parts.length > 1); assert.ok(result.parts.every(part => part.groupId === 'tree-one'));
  assert.deepEqual(plan.batch!.operations, operations);
});
