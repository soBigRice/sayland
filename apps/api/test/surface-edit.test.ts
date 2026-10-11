import test from 'node:test';
import assert from 'node:assert/strict';
import { VoxelEngine, createInitialScene } from '../../../packages/scene/src/index.ts';
import { aiOperationSchema, type AiOperation, type SceneSnapshot, type Part } from '../../../packages/protocol/src/index.ts';
import { compileSurfaceExpansion, SurfaceEditError, type SurfaceExpansionSpec } from '../src/surface-edit.ts';

// Geometry fixtures only: no browser storage, microphone, environment file or provider access.
const origin = { x: 0, y: 0, z: 0 };
const cellKey = (cell: typeof origin) => `${cell.x},${cell.y},${cell.z}`;
let sequence = 0;
function apply(engine: VoxelEngine, operations: AiOperation[]) {
  return engine.executeBatch({ protocolVersion: 1, baseRevision: engine.snapshot().revision, operations }, `surface-fixture-${++sequence}`).snapshot;
}
function geometry(snapshot: SceneSnapshot) {
  // Undo preserves voxel identities and values; storage iteration order is not scene semantics.
  return { parts: snapshot.parts, groups: snapshot.groups, voxels: [...snapshot.voxels].sort((a, b) => a.id - b.id) };
}
function waterFixture(size = { x: 2, y: 1, z: 2 }, partOrigin = origin) {
  const engine = new VoxelEngine();
  apply(engine, [
    { op: 'define_group', group: { id: 'water-object', name: '测试水面' } },
    { op: 'define_part', part: { id: 'water', name: '水', role: 'water', origin: partOrigin, groupId: 'water-object' } },
    { op: 'fill_shape', partId: 'water', shape: { kind: 'box', offset: origin, size }, color: '#22AADD' },
  ]);
  return engine;
}
function expectError(snapshot: SceneSnapshot, spec: SurfaceExpansionSpec, code: string) {
  const before = JSON.stringify(snapshot);
  assert.throws(() => compileSurfaceExpansion(snapshot, spec), (error: unknown) => error instanceof SurfaceEditError && error.code === code);
  assert.equal(JSON.stringify(snapshot), before);
}
function islandRiver(z = -12) {
  const engine = VoxelEngine.fromSnapshot(createInitialScene());
  const base = engine.snapshot();
  const operations: AiOperation[] = [
    { op: 'define_group', group: { id: 'river-object', name: '岛内河流' } },
    { op: 'define_part', part: { id: 'river', name: '河水', role: 'water', origin: { x: -10, y: 4, z }, groupId: 'river-object' } },
  ];
  for (const partId of ['island-soil', 'island-grass']) {
    const cells = base.voxels.filter(voxel => voxel.partId === partId && voxel.cell.x >= -10 && voxel.cell.x <= 3
      && voxel.cell.z >= z && voxel.cell.z <= z + 1 && voxel.cell.y >= 4)
      .map(voxel => ({ cell: voxel.cell, color: null }));
    operations.push({ op: 'patch_cells', partId, cells });
  }
  operations.push({ op: 'fill_shape', partId: 'river', shape: { kind: 'box', offset: origin, size: { x: 14, y: 1, z: 2 } }, color: '#22AADD' });
  apply(engine, operations);
  return engine;
}

test('island river grows one grid at unobstructed X edges inside actual terrain; all other cells and metadata survive', () => {
  const engine = islandRiver(), before = engine.snapshot(), frozen = JSON.stringify(before);
  const operations = compileSurfaceExpansion(before, { partId: 'river', amount: 1, axes: 'x', terrainGroupId: 'island-terrain' });
  assert.equal(JSON.stringify(before), frozen);
  assert.ok(operations.every(operation => operation.op === 'patch_cells' && operation.cells.length <= 4096));
  const after = apply(engine, operations);
  assert.equal(after.voxels.filter(voxel => voxel.partId === 'river').length, 32);
  const remaining = new Map(after.voxels.map(voxel => [voxel.id, voxel]));
  const terrainIds = new Set(before.parts.filter(part => part.groupId === 'island-terrain' && part.role === 'terrain').map(part => part.id));
  let removed = 0;
  for (const voxel of before.voxels) {
    const selected = terrainIds.has(voxel.partId) && (voxel.cell.x === -11 || voxel.cell.x === 4)
      && voxel.cell.z >= -12 && voxel.cell.z <= -11 && voxel.cell.y >= 4 && voxel.cell.y <= 5;
    if (selected) { assert.equal(remaining.has(voxel.id), false); removed++; }
    else assert.deepEqual(remaining.get(voxel.id), voxel);
  }
  assert.equal(removed, 8);
  assert.deepEqual(after.parts, before.parts); assert.deepEqual(after.groups, before.groups);
  assert.deepEqual(after.voxels.filter(voxel => voxel.partId === 'home-roof'), before.voxels.filter(voxel => voxel.partId === 'home-roof'));
  engine.undo(); assert.deepEqual(geometry(engine.snapshot()), geometry(before));
  engine.redo(); assert.deepEqual(geometry(engine.snapshot()), geometry(after));
});

