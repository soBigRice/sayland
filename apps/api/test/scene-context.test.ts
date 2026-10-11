import test from 'node:test';
import assert from 'node:assert/strict';
import { type ChatRequest, type Part, type SceneSnapshot } from '../../../packages/protocol/src/index.ts';
import { inspectScene, sceneQuerySchema, sceneSummary, SceneQueryError, type SceneQuery, type OccupancyRun } from '../src/scene-context.ts';

type Vec3 = SceneSnapshot['voxels'][number]['cell'];
type Summary = {
  coordinateSpace: string;
  boundsSemantics: string;
  surfaceSemantics: string;
  groups: { id: string; name: string; partIds: string[]; partCount: number; voxelCount: number; worldBounds: { min: Vec3; max: Vec3 } | null }[];
  ungroupedPartIds: string[];
  parts: {
    id: string; name: string; role: Part['role']; origin: Vec3; voxelCount: number;
    worldBounds: { min: Vec3; max: Vec3 } | null;
    colors: { color: string; count: number }[]; totalColors: number; colorsComplete: boolean;
    surface?: { columnCount: number; levelCount: number; levelsComplete: boolean; levels: {
      occupiedY: number; baseY: number; baseWithinBounds: boolean; columns: number;
      baseCellOccupiedColumns: number; columnsWithHigherOccupancy: number;
    }[] };
  }[];
};
const origin = { x: 0, y: 0, z: 0 };
const part = (id: string, role: Part['role'] = 'other', at = origin): Part => ({ id, name: id, role, origin: { ...at } });
const voxel = (id: number, partId: string, cell: Vec3, color = '#77AA44'): SceneSnapshot['voxels'][number] => ({ id, partId, cell, color });
function snapshot(parts: Part[], voxels: SceneSnapshot['voxels']): SceneSnapshot {
  return { schemaVersion: 2, revision: 7, nextVoxelId: Math.max(0, ...voxels.map(v => v.id)) + 1,
    grid: { cellSize: 1, up: '+Y', front: '+Z', coordinates: 'minimum-corner' },
    model: { id: 'fixture', name: '测试小岛' }, source: null, parts, voxels };
}
function elevatedScene(): SceneSnapshot {
  return snapshot([part('ground', 'terrain', { x: 10, y: 3, z: -4 }), part('pond', 'water', { x: -8, y: -3, z: 2 }), part('obstacle', 'detail')], [
    voxel(1, 'ground', { x: 10, y: 6, z: -4 }), voxel(2, 'ground', { x: 11, y: 6, z: -4 }),
    voxel(3, 'ground', { x: 12, y: 6, z: -4 }), voxel(4, 'ground', { x: 10, y: 5, z: -4 }),
    voxel(5, 'pond', { x: -8, y: -2, z: 2 }, '#44BBEE'), voxel(6, 'pond', { x: -7, y: -2, z: 2 }, '#44BBEE'),
    voxel(7, 'pond', { x: -8, y: -3, z: 2 }, '#3399CC'),
    voxel(8, 'obstacle', { x: -8, y: -1, z: 2 }, '#AA8844'), voxel(9, 'obstacle', { x: 11, y: 12, z: -4 }, '#AA8844'),
  ]);
}
const query = (min: Vec3, max: Vec3, partId: string | null = null, offset = 0): SceneQuery => ({ region: { min, max }, partId, offset });
const summary = (scene: SceneSnapshot, text = '自由创造') => sceneSummary({ snapshot: scene, text, requestId: 'fixture-request', messages: [] } satisfies ChatRequest) as Summary;
function cellsOf(runs: OccupancyRun[]): string[] {
  return runs.flatMap(run => Array.from({ length: run.xMax - run.xMin + 1 }, (_, index) => `${run.xMin + index},${run.y},${run.z}:${run.partId}`));
}

