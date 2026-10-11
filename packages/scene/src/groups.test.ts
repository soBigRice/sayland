import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSnapshotJson, snapshotDigest, type Operation, type SceneSnapshot } from '../../protocol/src/index.ts';
import { EngineError, VoxelEngine } from './engine.ts';
import { createInitialScene } from './initialScene.ts';

const apply = (engine: VoxelEngine, operations: Operation[], historyGroup?: string) => engine.executeBatch(
  { protocolVersion: 1, baseRevision: engine.snapshot().revision, operations }, crypto.randomUUID(), historyGroup,
);
const group = (id = 'robot', name = '机器人'): Operation => ({ op: 'define_group', group: { id, name } });
const part = (id: string, x: number, groupId?: string): Operation => ({
  op: 'define_part', part: { id, name: id, role: 'other', origin: { x, y: 0, z: 0 }, ...(groupId === undefined ? {} : { groupId }) },
});
const cell = (partId: string, x = 0): Operation => ({ op: 'patch_cells', partId, cells: [{ cell: { x, y: 0, z: 0 }, color: '#FFAA00' }] });
const errorCode = (code: string) => (error: unknown) => error instanceof EngineError && error.code === code;
const geometry = (snapshot: SceneSnapshot) => snapshot.voxels.toSorted((a, b) => a.id - b.id);
const members = (snapshot: SceneSnapshot) => snapshot.parts.toSorted((a, b) => a.id.localeCompare(b.id));

function adjacent(): VoxelEngine {
  const engine = new VoxelEngine();
  apply(engine, [group(), part('body', 0, 'robot'), cell('body'), part('eye', 1, 'robot'), cell('eye')]);
  return engine;
}

test('group translation moves touching parts atomically and preserves IDs, ownership and local offsets', () => {
  const engine = adjacent();
  const before = engine.snapshot();
  apply(engine, [{ op: 'translate_group', groupId: 'robot', delta: { x: 1, y: 2, z: 0 } }]);
  const moved = engine.snapshot();
  for (const voxel of moved.voxels) {
    const original = before.voxels.find(item => item.id === voxel.id)!;
    assert.deepEqual(voxel, { ...original, cell: { x: original.cell.x + 1, y: 2, z: 0 } });
  }
  for (const member of moved.parts) {
    const original = before.parts.find(item => item.id === member.id)!;
    assert.deepEqual(member, { ...original, origin: { x: original.origin.x + 1, y: 2, z: 0 } });
  }
  engine.undo();
  assert.deepEqual(geometry(engine.snapshot()), geometry(before));
  assert.deepEqual(members(engine.snapshot()), members(before));
  engine.redo();
  assert.deepEqual(geometry(engine.snapshot()), geometry(moved));
  apply(engine, [cell('eye', 1)]);
  assert.ok(engine.snapshot().voxels.some(voxel => voxel.partId === 'eye' && voxel.cell.x === 3 && voxel.cell.y === 2));
});

test('group collisions and numeric-overflow moves roll back geometry, membership, IDs and history', () => {
  const engine = adjacent();
  apply(engine, [part('obstacle', 3), cell('obstacle')]);
  const before = engine.serialize();
  assert.throws(() => apply(engine, [
    { op: 'rename_group', groupId: 'robot', name: '改名前的草稿' },
    { op: 'translate_group', groupId: 'robot', delta: { x: 2, y: 0, z: 0 } },
  ]), errorCode('COLLISION'));
  assert.deepEqual(engine.serialize(), before);
  assert.throws(() => apply(engine, [{ op: 'translate_group', groupId: 'robot', delta: { x: Number.MAX_SAFE_INTEGER, y: 0, z: 0 } }]), /精度/);
  assert.deepEqual(engine.serialize(), before);
});

test('painting and deleting a group leave unrelated and ungrouped objects untouched', () => {
  const engine = adjacent();
  apply(engine, [group('house', '小房子'), part('roof', 10, 'house'), cell('roof'), part('loose', 20), cell('loose')]);
  const before = engine.snapshot();
  apply(engine, [{ op: 'paint_group', groupId: 'robot', color: '#abcdef' }]);
  const painted = engine.snapshot();
  const robotParts = new Set(['body', 'eye']);
  for (const voxel of painted.voxels) {
    const old = before.voxels.find(item => item.id === voxel.id)!;
    assert.deepEqual(voxel, robotParts.has(voxel.partId) ? { ...old, color: '#ABCDEF' } : old);
  }
  apply(engine, [{ op: 'remove_group', groupId: 'robot' }]);
  assert.deepEqual(engine.snapshot().groups, [{ id: 'house', name: '小房子' }]);
  assert.deepEqual(geometry(engine.snapshot()), geometry(painted).filter(voxel => !robotParts.has(voxel.partId)));
  assert.deepEqual(members(engine.snapshot()), members(painted).filter(member => !robotParts.has(member.id)));
  engine.undo();
  assert.deepEqual(geometry(engine.snapshot()), geometry(painted));
  assert.deepEqual(members(engine.snapshot()), members(painted));
  assert.deepEqual(engine.snapshot().groups, painted.groups);
});

