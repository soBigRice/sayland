import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSnapshotJson, type AiOperation, type Part, type SceneSnapshot } from '../../../packages/protocol/src/index.ts';
import { boundsOf, createInitialScene, VoxelEngine, type Vec3 } from '../../../packages/scene/src/index.ts';
import { compileCreation, LayoutError, MAX_LAYOUT_CANDIDATES } from '../src/layout.ts';

const zero = { x: 0, y: 0, z: 0 };
const key = (cell: Vec3) => `${cell.x},${cell.y},${cell.z}`;
function shape(size: Vec3, origin = zero, offset = zero, role: Part['role'] = 'water'): AiOperation[] {
  return [{ op: 'define_group', group: { id: 'new-object', name: '新物件' } },
    { op: 'define_part', part: { id: 'new-body', name: '主体', role, groupId: 'new-object', origin } },
    { op: 'fill_shape', partId: 'new-body', shape: { kind: 'box', offset, size }, color: '#44BBEE' }];
}
function ground(width = 8, depth = 8, height = 3, top = 5, origin = zero): SceneSnapshot {
  const snapshot = new VoxelEngine().snapshot();
  snapshot.groups = [{ id: 'ground-group', name: '地形' }];
  snapshot.parts = [{ id: 'ground', name: '地面', role: 'terrain', groupId: 'ground-group', origin }];
  for (let x = 0; x < width; x++) for (let z = 0; z < depth; z++) for (let y = top - height + 1; y <= top; y++) {
    snapshot.voxels.push({ id: snapshot.voxels.length + 1, partId: 'ground', cell: { x: x + origin.x, y, z: z + origin.z }, color: '#77AA44' });
  }
  snapshot.nextVoxelId = snapshot.voxels.length + 1;
  return snapshot;
}
function obstacle(snapshot: SceneSnapshot, cells: Vec3[]) {
  snapshot.groups!.push({ id: 'protected', name: '保留建筑' });
  snapshot.parts.push({ id: 'obstacle', name: '建筑', role: 'roof', groupId: 'protected', origin: zero });
  for (const cell of cells) snapshot.voxels.push({ id: snapshot.nextVoxelId!++, partId: 'obstacle', cell, color: '#AA4444' });
}
function apply(snapshot: SceneSnapshot, operations: AiOperation[]) {
  const engine = VoxelEngine.fromSnapshot(snapshot);
  const result = engine.executeBatch({ protocolVersion: 1, baseRevision: snapshot.revision, operations }, 'layout-test', 'one-conversation');
  return { engine, result, after: result.snapshot };
}
function expectCode(code: string) {
  return (error: unknown) => error instanceof LayoutError && error.code === code;
}
function document(snapshot: SceneSnapshot) { return canonicalSnapshotJson({ ...snapshot, revision: 0, nextVoxelId: 1 }); }

test('initial island accepts a connected 12x1x2 open inset with real terrain removal, preservation and one undo', () => {
  const initial = createInitialScene(), frozen = canonicalSnapshotJson(initial);
  const input = shape({ x: 12, y: 1, z: 2 });
  const operations = compileCreation(initial, input, { mode: 'in_surface', targetGroupId: 'island-terrain' });
  assert.deepEqual(compileCreation(initial, input, { mode: 'in_surface', targetGroupId: 'island-terrain' }), operations);
  assert.equal(canonicalSnapshotJson(initial), frozen);
  assert.equal(input.length, 3);
  const { after, engine, result } = apply(initial, operations);
  const water = after.voxels.filter(voxel => voxel.partId === 'new-body');
  const oldByCell = new Map(initial.voxels.map(voxel => [key(voxel.cell), voxel]));
  const afterById = new Map(after.voxels.map(voxel => [voxel.id, voxel]));
  const parts = new Map(initial.parts.map(part => [part.id, part]));
  const removed = initial.voxels.filter(voxel => !afterById.has(voxel.id));
  assert.equal(water.length, 24); assert.equal(removed.length, 48);
  assert.ok(removed.every(voxel => parts.get(voxel.partId)?.groupId === 'island-terrain'));
  for (const voxel of initial.voxels) {
    if (parts.get(voxel.partId)?.role !== 'terrain') assert.deepEqual(afterById.get(voxel.id), voxel);
  }
  const waterKeys = new Set(water.map(voxel => key(voxel.cell))), seen = new Set<string>(), queue = [water[0].cell];
  while (queue.length) {
    const cell = queue.pop()!, cellId = key(cell); if (seen.has(cellId)) continue; seen.add(cellId);
    for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const next = { x: cell.x + x, y: cell.y + y, z: cell.z + z }; if (waterKeys.has(key(next)) && !seen.has(key(next))) queue.push(next);
    }
  }
  assert.equal(seen.size, water.length);
  for (const voxel of water) {
    assert.equal(parts.get(oldByCell.get(key(voxel.cell))!.partId)?.role, 'terrain');
    assert.ok(after.voxels.some(v => v.cell.x === voxel.cell.x && v.cell.z === voxel.cell.z && v.cell.y === voxel.cell.y - 1));
    const covered = after.voxels.some(v => v.cell.x === voxel.cell.x && v.cell.z === voxel.cell.z && v.cell.y > voxel.cell.y);
    assert.equal(covered, false);
  }
  assert.equal(result.changes.length, 72); assert.equal(after.revision, initial.revision + 1);
  assert.ok(document(engine.undo().snapshot) === document(initial)); assert.equal(engine.canUndo, false);
  assert.ok(document(engine.redo().snapshot) === document(after));
});

