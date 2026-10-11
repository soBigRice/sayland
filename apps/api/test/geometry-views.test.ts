import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import type { Part, SceneSnapshot } from '../../../packages/protocol/src/index.ts';
import { GeometryViewError, modelViews, VIEW_HEADER, VIEW_SIZE, type ModelViews } from '../src/geometry-views.ts';

const part: Part = { id: 'sample', name: '实测部件', role: 'other', origin: { x: 0, y: 0, z: 0 }, groupId: 'object' };
const scope = { revision: 7, groupIds: null, partIds: null, region: null };
function scene(cells: { x: number; y: number; z: number; color: string }[]): SceneSnapshot {
  return { schemaVersion: 2, revision: 7, grid: { cellSize: 1, up: '+Y', front: '+Z', coordinates: 'minimum-corner' },
    model: { id: 'fixture', name: '视图测试' }, source: null, groups: [{ id: 'object', name: '测试物件' }], parts: [structuredClone(part)],
    voxels: cells.map(({ color, ...cell }, index) => ({ id: index + 1, partId: part.id, color, cell })) };
}
function decodePng(view: ModelViews) {
  assert.match(view.image, /^data:image\/png;base64,/);
  const file = Buffer.from(view.image.split(',')[1], 'base64');
  assert.deepEqual([...file.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const names: string[] = [], compressed: Buffer[] = [];
  for (let offset = 8; offset < file.length;) {
    const length = file.readUInt32BE(offset), name = file.toString('ascii', offset + 4, offset + 8);
    const payload = file.subarray(offset + 4, offset + 8 + length), data = payload.subarray(4);
    let crc = 0xffffffff;
    for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : crc >>> 1; }
    assert.equal(file.readUInt32BE(offset + length + 8), (crc ^ 0xffffffff) >>> 0);
    if (name === 'IHDR') { assert.equal(data.readUInt32BE(0), view.width); assert.equal(data.readUInt32BE(4), view.height); assert.deepEqual([...data.subarray(8)], [8, 6, 0, 0, 0]); }
    if (name === 'IDAT') compressed.push(data);
    names.push(name); offset += length + 12;
  }
  assert.deepEqual(names, ['IHDR', 'IDAT', 'IEND']);
  const rows = inflateSync(Buffer.concat(compressed)), stride = view.width * 4 + 1;
  assert.equal(rows.length, view.height * stride);
  for (let y = 0; y < view.height; y++) assert.equal(rows[y * stride], 0);
  return (x: number, y: number) => [...rows.subarray(y * stride + 1 + x * 4, y * stride + 1 + x * 4 + 4)];
}
function pixel(view: ModelViews, plane: number, u: number, v: number, width: number, height: number) {
  const x = plane * VIEW_SIZE + Math.floor((VIEW_SIZE - width * view.pixelsPerVoxel) / 2 + (u + .5) * view.pixelsPerVoxel);
  const y = VIEW_HEADER + Math.floor((VIEW_SIZE - height * view.pixelsPerVoxel) / 2 + (v + .5) * view.pixelsPerVoxel);
  return decodePng(view)(x, y);
}

test('PNG is valid and each view chooses the nearest actual face on its documented axis', () => {
  const source = scene([{ x: 0, y: 0, z: 0, color: '#FF0000' }, { x: 0, y: 0, z: 1, color: '#0000FF' },
    { x: 1, y: 0, z: 0, color: '#00FF00' }, { x: 0, y: 1, z: 0, color: '#FFFF00' }]);
  const before = structuredClone(source), view = modelViews(source, scope);
  assert.equal(view.width, 960); assert.equal(view.height, 352); assert.equal(view.revision, 7); assert.equal(view.voxelCount, 4);
  assert.deepEqual(pixel(view, 0, 0, 1, 2, 2), [0, 0, 255, 255]);
  assert.deepEqual(pixel(view, 1, 1, 1, 2, 2), [0, 255, 0, 255]);
  assert.deepEqual(pixel(view, 2, 0, 0, 2, 2), [255, 255, 0, 255]);
  assert.deepEqual(pixel(view, 1, 0, 1, 2, 2), [0, 0, 255, 255]);
  assert.deepEqual(source, before);
});

test('all views use a shared voxel scale and fitting is independent of world origin', () => {
  const cells = [];
  for (let z = 0; z < 1; z++) for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) cells.push({ x, y, z, color: '#123456' });
  const source = scene(cells), view = modelViews(source, scope), pixels = decodePng(view);
  const extents = [0, 1, 2].map(plane => {
    let minX = VIEW_SIZE, minY = VIEW_SIZE, maxX = -1, maxY = -1;
    for (let y = 0; y < VIEW_SIZE; y++) for (let x = 0; x < VIEW_SIZE; x++) {
      const color = pixels(plane * VIEW_SIZE + x, VIEW_HEADER + y);
      if (color[0] === 244 && color[1] === 245 && color[2] === 242) continue;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return [maxX - minX + 1, maxY - minY + 1];
  });
  assert.deepEqual(extents, [[296, 148], [74, 148], [296, 74]]);
  for (const voxel of source.voxels) { voxel.cell.x -= 90; voxel.cell.y += 30; voxel.cell.z -= 70; }
  source.parts[0].origin = { x: -90, y: 30, z: -70 };
  assert.equal(modelViews(source, scope).image, view.image);
});

test('group/part union and local close-ups select exact committed cells without exposing other objects', () => {
  const source = scene([{ x: -98, y: 27, z: -45, color: '#AA0000' }, { x: -97, y: 27, z: -45, color: '#00AA00' }]);
  source.parts[0].origin = { x: -100, y: 30, z: -50 };
  source.parts.push({ ...part, id: 'other', groupId: null });
  source.voxels.push({ id: 3, partId: 'other', cell: { x: 90, y: 0, z: 0 }, color: '#0000AA' });
  assert.equal(modelViews(source, { ...scope, groupIds: ['object'] }).voxelCount, 2);
  assert.equal(modelViews(source, { ...scope, groupIds: ['object'], partIds: ['other'] }).voxelCount, 3);
  const close = modelViews(source, { ...scope, partIds: ['sample'], region: { min: { x: 2, y: -3, z: 5 }, max: { x: 2, y: -3, z: 5 } } });
  assert.equal(close.voxelCount, 1); assert.deepEqual(close.bounds.min, { x: -98, y: 27, z: -45 });
  assert.equal(close.parts[0].groupId, 'object'); assert.deepEqual(close.groups[0].partIds, ['sample']);
});

test('actual holes stay empty in projection instead of filling bounding boxes', () => {
  const cells = [];
  for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) if (x !== 1 || z !== 1) cells.push({ x, y: 0, z, color: '#4488CC' });
  const view = modelViews(scene(cells), scope);
  assert.equal(view.voxelCount, 8); assert.deepEqual(pixel(view, 2, 1, 1, 3, 3), [244, 245, 242, 255]);
});

