import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviders } from '../src/providers.ts';
import { createInitialScene, VoxelEngine } from '../../../packages/scene/src/index.ts';
import type { ApiConfig } from '../src/config.ts';
import type { AiOperation, ChatRequest } from '../../../packages/protocol/src/index.ts';

const config: ApiConfig = {
  port: 4311, allowedOrigins: ['http://127.0.0.1:4310'],
  deepseek: { apiKey: 'fixture', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' },
  mimo: { apiKey: '', baseUrl: 'https://api.xiaomimimo.com/v1', asrModel: '', ttsModel: '', voice: '' },
};
const initial = createInitialScene();
const input: ChatRequest = { requestId: 'layout-fixture-river', text: '在小岛上加一条小河', snapshot: initial, messages: [] };
const river: AiOperation[] = [
  { op: 'define_group', group: { id: 'stream', name: '岛内小河' } },
  { op: 'define_part', part: { id: 'stream-water', name: '河水', role: 'water', groupId: 'stream', origin: { x: 0, y: 0, z: 0 } } },
  { op: 'fill_shape', partId: 'stream-water', shape: { kind: 'box', offset: { x: 0, y: 0, z: 0 }, size: { x: 12, y: 1, z: 2 } }, color: '#42BFE1' },
];
const riverArgs = { operations: [], creations: [{ operations: river, placement: { mode: 'in_surface', targetGroupId: 'island-terrain', depth: 2 } }], reply: '岛内的小河搭好啦。' };
const tool = (name: string, args: unknown) => Response.json({ choices: [{ finish_reason: 'tool_calls', message: {
  content: null, tool_calls: [{ id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
} }] });

test('a fluent non-action reply cannot swallow an explicit edit: intent check, layout, then real terrain replacement', async () => {
  let calls = 0; const billed: number[] = [];
  const provider = createProviders(config, async (_url, init) => {
    calls++; const body = JSON.parse(String(init?.body));
    if (calls === 1) return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '已经有河了，要新增还是修改？' } }] });
    if (calls === 2) {
      assert.equal(body.tool_choice.function.name, 'classify_intent');
      assert.ok(JSON.stringify(body.messages).length < 5000);
      return tool('classify_intent', { kind: 'edit', reply: '' });
    }
    assert.equal(body.tool_choice, 'auto');
    assert.ok(JSON.stringify(body.messages).includes('必须调用工具实际编辑'));
    return tool('apply_scene', riverArgs);
  });
  const result = await provider.plan(input, new AbortController().signal, { beforeModelCall: n => billed.push(n) });
  assert.deepEqual(billed, [1, 2, 3]); assert.ok(result.batch);
  const engine = VoxelEngine.fromSnapshot(initial); const after = engine.executeBatch(result.batch, input.requestId).snapshot;
  const water = after.voxels.filter(v => v.partId === 'stream-water'); assert.equal(water.length, 24);
  const terrain = new Set(initial.parts.filter(p => p.role === 'terrain').map(p => p.id));
  const beforeCells = new Map(initial.voxels.map(v => [`${v.cell.x},${v.cell.y},${v.cell.z}`, v]));
  const afterIds = new Map(after.voxels.map(v => [v.id, v]));
  for (const v of water) {
    assert.ok(terrain.has(beforeCells.get(`${v.cell.x},${v.cell.y},${v.cell.z}`)!.partId));
    assert.ok(after.voxels.some(b => b.cell.x === v.cell.x && b.cell.z === v.cell.z && b.cell.y === v.cell.y - 1));
    assert.ok(!after.voxels.some(b => b.cell.x === v.cell.x && b.cell.z === v.cell.z && b.cell.y > v.cell.y));
  }
  for (const v of initial.voxels.filter(v => !terrain.has(v.partId))) assert.deepEqual(afterIds.get(v.id), v);
  assert.ok(initial.voxels.some(v => !afterIds.has(v.id)), '河道必须实际替换地形，不能在岛外添水');
  engine.undo();
  const restored = new Map(engine.snapshot().voxels.map(v => [v.id, v]));
  assert.equal(restored.size, initial.voxels.length);
  for (const voxel of initial.voxels) assert.deepEqual(restored.get(voxel.id), voxel);
});

test('pure conversation retains the main thinking answer after the bounded intent check', async () => {
  let calls = 0;
  const provider = createProviders(config, async () => ++calls === 1
    ? Response.json({ choices: [{ finish_reason: 'stop', message: { content: '你好！' } }] })
    : tool('classify_intent', { kind: 'chat', reply: '你好，一起来搭小岛吧！' }));
  assert.deepEqual(await provider.plan({ ...input, text: '你好' }, new AbortController().signal), { reply: '你好！' });
  assert.equal(calls, 2);
});

test('cancellation during intent check stops before another paid call or edit', async () => {
  const controller = new AbortController(); let calls = 0;
  const provider = createProviders(config, async () => {
    calls++;
    if (calls === 1) return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '要新增吗？' } }] });
    controller.abort(); return tool('classify_intent', { kind: 'edit', reply: '' });
  });
  await assert.rejects(provider.plan(input, controller.signal)); assert.equal(calls, 2);
});