test('surface placement requires actual footprint support and avoids a building instead of intersecting it', () => {
  const snapshot = ground();
  obstacle(snapshot, [{ x: 3, y: 6, z: 3 }, { x: 4, y: 6, z: 3 }, { x: 3, y: 6, z: 4 }, { x: 4, y: 6, z: 4 }]);
  const compiled = compileCreation(snapshot, shape({ x: 3, y: 2, z: 3 }, zero, zero, 'plant'), { mode: 'on_surface', targetPartId: 'ground' });
  const { after } = apply(snapshot, compiled), created = after.voxels.filter(v => v.partId === 'new-body');
  assert.equal(boundsOf(created.map(v => v.cell))!.min.y, 6);
  assert.equal(created.length, 18);
  assert.ok(snapshot.voxels.every(v => after.voxels.some(next => next.id === v.id && key(next.cell) === key(v.cell))));
});

test('insets preserve existing high roofs outside the excavation and allow water beneath them', () => {
  const snapshot = ground(3, 3);
  obstacle(snapshot, Array.from({ length: 9 }, (_, i) => ({ x: i % 3, y: 14, z: Math.floor(i / 3) })));
  const original = canonicalSnapshotJson(snapshot);
  const compiled = compileCreation(snapshot, shape({ x: 3, y: 1, z: 3 }), { mode: 'in_surface', targetGroupId: 'ground-group' });
  const { after, engine } = apply(snapshot, compiled), afterById = new Map(after.voxels.map(voxel => [voxel.id, voxel]));
  const water = after.voxels.filter(voxel => voxel.partId === 'new-body');
  assert.equal(water.length, 9); assert.ok(water.every(voxel => voxel.cell.y === 4));
  for (const voxel of snapshot.voxels.filter(voxel => voxel.partId === 'obstacle')) assert.deepEqual(afterById.get(voxel.id), voxel);
  const removed = snapshot.voxels.filter(voxel => !afterById.has(voxel.id));
  assert.equal(removed.length, 18);
  assert.ok(removed.every(voxel => voxel.partId === 'ground' && voxel.cell.y >= 4 && voxel.cell.y <= 5));
  assert.equal(canonicalSnapshotJson(snapshot), original);
  assert.ok(document(engine.undo().snapshot) === document(snapshot));
});

test('new insets prefer an open valid position over the nearest position beneath an existing roof', () => {
  const snapshot = ground(5, 1);
  obstacle(snapshot, [{ x: 2, y: 14, z: 0 }]);
  const compiled = compileCreation(snapshot, shape({ x: 1, y: 1, z: 1 }), { mode: 'in_surface', targetGroupId: 'ground-group' });
  const { after } = apply(snapshot, compiled);
  assert.deepEqual(after.voxels.find(voxel => voxel.partId === 'new-body')!.cell, { x: 1, y: 4, z: 0 });
  assert.deepEqual(after.voxels.find(voxel => voxel.partId === 'obstacle'), snapshot.voxels.find(voxel => voxel.partId === 'obstacle'));
});

