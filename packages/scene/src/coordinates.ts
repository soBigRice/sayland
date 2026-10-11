export type Vec3 = Readonly<{ x: number; y: number; z: number }>;
export const CHUNK_SIZE = 16;
import { COORD_MIN, COORD_MAX, MAX_BATCH_CELLS, MAX_CANDIDATE_CELLS, MAX_SCENE_VOXELS } from '../../protocol/src/index.ts';
export { COORD_MIN, COORD_MAX, MAX_BATCH_CELLS, MAX_CANDIDATE_CELLS };
export const MAX_SCENE_CELLS = MAX_SCENE_VOXELS;

export const cellKey = (p: Vec3): string => `${p.x},${p.y},${p.z}`;
export const cellCenter = (p: Vec3): Vec3 => ({ x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 });
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });

// Cell coordinates name the minimum corner. floor is essential for negative chunks.
export function chunkAddress(p: Vec3): { key: string; origin: Vec3; local: Vec3 } {
  const chunk = { x: Math.floor(p.x / CHUNK_SIZE), y: Math.floor(p.y / CHUNK_SIZE), z: Math.floor(p.z / CHUNK_SIZE) };
  const origin = { x: chunk.x * CHUNK_SIZE, y: chunk.y * CHUNK_SIZE, z: chunk.z * CHUNK_SIZE };
  return { key: cellKey(chunk), origin, local: { x: p.x - origin.x, y: p.y - origin.y, z: p.z - origin.z } };
}

export function assertCell(p: Vec3): void {
  for (const value of [p.x, p.y, p.z]) {
    if (!Number.isSafeInteger(value) || value < COORD_MIN || value > COORD_MAX) {
      throw new Error(`方块坐标超出小岛范围（-128 到 128），请移近一点`);
    }
  }
}

// Integer corner formulas avoid losing the half-cell at large world coordinates.
export function rotateCell(cell: Vec3, axis: 'x' | 'y' | 'z', turns: number, pivot: Vec3): Vec3 {
  let { x, y, z } = { x: cell.x - pivot.x, y: cell.y - pivot.y, z: cell.z - pivot.z };
  // A pivot-relative displacement can exceed scene bounds while the final cell remains valid.
  if (![x, y, z].every(Number.isSafeInteger)) throw new Error('旋转坐标失去整数精度');
  for (let i = 0; i < ((turns % 4) + 4) % 4; i++) {
    if (axis === 'x') [y, z] = [-z - 1, y];
    if (axis === 'y') [x, z] = [z, -x - 1];
    if (axis === 'z') [x, y] = [-y - 1, x];
    if (![x, y, z].every(Number.isSafeInteger)) throw new Error('旋转坐标失去整数精度');
  }
  const result = { x: x + pivot.x, y: y + pivot.y, z: z + pivot.z };
  assertCell(result); return result;
}

export function boundsOf(cells: readonly Vec3[]): { min: Vec3; max: Vec3; size: Vec3 } | null {
  if (!cells.length) return null;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of cells) for (const axis of ['x', 'y', 'z'] as const) {
    min[axis] = Math.min(min[axis], p[axis]);
    max[axis] = Math.max(max[axis], p[axis]);
  }
  return { min, max, size: { x: max.x - min.x + 1, y: max.y - min.y + 1, z: max.z - min.z + 1 } };
}