test('summary reports measured nonzero terrain and water surfaces, including hidden obstacles', () => {
  const result = summary(elevatedScene());
  const ground = result.parts.find(item => item.id === 'ground')!;
  assert.deepEqual(ground.origin, { x: 10, y: 3, z: -4 });
  assert.deepEqual(ground.worldBounds, { min: { x: 10, y: 5, z: -4 }, max: { x: 12, y: 6, z: -4 } });
  assert.deepEqual(ground.surface?.levels, [{ occupiedY: 6, baseY: 7, baseWithinBounds: true,
    columns: 3, baseCellOccupiedColumns: 0, columnsWithHigherOccupancy: 1 }]);
  const water = result.parts.find(item => item.id === 'pond')!;
  assert.deepEqual(water.surface?.levels, [{ occupiedY: -2, baseY: -1, baseWithinBounds: true,
    columns: 2, baseCellOccupiedColumns: 1, columnsWithHigherOccupancy: 1 }]);
  assert.equal(water.role, 'water');
  assert.deepEqual(water.colors, [{ color: '#44BBEE', count: 2 }, { color: '#3399CC', count: 1 }]);
  assert.match(result.boundsSemantics, /不代表内部实心/);
  assert.match(result.surfaceSemantics, /不是物件完整体积可放置保证/);
});

test('summary is independent of tree, river, boat or other request words', () => {
  const scene = elevatedScene();
  assert.deepEqual(summary(scene, '种一棵树'), summary(scene, '加一条河，让船航行'));
  assert.ok(!JSON.stringify(summary(scene, 'tree')).includes('verifiedTreePlacements'));
});

test('summary groups strictly follow groupId and keep similarly named legacy parts ungrouped', () => {
  const scene = snapshot([
    { ...part('shared-prefix-a'), groupId: 'first' }, { ...part('shared-prefix-b'), groupId: 'second' },
    part('shared-prefix-legacy'), { ...part('unrelated-id'), groupId: 'first' },
  ], [voxel(1, 'shared-prefix-a', { x: 1, y: 2, z: 3 }), voxel(2, 'shared-prefix-b', { x: 20, y: 0, z: 0 }),
    voxel(3, 'shared-prefix-legacy', { x: 2, y: 2, z: 3 }), voxel(4, 'unrelated-id', { x: 3, y: 4, z: 5 })]);
  scene.groups = [{ id: 'first', name: '第一件' }, { id: 'second', name: '第二件' }, { id: 'empty-group', name: '空物件组' }];
  const result = summary(scene);
  assert.deepEqual(result.groups[0], { id: 'first', name: '第一件', partIds: ['shared-prefix-a', 'unrelated-id'], partCount: 2, voxelCount: 2,
    worldBounds: { min: { x: 1, y: 2, z: 3 }, max: { x: 3, y: 4, z: 5 } } });
  assert.deepEqual(result.groups[1].partIds, ['shared-prefix-b']);
  assert.equal(result.groups[2].voxelCount, 0); assert.equal(result.groups[2].worldBounds, null);
  assert.deepEqual(result.ungroupedPartIds, ['shared-prefix-legacy']);
  const inspection = inspectScene(scene, query({ x: 0, y: 0, z: 0 }, { x: 21, y: 5, z: 5 }));
  assert.equal(inspection.parts.find(item => item.id === 'shared-prefix-a')!.groupId, 'first');
  assert.equal(inspection.parts.find(item => item.id === 'shared-prefix-legacy')!.groupId, null);
});