test('the initial lagoon expands only outside each original row, preserving its island hole, depth, colors and every old voxel', () => {
  const before = createInitialScene(), engine = VoxelEngine.fromSnapshot(before);
  const operations = compileSurfaceExpansion(before, { partId: 'lagoon', amount: 1, axes: 'x' });
  const after = apply(engine, operations);
  const byId = new Map(after.voxels.map(voxel => [voxel.id, voxel]));
  for (const voxel of before.voxels) assert.deepEqual(byId.get(voxel.id), voxel);
  const rows = new Map<number, { min: number; max: number }>();
  for (const voxel of before.voxels.filter(voxel => voxel.partId === 'lagoon' && voxel.cell.y === 0)) {
    const row = rows.get(voxel.cell.z) ?? { min: Infinity, max: -Infinity };
    row.min = Math.min(row.min, voxel.cell.x); row.max = Math.max(row.max, voxel.cell.x); rows.set(voxel.cell.z, row);
  }
  const oldIds = new Set(before.voxels.map(voxel => voxel.id));
  const donors = new Map(before.voxels.filter(voxel => voxel.partId === 'lagoon').map(voxel => [cellKey(voxel.cell), voxel]));
  const added = after.voxels.filter(voxel => !oldIds.has(voxel.id));
  assert.equal(added.length, rows.size * 2 * 4);
  for (const voxel of added) {
    const row = rows.get(voxel.cell.z)!;
    assert.ok(voxel.cell.x === row.min - 1 || voxel.cell.x === row.max + 1);
    assert.equal(voxel.partId, 'lagoon'); assert.ok(voxel.cell.y >= -3 && voxel.cell.y <= 0);
    const donorX = voxel.cell.x === row.min - 1 ? row.min : row.max;
    assert.equal(voxel.color, donors.get(cellKey({ ...voxel.cell, x: donorX }))!.color);
  }
  assert.deepEqual(after.parts, before.parts); assert.deepEqual(after.groups, before.groups);
});

test('xz combines original outer edges without filling an inner hole or creating diagonal corners', () => {
  const engine = waterFixture({ x: 5, y: 1, z: 5 });
  apply(engine, [{ op: 'patch_cells', partId: 'water', cells: [{ cell: { x: 2, y: 0, z: 2 }, color: null }] }]);
  const before = engine.snapshot();
  const after = apply(engine, compileSurfaceExpansion(before, { partId: 'water', amount: 1, axes: 'xz' }));
  const occupied = new Set(after.voxels.map(voxel => cellKey(voxel.cell)));
  assert.equal(after.voxels.length, 44);
  for (const cell of [{ x: 2, y: 0, z: 2 }, { x: -1, y: 0, z: -1 }, { x: 5, y: 0, z: 5 }]) assert.equal(occupied.has(cellKey(cell)), false);
});

test('one blocked outer cell rejects the complete expansion without skipping it or changing the source', () => {
  const engine = waterFixture();
  apply(engine, [
    { op: 'define_part', part: { id: 'protected-roof', name: '不能覆盖的屋顶', role: 'roof', origin } },
    { op: 'patch_cells', partId: 'protected-roof', cells: [{ cell: { x: 2, y: 0, z: 0 }, color: '#FFAA22' }] },
  ]);
  const before = engine.snapshot();
  expectError(before, { partId: 'water', amount: 1, axes: 'x' }, 'SURFACE_COLLISION');
  try { compileSurfaceExpansion(before, { partId: 'water', amount: 1, axes: 'x' }); }
  catch (error) { assert.ok(error instanceof SurfaceEditError); assert.equal(error.details.occupiedBy, 'protected-roof'); assert.deepEqual(error.details.cell, { x: 2, y: 0, z: 0 }); }
  assert.deepEqual(engine.snapshot(), before);
});