test('candidate and work budgets can return a verified covered fallback without an unbounded visibility search', () => {
  const byCandidates = ground(100, 50, 3, 5, { x: -50, y: 0, z: -25 });
  // The one open corner is beyond the first 4096 distance-sorted candidates.
  obstacle(byCandidates, byCandidates.voxels.filter(voxel => voxel.cell.y === 5 && (voxel.cell.x !== -50 || voxel.cell.z !== -25)).map(voxel => ({ ...voxel.cell, y: 14 })));
  const candidatePlan = compileCreation(byCandidates, shape({ x: 1, y: 1, z: 1 }), { mode: 'in_surface', targetGroupId: 'ground-group' });
  assert.deepEqual(apply(byCandidates, candidatePlan).after.voxels.find(voxel => voxel.partId === 'new-body')!.cell, { x: -1, y: 4, z: -1 });

  const byWork = ground(64, 64);
  // A 20x20 open corner exists, but inspecting 400 cells per candidate reaches
  // the shared work budget before that distant placement. Keep the valid centre.
  obstacle(byWork, byWork.voxels.filter(voxel => voxel.cell.y === 5 && (voxel.cell.x >= 20 || voxel.cell.z >= 20)).map(voxel => ({ ...voxel.cell, y: 14 })));
  const workPlan = compileCreation(byWork, shape({ x: 20, y: 1, z: 20 }), { mode: 'in_surface', targetGroupId: 'ground-group' });
  const after = apply(byWork, workPlan).after, water = after.voxels.filter(voxel => voxel.partId === 'new-body');
  assert.deepEqual(boundsOf(water.map(voxel => voxel.cell))!.min, { x: 22, y: 4, z: 22 });
  assert.equal(water.length, 400);
  const roofs = new Map(after.voxels.filter(voxel => voxel.partId === 'obstacle').map(voxel => [voxel.id, voxel]));
  const oldRoofs = byWork.voxels.filter(voxel => voxel.partId === 'obstacle');
  assert.equal(roofs.size, oldRoofs.length);
  for (const voxel of oldRoofs) assert.deepEqual(roofs.get(voxel.id), voxel);
});

test('insets still reject other objects inside the excavation or the actual new geometry', () => {
  const snapshot = ground(3, 3);
  snapshot.voxels = snapshot.voxels.filter(voxel => key(voxel.cell) !== '1,4,1');
  obstacle(snapshot, [{ x: 1, y: 4, z: 1 }]);
  const original = canonicalSnapshotJson(snapshot);
  assert.throws(() => compileCreation(snapshot, shape({ x: 3, y: 1, z: 3 }), { mode: 'in_surface', targetGroupId: 'ground-group' }), expectCode('LAYOUT_NO_SPACE'));
  assert.equal(canonicalSnapshotJson(snapshot), original);
  const lowRoof = ground(3, 3);
  obstacle(lowRoof, Array.from({ length: 9 }, (_, i) => ({ x: i % 3, y: 6, z: Math.floor(i / 3) })));
  const lowRoofBefore = canonicalSnapshotJson(lowRoof);
  assert.throws(() => compileCreation(lowRoof, shape({ x: 1, y: 3, z: 1 }), { mode: 'in_surface', targetGroupId: 'ground-group' }), expectCode('LAYOUT_NO_SPACE'));
  assert.equal(canonicalSnapshotJson(lowRoof), lowRoofBefore);
});

test('inset water rejects this creation\'s own cover, including one covered column and a distant overhead cap', () => {
  const snapshot = ground(4, 4), original = canonicalSnapshotJson(snapshot);
  for (const height of [1, 4]) {
    const input: AiOperation[] = [...shape({ x: 2, y: 1, z: 1 }),
      { op: 'define_part', part: { id: 'new-cap', name: '盖板', role: 'terrain', groupId: 'new-object', origin: { x: 1, y: height, z: 0 } } },
      { op: 'fill_shape', partId: 'new-cap', shape: { kind: 'box', offset: zero, size: { x: 1, y: 1, z: 1 } }, color: '#886644' }];
    assert.throws(() => compileCreation(snapshot, input, { mode: 'in_surface', targetGroupId: 'ground-group' }), expectCode('LAYOUT_WATER_COVERED'));
    // Explicit world placement still permits covered water; automatic open insets do not.
    assert.doesNotThrow(() => compileCreation(new VoxelEngine().snapshot(), input, { mode: 'absolute', position: zero }));
  }
  assert.equal(canonicalSnapshotJson(snapshot), original);
});

