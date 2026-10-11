import test from 'node:test';
import assert from 'node:assert/strict';
import { aiOperationSchema, snapshotDigest, type Operation, type SceneSnapshot } from '../../protocol/src/index.ts';
import { EngineError, VoxelEngine } from './engine.ts';

const zero = { x: 0, y: 0, z: 0 };
const apply = (engine: VoxelEngine, operations: Operation[], requestId = crypto.randomUUID()) => engine.executeBatch(
  { protocolVersion: 1, baseRevision: engine.snapshot().revision, operations }, requestId,
);
const geometry = (snapshot: SceneSnapshot) => snapshot.voxels.toSorted((a, b) => a.id - b.id);
const members = (snapshot: SceneSnapshot) => snapshot.parts.toSorted((a, b) => a.id.localeCompare(b.id));
const rotate = { op: 'rotate_group', groupId: 'boat', axis: 'y', quarterTurns: 1, pivot: { x: 1, y: 0, z: 1 } } as const;

function boat() {
  const engine = new VoxelEngine();
  apply(engine, [
    { op: 'define_group', group: { id: 'boat', name: '小船' } },
    { op: 'define_part', part: { id: 'hull', name: '船身', role: 'other', groupId: 'boat', origin: zero } },
    { op: 'patch_cells', partId: 'hull', cells: [
      { cell: zero, color: '#AA3300' }, { cell: { x: 1, y: 0, z: 0 }, color: '#2244AA' },
    ] },
    { op: 'define_part', part: { id: 'sail', name: '船帆', role: 'detail', groupId: 'boat', origin: { x: 0, y: 0, z: 1 } } },
    { op: 'patch_cells', partId: 'sail', cells: [{ cell: zero, color: '#FFFFFF' }] },
    { op: 'define_part', part: { id: 'neighbor', name: '旁边的物件', role: 'other', origin: { x: 8, y: 0, z: 8 } } },
    { op: 'patch_cells', partId: 'neighbor', cells: [{ cell: zero, color: '#00AA33' }] },
  ]);
  return engine;
}

test('AI rotation schemas expose explicit object/part targets and reject unsupported angles and pivots', () => {
  assert.equal(aiOperationSchema.safeParse(rotate).success, true);
  assert.equal(aiOperationSchema.safeParse({ op: 'rotate_part', partId: 'sail', axis: 'z', quarterTurns: -2, pivot: zero }).success, true);
  for (const quarterTurns of [0, 4, 0.5, 45, 90]) assert.equal(aiOperationSchema.safeParse({ ...rotate, quarterTurns }).success, false);
  assert.equal(aiOperationSchema.safeParse({ ...rotate, pivot: { x: 0.5, y: 0, z: 0 } }).success, false);
  assert.equal(aiOperationSchema.safeParse({ ...rotate, pivot: undefined }).success, false);
  assert.equal(aiOperationSchema.safeParse({ ...rotate, groupId: undefined }).success, false);
});

test('rotating a whole boat atomically swaps member cells and preserves colors, IDs and unrelated objects', () => {
  const engine = boat(), before = engine.snapshot();
  apply(engine, [rotate]);
  const after = engine.snapshot();
  const positions = [{ x: 0, y: 0, z: 1 }, zero, { x: 1, y: 0, z: 1 }, { x: 8, y: 0, z: 8 }];
  assert.deepEqual(geometry(after), geometry(before).map((voxel, index) => ({ ...voxel, cell: positions[index] })));
  assert.deepEqual(after.groups, before.groups);
  assert.deepEqual(members(after), members(before).map(part => ({ ...part,
    origin: part.id === 'hull' ? positions[0] : part.id === 'sail' ? positions[2] : part.origin,
  })));
  // Local edits remain in world-aligned axes relative to the rotated anchor cell.
  apply(engine, [{ op: 'patch_cells', partId: 'sail', cells: [{ cell: { x: 0, y: 1, z: 0 }, color: '#FFFF00' }] }]);
  assert.ok(engine.snapshot().voxels.some(voxel => voxel.partId === 'sail' && voxel.cell.x === 1 && voxel.cell.y === 1 && voxel.cell.z === 1));
});

test('part rotations follow the right-hand rule on each axis and preserve siblings', () => {
  const expected = { x: { x: 2, y: -5, z: 3 }, y: { x: 4, y: 3, z: -3 }, z: { x: -4, y: 2, z: 4 } };
  for (const axis of ['x', 'y', 'z'] as const) {
    const engine = boat();
    apply(engine, [{ op: 'translate_part', partId: 'sail', delta: { x: 2, y: 3, z: 3 } }]);
    const before = engine.snapshot();
    apply(engine, [{ op: 'rotate_part', partId: 'sail', axis, quarterTurns: 1, pivot: zero }]);
    const after = engine.snapshot();
    assert.deepEqual(geometry(after), geometry(before).map(voxel => voxel.partId === 'sail' ? { ...voxel, cell: expected[axis] } : voxel));
    assert.deepEqual(members(after), members(before).map(part => part.id === 'sail' ? { ...part, origin: expected[axis] } : part));
    apply(engine, [{ op: 'rotate_part', partId: 'sail', axis, quarterTurns: -1, pivot: zero }]);
    assert.deepEqual(geometry(engine.snapshot()), geometry(before));
    assert.deepEqual(members(engine.snapshot()), members(before));
  }
});