test('requested terrain confinement rejects growing off the island instead of accepting only the in-bounds subset', () => {
  expectError(islandRiver(-72).snapshot(), { partId: 'river', amount: 2, axes: 'z', terrainGroupId: 'island-terrain' }, 'OUTSIDE_TERRAIN');
});

test('Z expansion preserves island plants and the high roof outside its actual excavation volume', () => {
  const engine = islandRiver(), before = engine.snapshot();
  const after = apply(engine, compileSurfaceExpansion(before, { partId: 'river', amount: 1, axes: 'z', terrainGroupId: 'island-terrain' }));
  assert.equal(after.voxels.filter(voxel => voxel.partId === 'river').length, 56);
  const terrainIds = new Set(before.parts.filter(part => part.groupId === 'island-terrain' && part.role === 'terrain').map(part => part.id));
  const afterById = new Map(after.voxels.map(voxel => [voxel.id, voxel]));
  for (const old of before.voxels.filter(voxel => !terrainIds.has(voxel.partId))) assert.deepEqual(afterById.get(old.id), old);
});

test('the observed group-plus-grass target is a scope error before any geometry collision and never broadens implicitly', () => {
  const before = islandRiver().snapshot();
  expectError(before, { partId: 'river', amount: 1, axes: 'z', terrainGroupId: 'island-terrain', terrainPartId: 'island-grass' }, 'AMBIGUOUS_TERRAIN_TARGET');
  assert.throws(() => compileSurfaceExpansion(before, { partId: 'river', amount: 1, axes: 'z', terrainGroupId: 'island-terrain', terrainPartId: 'island-grass' }),
    (error: unknown) => error instanceof SurfaceEditError && error.details.multiLayerTerrain === 'use-terrainGroupId-only');
});

function targetTerrainFixture(withBed: boolean, withRoof: boolean, foreignBed = false) {
  const engine = waterFixture({ x: 1, y: 1, z: 1 }, { x: 0, y: 4, z: 0 });
  apply(engine, [
    { op: 'define_part', part: { id: 'ground', name: '目标地形', role: 'terrain', origin } },
    { op: 'patch_cells', partId: 'ground', cells: [-1, 1].flatMap(x => [
      { cell: { x, y: 5, z: 0 }, color: '#88BB55' },
      ...(withBed && !foreignBed ? [{ cell: { x, y: 3, z: 0 }, color: '#886644' }] : []),
    ]) },
  ]);
  if (foreignBed) apply(engine, [
    { op: 'define_part', part: { id: 'unrelated-ground', name: '未授权地形', role: 'terrain', origin } },
    { op: 'patch_cells', partId: 'unrelated-ground', cells: [-1, 1].map(x => ({ cell: { x, y: 3, z: 0 }, color: '#886644' })) },
  ]);
  if (withRoof) apply(engine, [
    { op: 'define_part', part: { id: 'overhead-roof', name: '上方屋顶', role: 'roof', origin } },
    { op: 'patch_cells', partId: 'overhead-roof', cells: [{ cell: { x: 1, y: 9, z: 0 }, color: '#FFAA22' }] },
  ]);
  return engine;
}

test('target terrain must provide an immediate bed under every new water column, not only a higher surface', () => {
  const engine = targetTerrainFixture(false, false), before = engine.snapshot();
  expectError(before, { partId: 'water', amount: 1, axes: 'x', terrainPartId: 'ground' }, 'SURFACE_BED_REQUIRED');
  assert.deepEqual(engine.snapshot(), before);
  expectError(targetTerrainFixture(true, false, true).snapshot(),
    { partId: 'water', amount: 1, axes: 'x', terrainPartId: 'ground' }, 'SURFACE_BED_REQUIRED');
});