test('assignment, detachment and group rename are metadata-only undoable operations', () => {
  const engine = adjacent();
  apply(engine, [group('other', '另外一组')]);
  const before = engine.snapshot();
  apply(engine, [
    { op: 'assign_part_group', partId: 'eye', groupId: 'other' },
    { op: 'assign_part_group', partId: 'body', groupId: null },
    { op: 'rename_group', groupId: 'robot', name: '空的机器人组' },
  ]);
  const after = engine.snapshot();
  assert.deepEqual(after.voxels, before.voxels);
  assert.equal(after.parts.find(member => member.id === 'eye')?.groupId, 'other');
  assert.equal(after.parts.find(member => member.id === 'body')?.groupId, null);
  assert.equal(after.groups?.find(item => item.id === 'robot')?.name, '空的机器人组');
  engine.undo(); assert.deepEqual(members(engine.snapshot()), members(before));
  assert.deepEqual(engine.snapshot().groups, before.groups);
  engine.redo(); assert.deepEqual(members(engine.snapshot()), members(after));
});

test('part metadata updates and local edits preserve their object group', () => {
  const engine = adjacent();
  apply(engine, [part('eye', 1), { op: 'paint_part', partId: 'eye', color: '#112233', region: null }]);
  assert.equal(engine.snapshot().parts.find(member => member.id === 'eye')?.groupId, 'robot');
  assert.equal(engine.snapshot().voxels.find(voxel => voxel.partId === 'body')?.color, '#FFAA00');
  apply(engine, [{ op: 'translate_part', partId: 'eye', delta: { x: 0, y: 1, z: 0 } }]);
  assert.equal(engine.snapshot().parts.find(member => member.id === 'eye')?.groupId, 'robot');
  assert.deepEqual(engine.snapshot().parts.find(member => member.id === 'body')?.origin, { x: 0, y: 0, z: 0 });
});

test('unknown group references, duplicate group snapshots and corrupt history are rejected', () => {
  const engine = adjacent();
  const before = engine.serialize();
  assert.throws(() => apply(engine, [part('bad', 10, 'missing')]), errorCode('GROUP_NOT_FOUND'));
  assert.throws(() => apply(engine, [{ op: 'assign_part_group', partId: 'eye', groupId: 'missing' }]), errorCode('GROUP_NOT_FOUND'));
  assert.deepEqual(engine.serialize(), before);
  const duplicate = engine.snapshot(); duplicate.groups!.push({ ...duplicate.groups![0] });
  assert.throws(() => VoxelEngine.fromSnapshot(duplicate), errorCode('INVALID_SNAPSHOT'));
  const orphan = engine.snapshot(); orphan.groups = [];
  assert.throws(() => VoxelEngine.fromSnapshot(orphan), errorCode('INVALID_SNAPSHOT'));
  const corrupt = engine.serialize(); corrupt.past[0].after.groups = [];
  assert.throws(() => VoxelEngine.restore(corrupt), errorCode('INVALID_SAVED_SCENE'));
});

test('save and restore retain grouped undo and redo branches and one-turn grouping', () => {
  const engine = adjacent();
  const before = engine.snapshot();
  apply(engine, [{ op: 'rename_group', groupId: 'robot', name: '彩色机器人' }], 'one-turn');
  apply(engine, [{ op: 'paint_group', groupId: 'robot', color: '#345678' }], 'one-turn');
  const after = engine.snapshot();
  engine.undo();
  const restored = VoxelEngine.restore(engine.serialize());
  assert.deepEqual(geometry(restored.snapshot()), geometry(before));
  assert.deepEqual(restored.snapshot().groups, before.groups);
  restored.redo();
  assert.deepEqual(geometry(restored.snapshot()), geometry(after));
  assert.deepEqual(restored.snapshot().groups, after.groups);
  const savedAgain = VoxelEngine.restore(restored.serialize());
  savedAgain.undo();
  assert.deepEqual(geometry(savedAgain.snapshot()), geometry(before));
  assert.deepEqual(savedAgain.snapshot().groups, before.groups);
});

test('legacy snapshots and saved histories remain editable without guessing group membership', () => {
  const engine = new VoxelEngine();
  apply(engine, [part('home-roof', 0), cell('home-roof')]);
  engine.rename('旧作品'); engine.undo();
  const legacy = engine.serialize();
  delete legacy.snapshot.groups;
  for (const history of [...legacy.past, ...legacy.future]) {
    delete history.before.groups; delete history.after.groups;
  }
  const restored = VoxelEngine.restore(legacy);
  assert.deepEqual(restored.snapshot().groups, []);
  assert.equal(restored.snapshot().parts[0].groupId, undefined);
  assert.equal(canonicalSnapshotJson(restored.snapshot()), canonicalSnapshotJson(legacy.snapshot));
  restored.redo(); assert.equal(restored.snapshot().model.name, '旧作品');
  restored.undo(); restored.undo(); assert.equal(restored.count, 0);
  restored.redo();
  apply(restored, [group('house', '小房子'), { op: 'assign_part_group', partId: 'home-roof', groupId: 'house' }]);
  const regrouped = VoxelEngine.restore(restored.serialize());
  regrouped.undo();
  assert.deepEqual(regrouped.snapshot().groups, []);
  assert.equal(regrouped.snapshot().parts[0].groupId, undefined);
});

