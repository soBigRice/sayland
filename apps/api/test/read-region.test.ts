import test from 'node:test';
import assert from 'node:assert/strict';
import type { Part, SceneSnapshot } from '../../../packages/protocol/src/index.ts';
import { readRegion, readRegionSchema, SceneQueryError, type RegionRead } from '../src/scene-context.ts';

const part: Part = { id: 'detail', name: '实际细节', role: 'detail', origin: { x: -100, y: 30, z: -50 }, groupId: 'object' };
function scene(cells: { x: number; y: number; z: number; color: string }[]): SceneSnapshot {
  return { schemaVersion: 2, revision: 5, grid: { cellSize: 1, up: '+Y', front: '+Z', coordinates: 'minimum-corner' },
    model: { id: 'fixture', name: '局部读取测试' }, source: null, groups: [{ id: 'object', name: '原物件' }], parts: [structuredClone(part)],
    voxels: cells.map((cell, index) => ({ id: index + 1, partId: part.id, color: cell.color,
      cell: { x: part.origin.x + cell.x, y: part.origin.y + cell.y, z: part.origin.z + cell.z } })) };
}
function decoded(read: RegionRead): string[] {
  if (read.encoding === 'cells') return read.cells.map(([x, y, z, color]) => `${x},${y},${z}:${read.palette[color]}`).sort();
  const { offset, palette, layers } = read.slices;
  return layers.flatMap(layer => layer.rows.flatMap((row, z) => [...row].flatMap((symbol, x) => symbol === '.' ? []
    : [`${offset.x + x},${offset.y + layer.y},${offset.z + z}:${palette.find(entry => entry.symbol === symbol)!.color}`]))).sort();
}
const query = { revision: 5, partId: part.id, region: null };

test('lossless region reads preserve mixed colors, negative origins and exact local coordinates', () => {
  const source = scene([{ x: 2, y: -3, z: 5, color: '#ff00aa' }, { x: 3, y: -3, z: 5, color: '#00FF77' }]);
  const before = structuredClone(source), result = readRegion(source, query);
  assert.equal(result.encoding, 'cells'); assert.equal(result.coordinateSpace, 'part-local-minimum-corner');
  assert.deepEqual(decoded(result), ['2,-3,5:#ff00aa', '3,-3,5:#00FF77']);
  assert.deepEqual(result.worldBounds, { min: { x: -98, y: 27, z: -45 }, max: { x: -97, y: 27, z: -45 } });
  assert.deepEqual(result.localBounds, { min: { x: 2, y: -3, z: 5 }, max: { x: 3, y: -3, z: 5 } });
  assert.equal(result.part.groupId, 'object'); assert.equal(result.complete, true);
  result.part.origin.x = 0; assert.deepEqual(source, before);
});

test('dense layers round-trip sparse holes and each color without repeating the cells encoding', () => {
  const cells = [];
  for (let y = -2; y < 2; y++) for (let z = 4; z < 10; z++) for (let x = 0; x < 8; x++) {
    if (x === 3 && y === 0 && z === 5) continue;
    cells.push({ x, y, z, color: (x + z) % 2 ? '#AABBCC' : '#001122' });
  }
  const result = readRegion(scene(cells), query);
  assert.equal(result.encoding, 'layers'); assert.equal('cells' in result, false);
  assert.deepEqual(decoded(result), cells.map(cell => `${cell.x},${cell.y},${cell.z}:${cell.color}`).sort());
  assert.equal(result.count, 191);
});

test('local region filtering excludes other cells and empty geometry is explicit', () => {
  const source = scene([{ x: 2, y: -3, z: 5, color: '#FF0000' }, { x: 3, y: -3, z: 5, color: '#0000FF' }]);
  const selected = readRegion(source, { ...query, region: { min: { x: 2, y: -3, z: 5 }, max: { x: 2, y: -3, z: 5 } } });
  assert.deepEqual(decoded(selected), ['2,-3,5:#FF0000']);
  const empty = readRegion(source, { ...query, region: { min: { x: 9, y: 0, z: 0 }, max: { x: 10, y: 0, z: 0 } } });
  assert.equal(empty.count, 0); assert.equal(empty.localBounds, null); assert.deepEqual(decoded(empty), []);
  assert.equal(readRegionSchema.safeParse({ ...query, region: { min: { x: 2000, y: 0, z: 0 }, max: { x: 2001, y: 0, z: 0 } } }).success, true);
});

test('over-budget reads reject instead of returning partial geometry; thin local reads remain available', () => {
  const cells = Array.from({ length: 4097 }, (_, index) => ({ x: index % 17, y: Math.floor(index / 289), z: Math.floor(index / 17) % 17, color: '#123456' }));
  const source = scene(cells);
  assert.throws(() => readRegion(source, query), error => error instanceof SceneQueryError && error.code === 'REGION_TOO_LARGE');
  const slice = readRegion(source, { ...query, region: { min: { x: 0, y: 0, z: 0 }, max: { x: 16, y: 0, z: 16 } } });
  assert.equal(slice.count, 289); assert.equal(decoded(slice).length, 289);
});

test('read_region rejects stale revisions, absent parts and inverted local regions', () => {
  const source = scene([]);
  assert.throws(() => readRegion(source, { ...query, revision: 4 }), error => error instanceof SceneQueryError && error.code === 'STALE_REVISION');
  assert.throws(() => readRegion(source, { ...query, partId: 'absent' }), error => error instanceof SceneQueryError && error.code === 'PART_NOT_FOUND');
  assert.throws(() => readRegion(source, { ...query, region: { min: { x: 2, y: 0, z: 0 }, max: { x: 1, y: 0, z: 0 } } }), error => error instanceof SceneQueryError && error.code === 'INVALID_QUERY');
});

test('read_region returns distant local coordinates exactly and rejects numeric subtraction overflow', () => {
  const source = scene([{ x: 2000, y: -500, z: 1000, color: '#00FF77' }]);
  const region = { min: { x: 2000, y: -500, z: 1000 }, max: { x: 2000, y: -500, z: 1000 } };
  assert.deepEqual(decoded(readRegion(source, { ...query, region })), ['2000,-500,1000:#00FF77']);
  source.parts[0].origin.x = Number.MIN_SAFE_INTEGER;
  source.voxels[0].cell.x = Number.MAX_SAFE_INTEGER;
  assert.throws(() => readRegion(source, query), /安全整数精度/);
  for (const x of [NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(readRegionSchema.safeParse({ ...query, region: { ...region, min: { ...region.min, x } } }).success, false);
  }
});