test('a failed model-selected movement may choose a new feasible direction during repair', async () => {
  let calls = 0;
  const provider = createProviders(config, async () => {
    calls++;
    return tool('apply_scene', { operations: [{ op: 'translate_group', groupId: 'home', delta: calls === 1 ? { x: 0, y: -1, z: 0 } : { x: 0, y: 25, z: 0 } }], reply: '房子移到空中啦。' });
  });
  const plan = await provider.plan({ ...input, text: '把房子挪到一块空地方，悬空也可以' }, new AbortController().signal);
  assert.equal(calls, 2);
  const after = VoxelEngine.fromSnapshot(initial).executeBatch(plan.batch!, input.requestId).snapshot;
  const members = new Set(initial.parts.filter(part => part.groupId === 'home').map(part => part.id));
  const actual = new Map(after.voxels.map(voxel => [voxel.id, voxel]));
  for (const voxel of initial.voxels) assert.deepEqual(actual.get(voxel.id), members.has(voxel.partId) ? { ...voxel, cell: { ...voxel.cell, y: voxel.cell.y + 25 } } : voxel);
});

test('layout schema uses shared references instead of duplicating the complete operation vocabulary', async () => {
  const provider = createProviders(config, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); const schema = body.tools[0].function.parameters;
    assert.ok(schema.$defs); assert.ok(JSON.stringify(schema).includes('$ref'));
    return tool('apply_scene', riverArgs);
  });
  assert.ok((await provider.plan(input, new AbortController().signal)).batch);
});

test('raw grouped creation can float outside the island without placement, reading or views', async () => {
  let calls = 0;
  const operations = river.map(op => op.op === 'define_part' ? { ...op, part: { ...op.part, origin: { x: 50, y: 25, z: 50 } } } : op);
  const provider = createProviders(config, async () => { calls++; return tool('apply_scene', { operations, reply: '空中的水体搭好了。' }); });
  const plan = await provider.plan({ ...input, text: '在岛外空中搭一个自由水体' }, new AbortController().signal);
  assert.equal(calls, 1); assert.deepEqual(plan.batch!.operations, operations);
  const after = VoxelEngine.fromSnapshot(initial).executeBatch(plan.batch!, input.requestId).snapshot;
  const water = after.voxels.filter(voxel => voxel.partId === 'stream-water');
  assert.equal(water.length, 24); assert.ok(water.every(voxel => voxel.cell.x >= 50 && voxel.cell.y === 25 && voxel.cell.z >= 50));
  const afterIds = new Map(after.voxels.map(voxel => [voxel.id, voxel]));
  for (const voxel of initial.voxels) assert.deepEqual(afterIds.get(voxel.id), voxel);
});

test('optional absolute layout may repair its first self-chosen colliding position', async () => {
  let calls = 0;
  const provider = createProviders(config, async () => tool('apply_scene', {
    operations: [], creations: [{ operations: river, placement: { mode: 'absolute', position: ++calls === 1 ? { x: 0, y: 5, z: 0 } : { x: 50, y: 25, z: 50 } } }], reply: '空中的水体放好了。',
  }));
  const plan = await provider.plan({ ...input, text: '找个空地方放一个空中水体' }, new AbortController().signal);
  assert.equal(calls, 2);
  const after = VoxelEngine.fromSnapshot(initial).executeBatch(plan.batch!, input.requestId).snapshot;
  assert.equal(after.voxels.filter(voxel => voxel.partId === 'stream-water').length, 24);
  const afterIds = new Map(after.voxels.map(voxel => [voxel.id, voxel]));
  for (const voxel of initial.voxels) assert.deepEqual(afterIds.get(voxel.id), voxel);
});

test('known local edits can execute directly without mandatory geometry reads and preserve unrelated cells', async () => {
  const roof = initial.parts.find(part => part.id === 'home-roof')!;
  const target = initial.voxels.find(voxel => voxel.partId === roof.id)!;
  const local = { x: target.cell.x - roof.origin.x, y: target.cell.y - roof.origin.y, z: target.cell.z - roof.origin.z };
  let calls = 0;
  const provider = createProviders(config, async () => { calls++; return tool('apply_scene', {
    operations: [{ op: 'patch_cells', partId: roof.id, cells: [{ cell: local, color: '#1040F0' }] }], reply: '这一格变蓝色了。',
  }); });
  const result = await provider.plan({ ...input, text: '把已知位置的这一格屋顶改成蓝色' }, new AbortController().signal);
  assert.equal(calls, 1); assert.ok(result.batch);
  const after = VoxelEngine.fromSnapshot(initial).executeBatch(result.batch, 'direct-local-edit').snapshot;
  const actual = new Map(after.voxels.map(voxel => [voxel.id, voxel]));
  for (const voxel of initial.voxels) assert.deepEqual(actual.get(voxel.id), voxel.id === target.id ? { ...voxel, color: '#1040F0' } : voxel);
});