test('a high roof beyond the excavation volume stays unchanged and does not block supported water expansion', () => {
  const engine = targetTerrainFixture(true, true), before = engine.snapshot();
  const after = apply(engine, compileSurfaceExpansion(before, { partId: 'water', amount: 1, axes: 'x', terrainPartId: 'ground' }));
  assert.equal(after.voxels.filter(voxel => voxel.partId === 'water').length, 3);
  for (const old of before.voxels.filter(voxel => voxel.partId === 'overhead-roof' || voxel.cell.y === 3 || voxel.partId === 'water')) {
    assert.deepEqual(after.voxels.find(voxel => voxel.id === old.id), old);
  }
});

test('a non-target obstruction inside the actual excavation volume rejects the complete expansion', () => {
  const engine = targetTerrainFixture(true, false);
  apply(engine, [
    { op: 'patch_cells', partId: 'ground', cells: [{ cell: { x: 1, y: 5, z: 0 }, color: null }, { cell: { x: 1, y: 6, z: 0 }, color: '#88BB55' }] },
    { op: 'define_part', part: { id: 'near-roof', name: '挖掘范围内的遮挡', role: 'roof', origin } },
    { op: 'patch_cells', partId: 'near-roof', cells: [{ cell: { x: 1, y: 5, z: 0 }, color: '#FFAA22' }] },
  ]);
  const before = engine.snapshot();
  assert.throws(() => compileSurfaceExpansion(before, { partId: 'water', amount: 1, axes: 'x', terrainPartId: 'ground' }),
    (error: unknown) => error instanceof SurfaceEditError && error.code === 'SURFACE_COLLISION'
      && error.details.phase === 'terrain-clearance' && error.details.occupiedBy === 'near-roof'
      && JSON.stringify(error.details.cell) === JSON.stringify({ x: 1, y: 5, z: 0 }));
  assert.deepEqual(engine.snapshot(), before);
});

test('an immediately supported unobstructed terrain expansion preserves the bed and existing water exactly', () => {
  const engine = targetTerrainFixture(true, false), before = engine.snapshot();
  const after = apply(engine, compileSurfaceExpansion(before, { partId: 'water', amount: 1, axes: 'x', terrainPartId: 'ground' }));
  assert.equal(after.voxels.filter(voxel => voxel.partId === 'water').length, 3);
  for (const old of before.voxels.filter(voxel => voxel.cell.y === 3 || voxel.partId === 'water')) {
    assert.deepEqual(after.voxels.find(voxel => voxel.id === old.id), old);
  }
});

test('nonzero origins are converted independently for terrain deletion and water addition', () => {
  const engine = new VoxelEngine();
  apply(engine, [
    { op: 'define_group', group: { id: 'terrain-object', name: '地形' } },
    { op: 'define_group', group: { id: 'river-object', name: '河流' } },
    { op: 'define_part', part: { id: 'ground', name: '地形', role: 'terrain', origin: { x: 10, y: 2, z: -8 }, groupId: 'terrain-object' } },
    { op: 'fill_shape', partId: 'ground', shape: { kind: 'box', offset: origin, size: { x: 5, y: 3, z: 1 } }, color: '#88BB55' },
    { op: 'patch_cells', partId: 'ground', cells: [{ cell: { x: 2, y: 1, z: 0 }, color: null }, { cell: { x: 2, y: 2, z: 0 }, color: null }] },
    { op: 'define_part', part: { id: 'river', name: '水', role: 'water', origin: { x: 12, y: 3, z: -8 }, groupId: 'river-object' } },
    { op: 'patch_cells', partId: 'river', cells: [{ cell: origin, color: '#22AADD' }] },
  ]);
  const before = engine.snapshot();
  const operations = compileSurfaceExpansion(before, { partId: 'river', amount: 1, axes: 'x', terrainPartId: 'ground' });
  assert.deepEqual(operations, [
    { op: 'patch_cells', partId: 'ground', cells: [
      { cell: { x: 1, y: 1, z: 0 }, color: null }, { cell: { x: 1, y: 2, z: 0 }, color: null },
      { cell: { x: 3, y: 1, z: 0 }, color: null }, { cell: { x: 3, y: 2, z: 0 }, color: null },
    ] },
    { op: 'patch_cells', partId: 'river', cells: [{ cell: { x: -1, y: 0, z: 0 }, color: '#22AADD' }, { cell: { x: 1, y: 0, z: 0 }, color: '#22AADD' }] },
  ]);
  const after = apply(engine, operations);
  assert.deepEqual(after.voxels.filter(voxel => voxel.partId === 'river').map(voxel => voxel.cell).sort((a, b) => a.x - b.x),
    [{ x: 11, y: 3, z: -8 }, { x: 12, y: 3, z: -8 }, { x: 13, y: 3, z: -8 }]);
});