test('world-coordinate inspection preserves sparse holes instead of filling the bounding box', () => {
  const cells: SceneSnapshot['voxels'] = [];
  for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) {
    if (x === 1 && z === 1) continue;
    cells.push(voxel(cells.length + 1, 'shell', { x, y: 5, z }, x % 2 ? '#CC5522' : '#77AA44'));
  }
  const scene = snapshot([part('shell', 'other', { x: 8, y: 2, z: 9 })], cells.reverse());
  const result = inspectScene(scene, query({ x: 0, y: 5, z: 0 }, { x: 2, y: 5, z: 2 }));
  assert.equal(result.coordinateSpace, 'world-minimum-corner');
  assert.equal(result.occupiedVoxelCount, 8); assert.equal(result.totalRuns, 4);
  assert.ok(!cellsOf(result.runs).includes('1,5,1:shell'));
  assert.deepEqual(result.matchedBounds, { min: { x: 0, y: 5, z: 0 }, max: { x: 2, y: 5, z: 2 } });
  assert.equal(result.parts[0].matchedVoxelCount, 8); assert.equal(result.complete, true);
  assert.deepEqual(result.runs[0], { y: 5, z: 0, xMin: 0, xMax: 2, partId: 'shell', color: null, mixedColor: true });
});

test('occupancy runs merge alternating colors honestly and split at different owners', () => {
  const scene = snapshot([part('water', 'water'), part('pier', 'detail')], [
    voxel(1, 'water', { x: 0, y: 3, z: 0 }, '#33BBEE'), voxel(2, 'water', { x: 1, y: 3, z: 0 }, '#44CCFF'),
    voxel(3, 'water', { x: 2, y: 3, z: 0 }, '#33BBEE'), voxel(4, 'pier', { x: 3, y: 3, z: 0 }, '#AA8844'),
    voxel(5, 'water', { x: 4, y: 3, z: 0 }, '#33BBEE'),
  ]);
  const result = inspectScene(scene, query({ x: 0, y: 3, z: 0 }, { x: 4, y: 3, z: 0 }));
  assert.equal(result.totalRuns, 3);
  assert.deepEqual(result.runs[0], { y: 3, z: 0, xMin: 0, xMax: 2, partId: 'water', color: null, mixedColor: true });
  assert.deepEqual(result.runs[1], { y: 3, z: 0, xMin: 3, xMax: 3, partId: 'pier', color: '#AA8844', mixedColor: false });
  assert.equal(result.parts.find(p => p.id === 'water')!.matchedVoxelCount, 4);
  assert.deepEqual(result.parts.find(p => p.id === 'water')!.colors, [{ color: '#33BBEE', count: 3 }, { color: '#44CCFF', count: 1 }]);
});

test('unfiltered queries expose other parts blocking the candidate surface; part filters are explicit', () => {
  const scene = elevatedScene();
  const region = query({ x: -8, y: -3, z: 2 }, { x: -7, y: 0, z: 2 });
  const all = inspectScene(scene, region);
  assert.equal(all.occupiedVoxelCount, 4);
  assert.ok(all.runs.some(run => run.partId === 'obstacle' && run.y === -1));
  const waterOnly = inspectScene(scene, { ...region, partId: 'pond' });
  assert.equal(waterOnly.occupiedVoxelCount, 3);
  assert.ok(waterOnly.runs.every(run => run.partId === 'pond'));
  assert.match(waterOnly.semantics, /判断空位和碰撞必须以partId:null查询/);
});

test('pagination returns every sparse occupied cell exactly once with no hidden truncation', () => {
  const voxels: SceneSnapshot['voxels'] = [];
  for (let z = 0; z < 20; z++) for (let x = 0; x < 32; x++) voxels.push(voxel(voxels.length + 1, 'dots', { x: x * 2, y: 9, z }));
  const scene = snapshot([part('dots')], voxels);
  const collected: string[] = [], lengths: number[] = [];
  let offset = 0;
  while (true) {
    const page = inspectScene(scene, query({ x: 0, y: 9, z: 0 }, { x: 63, y: 9, z: 19 }, null, offset));
    assert.equal(page.totalRuns, 640); assert.equal(page.occupiedVoxelCount, 640);
    assert.equal(page.offset, offset); assert.equal(page.limit, 256);
    assert.ok(page.runs.length <= 256);
    collected.push(...cellsOf(page.runs)); lengths.push(page.runs.length);
    if (page.complete) { assert.equal(page.nextOffset, null); break; }
    assert.equal(page.nextOffset, offset + 256); offset = page.nextOffset!;
  }
  assert.deepEqual(lengths, [256, 256, 128]);
  assert.equal(new Set(collected).size, 640);
  assert.deepEqual(new Set(collected), new Set(voxels.map(v => `${v.cell.x},${v.cell.y},${v.cell.z}:${v.partId}`)));
});