test('four quarter turns and signed half/three-quarter turns restore exact geometry and metadata', () => {
  for (const axis of ['x', 'y', 'z'] as const) {
    const engine = boat(), before = engine.snapshot();
    for (let i = 0; i < 4; i++) apply(engine, [{ ...rotate, axis }]);
    assert.deepEqual(geometry(engine.snapshot()), geometry(before));
    assert.deepEqual(members(engine.snapshot()), members(before));
    for (const quarterTurns of [2, 3, -2, -3] as const) {
      apply(engine, [{ ...rotate, axis, quarterTurns }, { ...rotate, axis, quarterTurns: -quarterTurns as -2 | -3 | 2 | 3 }]);
      assert.deepEqual(geometry(engine.snapshot()), geometry(before));
      assert.deepEqual(members(engine.snapshot()), members(before));
    }
  }
});

test('rotation collisions roll back the whole batch including preceding metadata edits', () => {
  const engine = boat();
  apply(engine, [{ op: 'translate_part', partId: 'neighbor', delta: { x: -7, y: 0, z: -7 } }]);
  const before = engine.serialize();
  assert.throws(() => apply(engine, [{ op: 'rename_group', groupId: 'boat', name: '不应提交' }, rotate]),
    (error: unknown) => error instanceof EngineError && error.code === 'COLLISION');
  assert.deepEqual(engine.serialize(), before);
  // A sibling outside the selected part must still block its destination.
  assert.throws(() => apply(engine, [{ op: 'rotate_part', partId: 'sail', axis: 'y', quarterTurns: -1, pivot: rotate.pivot }]),
    (error: unknown) => error instanceof EngineError && error.code === 'COLLISION');
  assert.deepEqual(engine.serialize(), before);
});

test('rotation rejects unknown targets, unsafe arithmetic and over-budget targets without side effects', () => {
  const engine = boat(), before = engine.serialize();
  assert.throws(() => apply(engine, [{ ...rotate, groupId: 'missing' }]), /不存在/);
  assert.throws(() => apply(engine, [{ op: 'rotate_part', partId: 'missing', axis: 'y', quarterTurns: 1, pivot: zero }]), /不存在/);
  assert.throws(() => apply(engine, [{ ...rotate, pivot: { x: -Number.MAX_SAFE_INTEGER, y: 0, z: 0 } }]), /精度|整数/);
  assert.deepEqual(engine.serialize(), before);
  const large = engine.snapshot();
  large.voxels = Array.from({ length: 16001 }, (_, index) => ({ id: index + 1, partId: 'hull', color: '#AA3300', cell: { x: index, y: 0, z: 0 } }));
  large.nextVoxelId = 16002;
  const overBudget = VoxelEngine.fromSnapshot(large), saved = overBudget.serialize();
  assert.throws(() => apply(overBudget, [rotate]), (error: unknown) => error instanceof EngineError && error.code === 'BATCH_BUDGET');
  assert.throws(() => apply(overBudget, [{ op: 'rotate_part', partId: 'hull', axis: 'y', quarterTurns: 1, pivot: zero }]),
    (error: unknown) => error instanceof EngineError && error.code === 'BATCH_BUDGET');
  assert.deepEqual(overBudget.serialize(), saved);
});

test('rotation shares server/browser digest, idempotency and saved undo/redo behavior', async () => {
  const engine = boat(), before = engine.snapshot(), mirror = VoxelEngine.fromSnapshot(before);
  const batch = { protocolVersion: 1 as const, baseRevision: before.revision, operations: [rotate] };
  const after = engine.executeBatch(batch, 'rotation-turn').snapshot;
  assert.equal(await snapshotDigest(mirror.executeBatch(batch, 'rotation-turn').snapshot), await snapshotDigest(after));
  assert.equal(engine.executeBatch(batch, 'rotation-turn').replayed, true);
  const restored = VoxelEngine.restore(engine.serialize());
  restored.undo();
  assert.deepEqual(geometry(restored.snapshot()), geometry(before));
  assert.deepEqual(members(restored.snapshot()), members(before));
  const withRedo = VoxelEngine.restore(restored.serialize());
  withRedo.redo();
  assert.deepEqual(geometry(withRedo.snapshot()), geometry(after));
  assert.deepEqual(members(withRedo.snapshot()), members(after));
});