test('inset water needs continuous support to the retained bed, not just below the object bounds', () => {
  const snapshot = ground(), original = canonicalSnapshotJson(snapshot);
  const floating: AiOperation[] = [...shape({ x: 2, y: 1, z: 1 }, { x: 0, y: 2, z: 0 }),
    { op: 'define_part', part: { id: 'new-bed', name: '河床', role: 'terrain', groupId: 'new-object', origin: zero } },
    { op: 'fill_shape', partId: 'new-bed', shape: { kind: 'box', offset: zero, size: { x: 2, y: 1, z: 1 } }, color: '#886644' }];
  assert.throws(() => compileCreation(snapshot, floating, { mode: 'in_surface', targetPartId: 'ground' }), expectCode('LAYOUT_WATER_UNSUPPORTED'));
  const disconnected: AiOperation[] = [...shape({ x: 1, y: 1, z: 1 }),
    { op: 'patch_cells', partId: 'new-body', cells: [{ cell: { x: 0, y: 2, z: 0 }, color: '#44BBEE' }] }];
  assert.throws(() => compileCreation(snapshot, disconnected, { mode: 'in_surface', targetPartId: 'ground' }), expectCode('LAYOUT_WATER_UNSUPPORTED'));
  const floatingBed: AiOperation[] = [...shape({ x: 2, y: 1, z: 1 }, { x: 0, y: 2, z: 0 }),
    { op: 'define_part', part: { id: 'new-bed', name: '河床', role: 'terrain', groupId: 'new-object', origin: { x: 0, y: 1, z: 0 } } },
    { op: 'fill_shape', partId: 'new-bed', shape: { kind: 'box', offset: zero, size: { x: 2, y: 1, z: 1 } }, color: '#886644' },
    { op: 'patch_cells', partId: 'new-bed', cells: [{ cell: { x: 1, y: -1, z: 0 }, color: '#886644' }] }];
  assert.throws(() => compileCreation(snapshot, floatingBed, { mode: 'in_surface', targetPartId: 'ground' }), expectCode('LAYOUT_WATER_UNSUPPORTED'));
  assert.equal(canonicalSnapshotJson(snapshot), original);
});

test('inset water accepts a new bed below continuous layers and verifies each final water column', () => {
  const snapshot = ground(4, 4, 4), origin = { x: 5, y: 12, z: -2 };
  const input: AiOperation[] = [...shape({ x: 2, y: 2, z: 1 }, origin),
    { op: 'define_part', part: { id: 'new-bed', name: '河床', role: 'terrain', groupId: 'new-object', origin: { ...origin, y: origin.y - 1 } } },
    { op: 'fill_shape', partId: 'new-bed', shape: { kind: 'box', offset: zero, size: { x: 2, y: 1, z: 1 } }, color: '#886644' }];
  const operations = compileCreation(snapshot, input, { mode: 'in_surface', targetPartId: 'ground', depth: 3 });
  const { after, engine } = apply(snapshot, operations), occupied = new Map(after.voxels.map(voxel => [key(voxel.cell), voxel]));
  const water = after.voxels.filter(voxel => voxel.partId === 'new-body');
  assert.equal(water.length, 4);
  for (const voxel of water) {
    assert.ok(occupied.has(key({ ...voxel.cell, y: voxel.cell.y - 1 })));
    assert.ok(after.voxels.filter(other => other.cell.x === voxel.cell.x && other.cell.z === voxel.cell.z && other.cell.y > voxel.cell.y).every(other => other.partId === 'new-body'));
  }
  assert.ok(document(engine.undo().snapshot) === document(snapshot));
});

