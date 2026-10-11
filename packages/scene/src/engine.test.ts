import test from 'node:test';
import assert from 'node:assert/strict';
import { VoxelEngine } from './engine.ts';
import { createInitialScene } from './initialScene.ts';
import { canonicalSnapshotJson, snapshotDigest, vecSchema, MAX_SCENE_VOXELS, type Operation, type SceneBatch } from '../../protocol/src/index.ts';

const apply = (engine: VoxelEngine, operations: Operation[], id: string = crypto.randomUUID(), group?: string) => engine.executeBatch({ protocolVersion: 1, baseRevision: engine.snapshot().revision, operations }, id, group);
const part = (id = 'test'): Operation => ({ op: 'define_part', part: { id, name: '测试部件', role: 'other', origin: { x: 0, y: 0, z: 0 } } });
const cell = (x: number, partId = 'test', color = '#FFAA00'): Operation => ({ op: 'patch_cells', partId, cells: [{ cell: { x, y: 0, z: 0 }, color }] });

test('starter island is deterministic editable data with independent roof, flora and water', () => {
  const scene = createInitialScene();
  // Full soil and water depth must leave substantial capacity for the child's own creations.
  assert.ok(scene.voxels.length <= MAX_SCENE_VOXELS - 380000);
  const grass = scene.voxels.filter(v => v.partId === 'island-grass');
  const water = scene.voxels.filter(v => v.partId === 'lagoon' && v.cell.y === 0);
  assert.ok(grass.length >= 8500 && water.length >= 9000, 'broad land and water must be actual editable surfaces');
  assert.equal(Math.max(...water.map(v => v.cell.x)) - Math.min(...water.map(v => v.cell.x)) + 1, 144);
  assert.equal(Math.max(...water.map(v => v.cell.z)) - Math.min(...water.map(v => v.cell.z)) + 1, 128);
  assert.equal(Math.max(...grass.map(v => v.cell.x)) - Math.min(...grass.map(v => v.cell.x)) + 1, 112);
  const plain = grass.filter(v => v.cell.z <= 6);
  assert.equal(Math.max(...plain.map(v => v.cell.z)) - Math.min(...plain.map(v => v.cell.z)) + 1, 80);
  const occupied = new Set(scene.voxels.map(v => `${v.cell.x},${v.cell.y},${v.cell.z}`));
  assert.ok(grass.filter(v => !occupied.has(`${v.cell.x},${v.cell.y + 1},${v.cell.z}`)).length >= 8500, 'keep open ground around the starter buildings');
  assert.deepEqual(scene, createInitialScene());
  assert.equal(new Set(scene.voxels.map(v => `${v.cell.x},${v.cell.y},${v.cell.z}`)).size, scene.voxels.length);
  assert.ok(scene.parts.some(p => p.id === 'home-roof' && p.role === 'roof'));
  assert.equal(canonicalSnapshotJson(VoxelEngine.fromSnapshot(scene).snapshot()), canonicalSnapshotJson(scene));
});

test('failed transaction changes neither cells, revision nor future IDs', () => {
  const engine = new VoxelEngine();
  const before = engine.snapshot();
  assert.throws(() => apply(engine, [part(), cell(0), cell(1, 'missing')]), /不存在/);
  assert.deepEqual(engine.snapshot(), before);
  const result = apply(engine, [part(), cell(0)]);
  assert.equal(result.snapshot.voxels[0].id, 1);
  assert.equal(result.snapshot.revision, 1);
});

test('duplicate request is idempotent after later edits and stale revisions are rejected', () => {
  const engine = new VoxelEngine();
  const batch: SceneBatch = { protocolVersion: 1, baseRevision: 0, operations: [part(), cell(0)] };
  engine.executeBatch(batch, 'first'); apply(engine, [cell(1)]);
  assert.equal(engine.executeBatch(batch, 'first').replayed, true);
  assert.equal(engine.snapshot().voxels.length, 2);
  assert.throws(() => engine.executeBatch(batch, 'other'), /版本/);
  assert.throws(() => engine.executeBatch({ ...batch, operations: [part()] }, 'first'), /不同命令/);
});

test('one voice turn undoes all batches and redo preserves IDs', () => {
  const engine = new VoxelEngine();
  apply(engine, [part(), cell(0)], 'one', 'speech-one');
  apply(engine, [cell(1)], 'two', 'speech-one');
  const built = engine.snapshot();
  engine.undo(); assert.equal(engine.count, 0);
  engine.redo(); assert.deepEqual(engine.snapshot().voxels, built.voxels);
});

test('roof repaint preserves the entire rest of the island and stable voxel IDs', () => {
  const initial = createInitialScene(); const engine = VoxelEngine.fromSnapshot(initial);
  apply(engine, [{ op: 'paint_part', partId: 'home-roof', color: '#779BDD', region: null }]);
  const after = new Map(engine.snapshot().voxels.map(v => [v.id, v]));
  for (const before of initial.voxels) assert.deepEqual(after.get(before.id), before.partId === 'home-roof' ? { ...before, color: '#779BDD' } : before);
  engine.undo(); assert.deepEqual(engine.snapshot().voxels.sort((a,b)=>a.id-b.id), initial.voxels.sort((a,b)=>a.id-b.id));
});