test('prefabs and the starter island explicitly group known objects without changing editable roles', () => {
  for (const prefab of ['house', 'tree', 'duck', 'flowers', 'river'] as const) {
    const engine = new VoxelEngine();
    apply(engine, [{ op: 'add_prefab', prefab, id: 'object', name: '一个物件', origin: { x: 0, y: 0, z: 0 } }]);
    assert.deepEqual(engine.snapshot().groups, [{ id: 'object', name: '一个物件' }]);
    assert.ok(engine.snapshot().parts.every(member => member.groupId === 'object'));
    const before = engine.snapshot();
    assert.throws(() => apply(engine, [{ op: 'add_prefab', prefab, id: 'object', name: '重复', origin: { x: 60, y: 0, z: 0 } }]), errorCode('GROUP_EXISTS'));
    assert.deepEqual(engine.snapshot(), before);
  }
  const initial = createInitialScene();
  assert.ok(initial.voxels.length > 9211);
  assert.equal(initial.parts.length, 25);
  assert.equal(initial.groups?.length, 13);
  const ids = new Set(initial.groups?.map(item => item.id));
  assert.ok(initial.parts.every(member => member.groupId && ids.has(member.groupId)));
  assert.equal(initial.parts.find(member => member.id === 'home-roof')?.groupId, 'home');
  assert.equal(initial.parts.find(member => member.id === 'home-roof')?.role, 'roof');
});

test('canonical digest covers group membership and names but ignores group array order and legacy nulls', async () => {
  const engine = adjacent(); apply(engine, [group('other', '其他')]);
  const before = engine.snapshot();
  const reordered = structuredClone(before); reordered.groups!.reverse(); reordered.parts.reverse();
  assert.equal(await snapshotDigest(before), await snapshotDigest(reordered));
  apply(engine, [{ op: 'rename_group', groupId: 'robot', name: '新名称' }]);
  const renamed = { ...engine.snapshot(), revision: before.revision };
  assert.notEqual(await snapshotDigest(before), await snapshotDigest(renamed));
  const regrouped = structuredClone(before); regrouped.parts[0].groupId = 'other';
  assert.notEqual(await snapshotDigest(before), await snapshotDigest(regrouped));
  const legacy = new VoxelEngine(); apply(legacy, [part('loose', 0), cell('loose')]);
  const missing = legacy.snapshot(); delete missing.groups;
  const explicit = { ...missing, groups: [], parts: missing.parts.map(member => ({ ...member, groupId: null })) };
  assert.equal(await snapshotDigest(missing), await snapshotDigest(explicit));
});

test('server and browser group transforms produce the same committed digest', async () => {
  const browser = adjacent();
  const server = VoxelEngine.fromSnapshot(browser.snapshot());
  const batch = { protocolVersion: 1, baseRevision: browser.snapshot().revision, operations: [
    { op: 'translate_group', groupId: 'robot', delta: { x: 1, y: 0, z: 0 } },
    { op: 'paint_group', groupId: 'robot', color: '#556677' },
  ] };
  const a = browser.executeBatch(batch, 'same-request').snapshot;
  const b = server.executeBatch(batch, 'same-request').snapshot;
  assert.equal(await snapshotDigest(a), await snapshotDigest(b));
  assert.equal(browser.executeBatch(batch, 'same-request').replayed, true);
});

test('oversized group changes fail atomically within the existing batch budget', () => {
  const engine = new VoxelEngine();
  const volume = (partId: string): Operation => ({ op: 'fill_shape', partId, shape: { kind: 'box', offset: { x: 0, y: 0, z: 0 }, size: { x: 20, y: 20, z: 20 } }, color: '#FFAA00' });
  apply(engine, [group(), part('left', 0, 'robot'), volume('left'), part('right', 20, 'robot'), volume('right')]);
  apply(engine, [cell('left', -1)]);
  const before = engine.serialize();
  for (const operation of [
    { op: 'translate_group', groupId: 'robot', delta: { x: 1, y: 0, z: 0 } },
    { op: 'paint_group', groupId: 'robot', color: '#112233' },
    { op: 'remove_group', groupId: 'robot' },
  ] satisfies Operation[]) {
    assert.throws(() => apply(engine, [operation]), errorCode('BATCH_BUDGET'));
    assert.deepEqual(engine.serialize(), before);
  }
});