test('arbitrary layer holes remain holes and protect objects inside the bounding box', () => {
  const snapshot = ground(3, 3);
  obstacle(snapshot, [{ x: 1, y: 6, z: 1 }]);
  const operations: AiOperation[] = [...shape({ x: 1, y: 1, z: 1 }).slice(0, 2), {
    op: 'write_layers', partId: 'new-body', offset: { x: -3, y: 2, z: 4 },
    palette: [{ symbol: 'W', color: '#44BBEE' }], layers: [{ y: 0, rows: ['WWW', 'W.W', 'WWW'] }], mode: 'add',
  }, { op: 'patch_cells', partId: 'new-body', cells: [{ cell: { x: -3, y: 2, z: 4 }, color: '#33AADD' }] }];
  const compiled = compileCreation(snapshot, operations, { mode: 'in_surface', targetGroupId: 'ground-group' });
  const { after } = apply(snapshot, compiled);
  assert.equal(after.voxels.filter(v => v.partId === 'new-body').length, 8);
  assert.ok(!after.voxels.some(v => v.partId === 'new-body' && v.cell.x === 1 && v.cell.z === 1));
  assert.ok(snapshot.voxels.filter(v => v.cell.x === 1 && v.cell.z === 1).every(v => after.voxels.some(next => next.id === v.id && key(next.cell) === key(v.cell))));
});

test('holes and insufficient riverbed are not inferred to be solid from bounds', () => {
  const hole = ground(3, 3); hole.voxels = hole.voxels.filter(v => !(v.cell.x === 1 && v.cell.z === 1));
  assert.throws(() => compileCreation(hole, shape({ x: 3, y: 1, z: 3 }), { mode: 'on_surface', targetGroupId: 'ground-group' }), expectCode('LAYOUT_NO_SPACE'));
  assert.throws(() => compileCreation(ground(3, 3, 2), shape({ x: 1, y: 1, z: 1 }), { mode: 'in_surface', targetGroupId: 'ground-group', depth: 2 }), expectCode('LAYOUT_TERRAIN_TOO_SHALLOW'));
  assert.throws(() => compileCreation(ground(3, 3), shape({ x: 4, y: 1, z: 4 }), { mode: 'in_surface', targetGroupId: 'ground-group' }), expectCode('LAYOUT_NO_SPACE'));
});

test('a single-layer grass target reports a correctable depth error without silently selecting its parent group', () => {
  const snapshot = createInitialScene(), original = canonicalSnapshotJson(snapshot), input = shape({ x: 12, y: 1, z: 2 });
  assert.throws(() => compileCreation(snapshot, input, { mode: 'in_surface', targetPartId: 'island-grass', depth: 2 }),
    (error: unknown) => {
      assert.ok(error instanceof LayoutError);
      assert.equal(error.code, 'LAYOUT_TERRAIN_TOO_SHALLOW');
      assert.equal(error.details.targetPartId, 'island-grass');
      assert.equal(error.details.depth, 2);
      assert.equal(error.details.requiredContinuousCells, 3);
      assert.deepEqual(error.details.suggestedTargetGroupIds, ['island-terrain']);
      return true;
    });
  assert.equal(canonicalSnapshotJson(snapshot), original);
  const compiled = compileCreation(snapshot, input, { mode: 'in_surface', targetGroupId: 'island-terrain', depth: 2 });
  assert.ok(compiled.some(op => op.op === 'patch_cells' && op.cells.some(item => item.color === null)));
  assert.equal(canonicalSnapshotJson(snapshot), original);
});

test('inset target depth counts continuous terrain, and one sufficient column permits ordinary space search', () => {
  const snapshot = ground(2, 1), input = shape({ x: 1, y: 1, z: 1 });
  snapshot.voxels = snapshot.voxels.filter(voxel => voxel.cell.y !== 4);
  assert.throws(() => compileCreation(snapshot, input, { mode: 'in_surface', targetGroupId: 'ground-group' }), expectCode('LAYOUT_TERRAIN_TOO_SHALLOW'));
  snapshot.voxels.push({ id: snapshot.nextVoxelId!++, partId: 'ground', cell: { x: 1, y: 4, z: 0 }, color: '#77AA44' });
  assert.doesNotThrow(() => compileCreation(snapshot, input, { mode: 'in_surface', targetGroupId: 'ground-group' }));
  assert.throws(() => compileCreation(snapshot, shape({ x: 3, y: 1, z: 1 }), { mode: 'in_surface', targetGroupId: 'ground-group' }), expectCode('LAYOUT_NO_SPACE'));
});