test('invalid coordinates, inverted or oversized regions and invalid offsets fail explicitly', () => {
  const scene = elevatedScene();
  const invalid: unknown[] = [
    query({ x: -129, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
    query({ x: 0, y: 0, z: 0 }, { x: 129, y: 0, z: 0 }),
    query({ x: 0.5, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }),
    query({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
    query({ x: 0, y: 0, z: 0 }, { x: 64, y: 0, z: 0 }),
    query({ x: 0, y: 0, z: 0 }, { x: 40, y: 40, z: 40 }),
    query(origin, origin, null, -1), { ...query(origin, origin), ignoreCollision: true },
  ];
  for (const input of invalid) {
    assert.equal(sceneQuerySchema.safeParse(input).success, false);
    assert.throws(() => inspectScene(scene, input), (error: unknown) => error instanceof SceneQueryError && error.code === 'INVALID_QUERY');
  }
  assert.throws(() => inspectScene(scene, query(origin, origin, 'missing')), (error: unknown) => error instanceof SceneQueryError && error.code === 'PART_NOT_FOUND');
  assert.throws(() => inspectScene(scene, query(origin, origin, null, 1)), (error: unknown) => error instanceof SceneQueryError && error.code === 'OFFSET_OUT_OF_RANGE');
});

test('summary and inspection preserve the snapshot, including after consumers mutate returned metadata', () => {
  const scene = elevatedScene(); const before = JSON.stringify(scene);
  const result = inspectScene(scene, query({ x: 9, y: 0, z: -5 }, { x: 13, y: 13, z: -3 }));
  const context = summary(scene);
  result.parts[0].origin.x = 99; result.parts[0].matchedBounds.min.y = 99;
  context.parts[0].origin.x = 88; context.parts[0].worldBounds!.min.x = 88;
  assert.equal(JSON.stringify(scene), before);
});

test('empty scenes invent neither surfaces nor occupied geometry', () => {
  const scene = snapshot([], []);
  assert.deepEqual(summary(scene).parts, []);
  const result = inspectScene(scene, query(origin, origin));
  assert.equal(result.occupiedVoxelCount, 0); assert.equal(result.totalRuns, 0); assert.equal(result.matchedBounds, null);
  assert.deepEqual(result.runs, []); assert.deepEqual(result.parts, []);
  assert.equal(result.complete, true); assert.equal(result.nextOffset, null);
});

test('bounded summary lists disclose omitted colors and surface levels and reject an out-of-world base', () => {
  const voxels = Array.from({ length: 9 }, (_, index) => voxel(index + 1, 'stairs', { x: index, y: index, z: 0 }, `#${index.toString(16).padStart(6, '0')}`));
  voxels.push(voxel(10, 'ceiling', { x: 20, y: 128, z: 0 }));
  const scene = snapshot([part('stairs', 'terrain'), part('ceiling', 'water')], voxels);
  const result = summary(scene);
  const stairs = result.parts.find(p => p.id === 'stairs')!;
  assert.equal(stairs.totalColors, 9); assert.equal(stairs.colorsComplete, false); assert.equal(stairs.colors.length, 8);
  assert.equal(stairs.surface!.levelCount, 9); assert.equal(stairs.surface!.levelsComplete, false); assert.equal(stairs.surface!.levels.length, 8);
  const ceiling = result.parts.find(p => p.id === 'ceiling')!;
  assert.equal(ceiling.surface!.levels[0].baseY, 129); assert.equal(ceiling.surface!.levels[0].baseWithinBounds, false);
});
