import { assertCell, MAX_CANDIDATE_CELLS, type Vec3 } from './coordinates.ts';
import type { ShapeDefinition } from '../../protocol/src/index.ts';

export function generateCells(definition: Pick<ShapeDefinition, 'kind' | 'origin' | 'size'> & { color?: string; axis?: 'x' | 'y' | 'z' }): Vec3[] {
  const { kind, origin, size } = definition;
  const volume = size.x * size.y * size.z;
  if (volume > MAX_CANDIDATE_CELLS) throw new Error(`候选空间超过 ${MAX_CANDIDATE_CELLS.toLocaleString()} 格，请减小尺寸`);
  assertCell(origin);
  assertCell({ x: origin.x + size.x - 1, y: origin.y + size.y - 1, z: origin.z + size.z - 1 });
  const cells: Vec3[] = [];
  // Membership is sampled at cell centers. Store only integer cell coordinates.
  for (let y = 0; y < size.y; y++) for (let z = 0; z < size.z; z++) for (let x = 0; x < size.x; x++) {
    const nx = (x + 0.5 - size.x / 2) / (size.x / 2);
    const ny = (y + 0.5 - size.y / 2) / (size.y / 2);
    const nz = (z + 0.5 - size.z / 2) / (size.z / 2);
    if (kind === 'ellipsoid' && nx * nx + ny * ny + nz * nz > 1 + 1e-12) continue;
    const radial = definition.axis === 'x' ? ny * ny + nz * nz : definition.axis === 'z' ? nx * nx + ny * ny : nx * nx + nz * nz;
    if (kind === 'cylinder' && radial > 1 + 1e-12) continue;
    if (kind === 'wedge' && y + 0.5 > (x + 0.5) * size.y / size.x + 1e-12) continue;
    cells.push({ x: origin.x + x, y: origin.y + y, z: origin.z + z });
  }
  return cells;
}