test('new deep water copies every boundary layer while protected terrain below the waterline cannot be dug implicitly', () => {
  const engine = waterFixture({ x: 2, y: 3, z: 1 }, { x: 7, y: -2, z: 4 });
  apply(engine, [{ op: 'paint_part', partId: 'water', color: '#113355', region: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 0, z: 0 } } }]);
  const before = engine.snapshot();
  const after = apply(engine, compileSurfaceExpansion(before, { partId: 'water', amount: 1, axes: 'z' }));
  assert.equal(after.voxels.length, 18);
  for (const voxel of after.voxels) assert.equal(voxel.color, voxel.cell.y === -2 ? '#113355' : '#22AADD');
  const blocked = VoxelEngine.fromSnapshot(before);
  apply(blocked, [
    { op: 'define_part', part: { id: 'ground', name: '不能深挖', role: 'terrain', origin } },
    { op: 'patch_cells', partId: 'ground', cells: [
      { cell: { x: 7, y: 0, z: 3 }, color: '#88BB55' }, { cell: { x: 7, y: -1, z: 3 }, color: '#886644' },
    ] },
  ]);
  expectError(blocked.snapshot(), { partId: 'water', amount: 1, axes: 'z', terrainPartId: 'ground' }, 'SURFACE_COLLISION');
});

test('unsupported slopes and hollow column depths are rejected rather than flattened', () => {
  const slope = waterFixture({ x: 2, y: 1, z: 1 });
  apply(slope, [{ op: 'patch_cells', partId: 'water', cells: [{ cell: { x: 1, y: 1, z: 0 }, color: '#22AADD' }] }]);
  expectError(slope.snapshot(), { partId: 'water', amount: 1, axes: 'x' }, 'UNSUPPORTED_SURFACE');
  const hollow = waterFixture({ x: 1, y: 3, z: 1 });
  apply(hollow, [{ op: 'patch_cells', partId: 'water', cells: [{ cell: { x: 0, y: 1, z: 0 }, color: null }] }]);
  expectError(hollow.snapshot(), { partId: 'water', amount: 1, axes: 'x' }, 'UNSUPPORTED_SURFACE');
});

test('terrain authorization cannot delete decorative parts even when they belong to the same target group', () => {
  const engine = waterFixture({ x: 1, y: 1, z: 1 });
  apply(engine, [
    { op: 'define_group', group: { id: 'ground-object', name: '地形和装饰' } },
    { op: 'define_part', part: { id: 'ground', name: '地形', role: 'terrain', origin, groupId: 'ground-object' } },
    { op: 'patch_cells', partId: 'ground', cells: [
      { cell: { x: -1, y: 0, z: 0 }, color: '#88BB55' }, { cell: { x: -1, y: 2, z: 0 }, color: '#88BB55' },
      { cell: { x: 1, y: 0, z: 0 }, color: '#88BB55' },
    ] },
    { op: 'define_part', part: { id: 'protected-plant', name: '同组植物', role: 'plant', origin, groupId: 'ground-object' } },
    { op: 'patch_cells', partId: 'protected-plant', cells: [{ cell: { x: -1, y: 1, z: 0 }, color: '#338811' }] },
  ]);
  const before = engine.snapshot();
  expectError(before, { partId: 'water', amount: 1, axes: 'x', terrainGroupId: 'ground-object' }, 'SURFACE_COLLISION');
  expectError(before, { partId: 'water', amount: 1, axes: 'x', terrainPartId: 'ground', terrainGroupId: 'water-object' }, 'AMBIGUOUS_TERRAIN_TARGET');
  assert.deepEqual(engine.snapshot(), before);
});

test('a flat terrain surface follows the same geometry rule without name-based inference', () => {
  const snapshot = waterFixture({ x: 2, y: 2, z: 1 }).snapshot();
  snapshot.parts[0] = { ...snapshot.parts[0], name: '自由取名的表面', role: 'terrain' };
  const engine = VoxelEngine.fromSnapshot(snapshot);
  const after = apply(engine, compileSurfaceExpansion(snapshot, { partId: 'water', amount: 1, axes: 'x' }));
  assert.equal(after.voxels.length, 8);
  assert.deepEqual(after.parts, snapshot.parts);
});