test('arbitrary layers retain holes and replace emptiness only removes owned cells', () => {
  const engine = new VoxelEngine();
  apply(engine, [part(), { op: 'write_layers', partId: 'test', offset: { x: 0, y: 0, z: 0 }, palette: [{ symbol: 'a', color: '#AAFF00' }], layers: [{ y: 0, rows: ['aaa', 'a.a', 'aaa'] }], mode: 'add' }]);
  assert.equal(engine.count, 8);
  assert.ok(!engine.snapshot().voxels.some(v => v.cell.x === 1 && v.cell.z === 1));
  apply(engine, [part('other'), { op: 'patch_cells', partId: 'other', cells: [{ cell: { x: 1, y: 0, z: 1 }, color: '#FFFFFF' }] }]);
  apply(engine, [{ op: 'write_layers', partId: 'test', offset: { x: 0, y: 0, z: 0 }, palette: [{ symbol: 'a', color: '#AAFF00' }], layers: [{ y: 0, rows: ['...', '...', '...'] }], mode: 'replace' }]);
  assert.equal(engine.count, 1); assert.equal(engine.snapshot().voxels[0].partId, 'other');
});

test('prefabs are ordinary parts, reject occupied cells and support local edits', () => {
  const engine = new VoxelEngine();
  apply(engine, [{ op: 'add_prefab', prefab: 'house', id: 'cottage', name: '小屋', origin: { x: 0, y: 0, z: 0 } }]);
  const before = engine.snapshot();
  assert.ok(before.parts.some(p => p.id === 'cottage-roof'));
  assert.throws(() => apply(engine, [{ op: 'add_prefab', prefab: 'house', id: 'second', name: '第二间', origin: { x: 0, y: 0, z: 0 } }]), /占据/);
  assert.deepEqual(engine.snapshot(), before);
  apply(engine, [{ op: 'paint_part', partId: 'cottage-roof', color: '#3366AA', region: null }]);
  assert.ok(engine.snapshot().voxels.filter(v => v.partId === 'cottage-roof').every(v => v.color === '#3366AA'));
});

test('coordinate expansion, per-batch work and candidate limits fail atomically', () => {
  const engine = new VoxelEngine(); apply(engine, [part()]);
  const before = engine.snapshot();
  assert.throws(() => apply(engine, [{ op: 'fill_shape', partId: 'test', shape: { kind: 'box', offset: { x: Number.MAX_SAFE_INTEGER, y: 0, z: 0 }, size: { x: 3, y: 1, z: 1 } }, color: '#FFFFFF' }]), /精度/);
  assert.throws(() => apply(engine, [{ op: 'fill_shape', partId: 'test', shape: { kind: 'box', offset: { x: 0, y: 0, z: 0 }, size: { x: 26, y: 26, z: 24 } }, color: '#FFFFFF' }]), /16000/);
  assert.throws(() => apply(engine, [{ op: 'fill_shape', partId: 'test', shape: { kind: 'box', offset: { x: 0, y: 0, z: 0 }, size: { x: 41, y: 41, z: 41 } }, color: '#FFFFFF' }]), /候选/);
  assert.deepEqual(engine.snapshot(), before);
});

test('distant free geometry, large local offsets and translations survive saves and undo without migration', async () => {
  const engine = new VoxelEngine();
  const position = { x: 500, y: -200, z: 1000 };
  apply(engine, [part(), { op: 'fill_shape', partId: 'test', shape: { kind: 'box', offset: position,
    size: { x: 2, y: 1, z: 1 } }, color: '#AA7733' }], 'far-create');
  const created = engine.snapshot();
  assert.deepEqual(created.voxels.map(voxel => voxel.cell), [position, { ...position, x: 501 }]);
  apply(engine, [{ op: 'translate_part', partId: 'test', delta: { x: -1000, y: 500, z: 2000 } }], 'far-move');
  const moved = engine.snapshot();
  assert.deepEqual(moved.voxels[0].cell, { x: -500, y: 300, z: 3000 });
  const saved = JSON.parse(JSON.stringify(engine.serialize()));
  assert.equal(saved.version, 1); assert.equal(saved.snapshot.schemaVersion, 2);
  const restored = VoxelEngine.restore(saved);
  assert.equal(await snapshotDigest(restored.snapshot()), await snapshotDigest(moved));
  assert.equal(await snapshotDigest(VoxelEngine.fromSnapshot(moved).snapshot()), await snapshotDigest(moved));
  restored.undo(); assert.deepEqual(restored.snapshot().voxels, created.voxels);
  restored.redo(); assert.deepEqual(restored.snapshot().voxels, moved.voxels);
});