test('target and new part origins are translated independently without changing local geometry', () => {
  const snapshot = ground(8, 8, 3, 8, { x: 20, y: 3, z: -4 });
  const input = shape({ x: 2, y: 1, z: 2 }, { x: 10, y: -3, z: 7 }, { x: -4, y: 5, z: -2 });
  const compiled = compileCreation(snapshot, input, { mode: 'in_surface', targetGroupId: 'ground-group' });
  assert.deepEqual(compiled.find(op => op.op === 'fill_shape'), input[2]);
  const cleanup = compiled.find(op => op.op === 'patch_cells'); assert.ok(cleanup?.op === 'patch_cells');
  assert.ok(cleanup.cells.every(item => item.cell.y === 4 || item.cell.y === 5));
  const { after } = apply(snapshot, compiled);
  const bounds = boundsOf(after.voxels.filter(v => v.partId === 'new-body').map(v => v.cell))!;
  assert.equal(bounds.min.y, 7); assert.equal(bounds.size.x, 2); assert.equal(bounds.size.z, 2);
});

test('an empty world starts a free multi-part object at the virtual ground using its actual bounds', () => {
  const snapshot = new VoxelEngine().snapshot(), original = canonicalSnapshotJson(snapshot);
  const input: AiOperation[] = [...shape({ x: 2, y: 3, z: 2 }, { x: 10, y: -3, z: 7 }, { x: -4, y: 5, z: -2 }, 'other'),
    { op: 'define_part', part: { id: 'new-head', name: '头部', role: 'detail', groupId: 'new-object', origin: { x: 5, y: 5, z: 4 } } },
    { op: 'fill_shape', partId: 'new-head', shape: { kind: 'box', offset: zero, size: { x: 4, y: 2, z: 4 } }, color: '#CCAA55' }];
  const inputBefore = JSON.stringify(input), compiled = compileCreation(snapshot, input, { mode: 'on_surface' });
  const { after, engine } = apply(snapshot, compiled);
  assert.deepEqual(boundsOf(after.voxels.map(voxel => voxel.cell))!.min, zero);
  assert.deepEqual(boundsOf(after.voxels.filter(voxel => voxel.partId === 'new-body').map(voxel => voxel.cell))!.min, { x: 1, y: 0, z: 1 });
  assert.deepEqual(boundsOf(after.voxels.filter(voxel => voxel.partId === 'new-head').map(voxel => voxel.cell))!.min, { x: 0, y: 3, z: 0 });
  assert.equal(after.voxels.length, 44);
  assert.equal(after.parts.length, 2);
  assert.ok(after.parts.every(part => part.groupId === 'new-object'));
  assert.equal(canonicalSnapshotJson(snapshot), original);
  assert.equal(JSON.stringify(input), inputBefore);
  assert.ok(document(engine.undo().snapshot) === document(snapshot));
});

test('virtual ground does not replace a missing target in a nonempty world or another placement mode', () => {
  const empty = new VoxelEngine().snapshot(), input = shape({ x: 1, y: 1, z: 1 });
  assert.throws(() => compileCreation(ground(1, 1, 1, 0), input, { mode: 'on_surface' }), expectCode('LAYOUT_TARGET_REQUIRED'));
  for (const mode of ['near', 'in_surface'] as const) {
    assert.throws(() => compileCreation(empty, input, { mode }), expectCode('LAYOUT_TARGET_REQUIRED'));
  }
  assert.throws(() => compileCreation(empty, input, { mode: 'on_surface', targetPartId: 'missing-ground' }), expectCode('LAYOUT_TARGET_NOT_FOUND'));
  assert.throws(() => compileCreation(empty, input, { mode: 'on_surface', targetGroupId: 'missing-island' }), expectCode('LAYOUT_TARGET_NOT_FOUND'));
  assert.throws(() => compileCreation(empty, input, { mode: 'on_surface', position: zero }), expectCode('LAYOUT_INVALID_PLACEMENT'));
});