test('view metadata truncation is explicit and never truncates geometry or actual group membership', () => {
  const source = scene([]); source.parts = [];
  for (let index = 0; index < 160; index++) {
    source.parts.push({ ...part, id: `part${index}` });
    source.voxels.push({ id: index + 1, partId: `part${index}`, color: '#001122', cell: { x: index - 80, y: 0, z: 0 } });
  }
  const view = modelViews(source, scope);
  assert.equal(view.parts.length, 128); assert.equal(view.partsComplete, false); assert.equal(view.partCount, 160);
  assert.equal(view.voxelCount, 160); assert.equal(view.groups[0].partIds.length, 160); assert.equal(view.bounds.size.x, 160);
});

test('queries reject obsolete versions, invalid scopes, missing objects and empty selections', () => {
  const source = scene([{ x: 0, y: 0, z: 0, color: '#123456' }]);
  const fails = (input: unknown, code: GeometryViewError['code']) => assert.throws(() => modelViews(source, input), error => error instanceof GeometryViewError && error.code === code);
  fails({ ...scope, revision: 6 }, 'STALE_REVISION');
  fails({ ...scope, groupIds: ['missing'] }, 'GROUP_NOT_FOUND'); fails({ ...scope, partIds: ['missing'] }, 'PART_NOT_FOUND');
  fails({ ...scope, region: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } } }, 'INVALID_QUERY');
  fails({ ...scope, partIds: ['sample'], region: { min: { x: 9, y: 0, z: 0 }, max: { x: 9, y: 0, z: 0 } } }, 'EMPTY_VIEW');
});