test('coordinates reject non-finite, fractional and unsafe numbers and arithmetic overflow atomically', () => {
  for (const x of [NaN, Infinity, -Infinity, 0.25, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1]) {
    assert.equal(vecSchema.safeParse({ x, y: 0, z: 0 }).success, false);
  }
  const engine = new VoxelEngine();
  apply(engine, [{ op: 'define_part', part: { id: 'test', name: '测试', role: 'detail', origin: { x: Number.MAX_SAFE_INTEGER, y: 0, z: 0 } } }, cell(0)]);
  const before = engine.serialize();
  assert.throws(() => apply(engine, [cell(1)]), /精度/);
  assert.throws(() => apply(engine, [{ op: 'translate_part', partId: 'test', delta: { x: 1, y: 0, z: 0 } }]), /精度/);
  assert.deepEqual(engine.serialize(), before);
});

test('scene capacity is checked across individually legal batches', () => {
  const seed = new VoxelEngine(); apply(seed, [part()]);
  const snapshot = seed.snapshot();
  snapshot.voxels = Array.from({ length: MAX_SCENE_VOXELS - 2 }, (_, index) => ({
    id: index + 1, partId: 'test', cell: { x: index, y: 0, z: 0 }, color: '#FFFFFF',
  }));
  snapshot.nextVoxelId = MAX_SCENE_VOXELS - 1;
  const engine = VoxelEngine.fromSnapshot(snapshot);
  apply(engine, [cell(MAX_SCENE_VOXELS - 2)]); apply(engine, [cell(MAX_SCENE_VOXELS - 1)]);
  const before = engine.snapshot(); assert.equal(engine.count, MAX_SCENE_VOXELS);
  assert.throws(() => apply(engine, [cell(MAX_SCENE_VOXELS)]), { code: 'SCENE_CAPACITY' });
  assert.deepEqual(engine.snapshot(), before);
});

test('save restore retains undo redo, metadata and deduplication without regenerating geometry', () => {
  const engine = new VoxelEngine();
  apply(engine, [part(), cell(0)], 'first'); apply(engine, [cell(1)], 'second');
  engine.rename('小朋友的岛'); engine.undo();
  const restored = VoxelEngine.restore(engine.serialize());
  assert.deepEqual(restored.snapshot(), engine.snapshot());
  restored.redo(); assert.equal(restored.snapshot().model.name, '小朋友的岛');
  restored.undo(); restored.undo(); assert.equal(restored.count, 1);
  const duplicate: SceneBatch = { protocolVersion: 1, baseRevision: 0, operations: [part(), cell(0)] };
  assert.equal(restored.executeBatch(duplicate, 'first').replayed, true);
});

test('corrupt saved history and duplicate positions are explicitly rejected', () => {
  const engine = new VoxelEngine(); apply(engine, [part(), cell(0)]);
  const corrupt = engine.serialize();
  corrupt.past[0].changes[0].after!.color = '#000000';
  assert.throws(() => VoxelEngine.restore(corrupt), /不一致/);
  const duplicate = engine.snapshot(); duplicate.voxels.push({ ...duplicate.voxels[0], id: 100 });
  assert.throws(() => VoxelEngine.fromSnapshot(duplicate), /重复位置/);
});

test('returned snapshots cannot mutate the engine and rename is undoable without cell loss', () => {
  const engine = VoxelEngine.fromSnapshot(createInitialScene());
  const before = engine.snapshot(); const external = engine.snapshot(); external.voxels[0].color = '#000000';
  engine.rename('彩虹小岛'); assert.equal(engine.snapshot().model.name, '彩虹小岛');
  assert.deepEqual(engine.snapshot().voxels, before.voxels);
  engine.undo(); assert.equal(engine.snapshot().model.name, before.model.name);
});


test('server snapshot mirror allocates the same IDs after deleting the highest voxel ID', async () => {
  const browser = new VoxelEngine();
  apply(browser, [part(), cell(0), cell(1)]);
  apply(browser, [{ op: 'remove', voxelIds: [2] }]);
  const snapshot = browser.snapshot();
  assert.equal(snapshot.nextVoxelId, 3);
  const server = VoxelEngine.fromSnapshot(snapshot);
  const batch: SceneBatch = { protocolVersion: 1, baseRevision: snapshot.revision, operations: [cell(2)] };
  const a = browser.executeBatch(batch, 'new-cell').snapshot;
  const b = server.executeBatch(batch, 'new-cell').snapshot;
  assert.equal(await snapshotDigest(a), await snapshotDigest(b));
  assert.equal(a.voxels.find(v => v.cell.x === 2)?.id, 3);
});


test('rotation validates final world coordinates rather than rejecting a valid distant pivot', () => {
  const engine = new VoxelEngine(); apply(engine, [part(), cell(128)]);
  apply(engine, [{ op: 'rotate90', voxelIds: [1], axis: 'x', quarterTurns: 1, pivot: { x: -128, y: 0, z: 0 } }]);
  assert.deepEqual(engine.snapshot().voxels[0].cell, { x: 128, y: -1, z: 0 });
});