test('the live robot geometry can start on empty ground without changing its body, head, eyes or arms', () => {
  // Minimal geometry from the 2026-10-11 live failure; no provider response or usage data.
  const input: AiOperation[] = [
    { op: 'define_group', group: { id: 'robot', name: '小机器人' } },
    { op: 'define_part', part: { id: 'robot-body', name: '机器人身体', role: 'other', origin: zero, groupId: 'robot' } },
    { op: 'fill_shape', partId: 'robot-body', shape: { kind: 'box', offset: zero, size: { x: 7, y: 5, z: 5 } }, color: '#5aa9e6' },
    { op: 'define_part', part: { id: 'robot-head', name: '机器人头部', role: 'other', origin: zero, groupId: 'robot' } },
    { op: 'fill_shape', partId: 'robot-head', shape: { kind: 'box', offset: { x: 1, y: 5, z: 1 }, size: { x: 5, y: 4, z: 4 } }, color: '#e6e6e6' },
    { op: 'define_part', part: { id: 'robot-eye', name: '机器人眼睛', role: 'detail', origin: zero, groupId: 'robot' } },
    { op: 'patch_cells', partId: 'robot-eye', cells: [{ cell: { x: 2, y: 7, z: 0 }, color: '#1b1b1b' }, { cell: { x: 4, y: 7, z: 0 }, color: '#1b1b1b' }] },
    { op: 'define_part', part: { id: 'robot-arm', name: '机器人胳膊', role: 'detail', origin: zero, groupId: 'robot' } },
    { op: 'patch_cells', partId: 'robot-arm', cells: [-2, -1, 7, 8].map(x => ({ cell: { x, y: 3, z: 2 }, color: '#ffa94d' })) },
  ];
  const snapshot = new VoxelEngine().snapshot(), compiled = compileCreation(snapshot, input, { mode: 'on_surface' });
  const { after, engine } = apply(snapshot, compiled);
  const cells = (partId: string) => after.voxels.filter(voxel => voxel.partId === partId).map(voxel => voxel.cell);
  assert.deepEqual(boundsOf(after.voxels.map(voxel => voxel.cell))!.min, zero);
  assert.deepEqual(boundsOf(cells('robot-body'))!.size, { x: 7, y: 5, z: 5 });
  assert.deepEqual(boundsOf(cells('robot-head'))!.size, { x: 5, y: 4, z: 4 });
  assert.deepEqual(cells('robot-eye').map(key).sort(), ['4,7,0', '6,7,0']);
  assert.deepEqual(cells('robot-arm').map(key).sort(), ['0,3,2', '1,3,2', '10,3,2', '9,3,2']);
  assert.equal(cells('robot-body').length, 175); assert.equal(cells('robot-head').length, 80);
  assert.equal(after.voxels.length, 261); assert.equal(after.parts.length, 4);
  assert.ok(after.parts.every(part => part.groupId === 'robot'));
  assert.ok(document(engine.undo().snapshot) === document(snapshot));
});

test('absolute placement uses the true geometry minimum and rejects occupied exact coordinates without moving them', () => {
  const input = shape({ x: 2, y: 2, z: 2 }, { x: 10, y: -3, z: 7 }, { x: -4, y: 5, z: -2 });
  const empty = new VoxelEngine().snapshot(), position = { x: 20, y: 8, z: -10 };
  const compiled = compileCreation(empty, input, { mode: 'absolute', position });
  const { after } = apply(empty, compiled);
  assert.deepEqual(boundsOf(after.voxels.map(v => v.cell))!.min, position);
  assert.deepEqual(compiled.find(op => op.op === 'define_part')?.part.origin, { x: 24, y: 3, z: -8 });
  assert.throws(() => compileCreation(ground(), shape({ x: 1, y: 1, z: 1 }), { mode: 'absolute', position: { x: 2, y: 5, z: 2 } }),
    (error: unknown) => error instanceof LayoutError && error.details.engineCode === 'COLLISION');
  assert.throws(() => compileCreation(empty, input, { mode: 'absolute', position: { x: Number.MAX_SAFE_INTEGER, y: 8, z: -10 } }), expectCode('LAYOUT_OUT_OF_BOUNDS'));
  const distant = { x: 500, y: -200, z: 1000 };
  const far = apply(empty, compileCreation(empty, input, { mode: 'absolute', position: distant })).after;
  assert.deepEqual(boundsOf(far.voxels.map(voxel => voxel.cell))!.min, distant);
});