test('amount, roles, target identity and both world/local coordinate bounds are validated', () => {
  const before = waterFixture().snapshot();
  for (const amount of [0, 5, 1.5, NaN]) expectError(before, { partId: 'water', amount, axes: 'x' }, 'INVALID_SPEC');
  expectError(before, { partId: 'water', amount: 1, axes: 'x', terrainPartId: 'water' }, 'INVALID_TERRAIN_TARGET');
  expectError(before, { partId: 'water', amount: 1, axes: 'x', terrainGroupId: 'missing' }, 'TERRAIN_TARGET_NOT_FOUND');
  expectError(before, { partId: 'missing', amount: 1, axes: 'x' }, 'PART_NOT_FOUND');
  const roof = { ...before, parts: before.parts.map(part => ({ ...part, role: 'roof' as Part['role'] })) };
  expectError(roof, { partId: 'water', amount: 1, axes: 'x' }, 'INVALID_SURFACE_ROLE');
  expectError(waterFixture({ x: 1, y: 1, z: 1 }, { x: Number.MAX_SAFE_INTEGER, y: 0, z: 0 }).snapshot(), { partId: 'water', amount: 1, axes: 'x' }, 'OUT_OF_BOUNDS');
  const localBound = waterFixture({ x: 1, y: 1, z: 1 }).snapshot();
  localBound.parts[0].origin.x = Number.MAX_SAFE_INTEGER;
  expectError(localBound, { partId: 'water', amount: 1, axes: 'x' }, 'OUT_OF_BOUNDS');
});

test('patches split at 4096 cells, and total edit budget rejects excessive depth expansion', () => {
  const before = waterFixture({ x: 64, y: 9, z: 1 }).snapshot();
  const operations = compileSurfaceExpansion(before, { partId: 'water', amount: 4, axes: 'z' });
  assert.equal(operations.length, 2);
  assert.deepEqual(operations.map(operation => operation.op === 'patch_cells' ? operation.cells.length : 0), [4096, 512]);
  for (const operation of operations) aiOperationSchema.parse(operation);
  expectError(waterFixture({ x: 64, y: 64, z: 1 }).snapshot(), { partId: 'water', amount: 4, axes: 'z' }, 'EXPANSION_BUDGET');
});

test('surface expansion works beyond former world and local bounds', () => {
  const engine = waterFixture({ x: 1, y: 1, z: 1 }, { x: 500, y: -200, z: 1000 });
  const before = engine.snapshot();
  // A far-away part origin is legal too: output patches remain exact local coordinates.
  before.parts[0].origin.x = -1000;
  const operations = compileSurfaceExpansion(before, { partId: 'water', amount: 1, axes: 'x' });
  const result = VoxelEngine.fromSnapshot(before).executeBatch({ protocolVersion: 1, baseRevision: before.revision, operations }, 'far-surface').snapshot;
  assert.deepEqual(result.voxels.map(voxel => voxel.cell.x).sort((a, b) => a - b), [499, 500, 501]);
  assert.ok(result.voxels.every(voxel => voxel.cell.y === -200 && voxel.cell.z === 1000));
});

test('fragmented terrain cannot produce more than 32 operations even when voxel count is small', () => {
  const engine = waterFixture({ x: 1, y: 1, z: 20 });
  apply(engine, [{ op: 'define_group', group: { id: 'ground-object', name: '分段地形' } }]);
  for (let z = 0; z < 20; z++) for (const x of [-1, 1]) {
    const id = `ground-${z}-${x === -1 ? 'left' : 'right'}`;
    apply(engine, [
      { op: 'define_part', part: { id, name: '地形', role: 'terrain', origin: { x, y: 0, z }, groupId: 'ground-object' } },
      // Valid beds keep this fixture focused on the independent operation-count limit.
      { op: 'patch_cells', partId: id, cells: [{ cell: origin, color: '#88BB55' }, { cell: { x: 0, y: -1, z: 0 }, color: '#886644' }] },
    ]);
  }
  expectError(engine.snapshot(), { partId: 'water', amount: 1, axes: 'x', terrainGroupId: 'ground-object' }, 'EXPANSION_BUDGET');
});