test('near placement supports one prefab and keeps the entire tree separate from the target house', () => {
  const snapshot = createInitialScene();
  const input: AiOperation[] = [{ op: 'add_prefab', prefab: 'tree', id: 'new-tree', name: '新树', origin: { x: 10, y: 2, z: -5 } }];
  const compiled = compileCreation(snapshot, input, { mode: 'near', targetGroupId: 'home' });
  assert.equal(compiled.length, 1); assert.equal(compiled[0].op, 'add_prefab');
  const { after } = apply(snapshot, compiled);
  const added = after.voxels.filter(v => v.partId.startsWith('new-tree-'));
  assert.equal(added.length, 276);
  const afterById = new Map(after.voxels.map(voxel => [voxel.id, voxel]));
  for (const voxel of snapshot.voxels) assert.deepEqual(afterById.get(voxel.id), voxel);
  const minY = Math.min(...added.map(v => v.cell.y)), oldCells = new Map(snapshot.voxels.map(v => [key(v.cell), v]));
  assert.ok(added.filter(v => v.cell.y === minY).every(v => oldCells.has(key({ ...v.cell, y: v.cell.y - 1 }))));
  const nextParts = after.parts.filter(p => p.groupId === 'new-tree'); assert.equal(nextParts.length, 2);
});

test('standalone prefab absolute placement accounts for its negative local canopy offsets', () => {
  const snapshot = new VoxelEngine().snapshot();
  const compiled = compileCreation(snapshot, [{ op: 'add_prefab', prefab: 'tree', id: 'new-tree', name: '树', origin: zero }], { mode: 'absolute', position: { x: 20, y: 4, z: -10 } });
  assert.deepEqual(boundsOf(apply(snapshot, compiled).after.voxels.map(v => v.cell))!.min, { x: 20, y: 4, z: -10 });
});

test('creation scope rejects existing IDs, mixed edits, missing targets and non-terrain excavation', () => {
  const snapshot = ground();
  assert.throws(() => compileCreation(snapshot, [...shape({ x: 1, y: 1, z: 1 }), { op: 'paint_part', partId: 'ground', color: '#FFFFFF', region: null }], { mode: 'on_surface', targetPartId: 'ground' }), expectCode('LAYOUT_CREATION_ONLY'));
  assert.throws(() => compileCreation(snapshot, shape({ x: 1, y: 1, z: 1 }), { mode: 'on_surface' }), expectCode('LAYOUT_TARGET_REQUIRED'));
  const existing = shape({ x: 1, y: 1, z: 1 });
  if (existing[0].op === 'define_group') existing[0].group.id = 'ground-group';
  if (existing[1].op === 'define_part') existing[1].part.groupId = 'ground-group';
  assert.throws(() => compileCreation(snapshot, existing, { mode: 'on_surface', targetPartId: 'ground' }), expectCode('LAYOUT_ID_CONFLICT'));
  assert.throws(() => compileCreation(createInitialScene(), shape({ x: 1, y: 1, z: 1 }), { mode: 'in_surface', targetGroupId: 'home' }), expectCode('LAYOUT_TERRAIN_REQUIRED'));
});

test('inset compilation counts cleanup operations and per-part patch size in explicit budgets', () => {
  const thirtyCells: AiOperation[] = [...shape({ x: 1, y: 1, z: 1 }).slice(0, 2), ...Array.from({ length: 30 }, (_, x): AiOperation => ({ op: 'patch_cells', partId: 'new-body', cells: [{ cell: { x, y: 0, z: 0 }, color: '#44BBEE' }] }))];
  assert.throws(() => compileCreation(ground(32, 1), thirtyCells, { mode: 'in_surface', targetPartId: 'ground' }), expectCode('LAYOUT_OPERATION_BUDGET'));
  assert.throws(() => compileCreation(ground(64, 64), shape({ x: 64, y: 1, z: 64 }), { mode: 'in_surface', targetPartId: 'ground' }), expectCode('LAYOUT_PATCH_BUDGET'));
  assert.throws(() => compileCreation(ground(64, 64, 5), shape({ x: 64, y: 1, z: 64 }), { mode: 'in_surface', targetPartId: 'ground', depth: 4 }), expectCode('LAYOUT_BATCH_BUDGET'));
});

test('candidate exhaustion is reported as a bounded search rather than a claim that all space is occupied', () => {
  const snapshot = ground(100, 50, 1, 0, { x: -50, y: 0, z: -25 });
  obstacle(snapshot, snapshot.voxels.map(v => ({ ...v.cell, y: 1 })));
  assert.throws(() => compileCreation(snapshot, shape({ x: 1, y: 1, z: 1 }), { mode: 'on_surface', targetPartId: 'ground' }),
    (error: unknown) => error instanceof LayoutError && error.code === 'LAYOUT_SEARCH_LIMIT' && error.details.candidateCount === MAX_LAYOUT_CANDIDATES);
});
