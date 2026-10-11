import { z } from 'zod';
import {
  MAX_BATCH_CELLS, MAX_CANDIDATE_CELLS, MAX_SCENE_VOXELS,
  partIdSchema, groupIdSchema, type AiOperation, type Part, type SceneSnapshot,
} from '../../../packages/protocol/src/index.ts';
import { EngineError, VoxelEngine } from '../../../packages/scene/src/index.ts';

type Cell = SceneSnapshot['voxels'][number]['cell'];
type Voxel = SceneSnapshot['voxels'][number];
type Patch = Extract<AiOperation, { op: 'patch_cells' }>;
interface Column { x: number; z: number; voxels: Voxel[]; top: Voxel }

export const surfaceExpansionSpecSchema = z.object({
  partId: partIdSchema,
  amount: z.number().int().min(1).max(4),
  axes: z.enum(['x', 'z', 'xz']),
  terrainGroupId: groupIdSchema.optional().describe('与terrainPartId二选一。多层地形只传terrainGroupId，授权组内实际terrain部件，不能同时传某一草地层partId。'),
  terrainPartId: partIdSchema.optional().describe('与terrainGroupId二选一。只授权这个terrain部件；需要草地、土壤等多层地形时只用terrainGroupId。'),
}).strict();
export type SurfaceExpansionSpec = z.infer<typeof surfaceExpansionSpecSchema>;

export class SurfaceEditError extends Error {
  constructor(readonly code: string, readonly details: Record<string, unknown>, message = '这次表面扩展尚未满足场景约束。') {
    super(message); this.name = 'SurfaceEditError';
  }
}

const key = ({ x, y, z }: Cell) => `${x},${y},${z}`;
const columnKey = (x: number, z: number) => `${x},${z}`;
const order = (a: { x: number; z: number }, b: { x: number; z: number }) => a.z - b.z || a.x - b.x;
const inBounds = (cell: Cell) => [cell.x, cell.y, cell.z].every(value => Number.isSafeInteger(value));

function localCell(part: Part, world: Cell): Cell {
  const local = { x: world.x - part.origin.x, y: world.y - part.origin.y, z: world.z - part.origin.z };
  if (!inBounds(world) || !inBounds(local)) {
    throw new SurfaceEditError('OUT_OF_BOUNDS', { partId: part.id, world: { ...world }, local }, '扩展位置运算超出安全整数精度。');
  }
  return local;
}

function terrainTargets(snapshot: SceneSnapshot, spec: SurfaceExpansionSpec): Set<string> | null {
  if (spec.terrainGroupId === undefined && spec.terrainPartId === undefined) return null;
  if (spec.terrainGroupId !== undefined && !snapshot.groups?.some(group => group.id === spec.terrainGroupId)) {
    throw new SurfaceEditError('TERRAIN_TARGET_NOT_FOUND', { terrainGroupId: spec.terrainGroupId });
  }
  if (spec.terrainPartId !== undefined) {
    const part = snapshot.parts.find(candidate => candidate.id === spec.terrainPartId);
    if (!part) throw new SurfaceEditError('TERRAIN_TARGET_NOT_FOUND', { terrainPartId: spec.terrainPartId });
    if (part.role !== 'terrain') {
      throw new SurfaceEditError('INVALID_TERRAIN_TARGET', { terrainPartId: part.id, terrainGroupId: spec.terrainGroupId ?? null });
    }
    return new Set([part.id]);
  }
  // Group membership never authorizes removing its non-terrain decorations or buildings.
  const ids = snapshot.parts.filter(part => part.groupId === spec.terrainGroupId && part.role === 'terrain').map(part => part.id);
  if (!ids.length) throw new SurfaceEditError('INVALID_TERRAIN_TARGET', { terrainGroupId: spec.terrainGroupId });
  return new Set(ids);
}

/**
 * Grow only the outer row/column ends, never fill holes inside a river or lagoon.
 * x grows each actual Z row's min/max X; z grows each X column's min/max Z;
 * xz is their union (no diagonal corner fill). The immutable original surface is
 * the reference for the whole amount, so new cells cannot become new seed rows.
 *
 * All exposed column tops must share one Y. Buried remnants remain untouched.
 * New columns copy their boundary donor's contiguous depth and per-layer color.
 * Optional terrain removal is limited to the new footprint, from surface Y to
 * that terrain column's top. Nothing below the waterline is excavated implicitly.
 * Terrain-bound water must rest immediately on that target's actual bed. Other
 * parts are protected within the actual excavation/write volume; high overhangs
 * outside that volume remain unchanged and do not imply a placement collision.
 * Free water expansion without a terrain target has no implicit bed requirement.
 * This compiler is pure: its final engine check runs only on an isolated copy.
 */
export function compileSurfaceExpansion(snapshot: SceneSnapshot, input: SurfaceExpansionSpec): AiOperation[] {
  const parsed = surfaceExpansionSpecSchema.safeParse(input);
  if (!parsed.success) throw new SurfaceEditError('INVALID_SPEC', {
    issues: parsed.error.issues.slice(0, 8).map(issue => ({ path: issue.path.join('.'), code: issue.code })),
  });
  const spec = parsed.data;
  // Reject contradictory scope before geometry checks; never silently broaden a part to its group.
  if (spec.terrainGroupId !== undefined && spec.terrainPartId !== undefined) {
    throw new SurfaceEditError('AMBIGUOUS_TERRAIN_TARGET', {
      terrainGroupId: spec.terrainGroupId, terrainPartId: spec.terrainPartId,
      expected: 'exactly-one-terrain-target', multiLayerTerrain: 'use-terrainGroupId-only',
    }, 'terrainGroupId 与 terrainPartId 只能选一个；多层地形只传 terrainGroupId。');
  }
  // Match the core's validation without inventing a second snapshot contract.
  let preview: VoxelEngine;
  try { preview = VoxelEngine.fromSnapshot(snapshot); }
  catch (error) { throw new SurfaceEditError('INVALID_SCENE', { engineCode: error instanceof EngineError ? error.code : 'INVALID_SNAPSHOT' }); }
  const part = snapshot.parts.find(candidate => candidate.id === spec.partId);
  if (!part) throw new SurfaceEditError('PART_NOT_FOUND', { partId: spec.partId });
  if (part.role !== 'water' && part.role !== 'terrain') {
    throw new SurfaceEditError('INVALID_SURFACE_ROLE', { partId: part.id, role: part.role });
  }
  const targets = terrainTargets(snapshot, spec);
  const parts = new Map(snapshot.parts.map(value => [value.id, value]));
  const occupied = new Map(snapshot.voxels.map(voxel => [key(voxel.cell), voxel]));
  const columns = new Map<string, Column>();
  const terrain = new Map<string, Voxel[]>();
  for (const voxel of snapshot.voxels) {
    const id = columnKey(voxel.cell.x, voxel.cell.z);
    if (voxel.partId === part.id) {
      const column = columns.get(id);
      if (column) { column.voxels.push(voxel); if (voxel.cell.y > column.top.cell.y) column.top = voxel; }
      else columns.set(id, { x: voxel.cell.x, z: voxel.cell.z, voxels: [voxel], top: voxel });
    }
    if (targets?.has(voxel.partId)) {
      const cells = terrain.get(id) ?? []; cells.push(voxel); terrain.set(id, cells);
    }
  }
  if (!columns.size) throw new SurfaceEditError('EMPTY_SURFACE', { partId: part.id });
  const exposed = [...columns.values()].filter(column => !occupied.has(key({ ...column.top.cell, y: column.top.cell.y + 1 })));
  const heights = [...new Set(exposed.map(column => column.top.cell.y))].sort((a, b) => a - b);
  if (heights.length !== 1) throw new SurfaceEditError('UNSUPPORTED_SURFACE', {
    partId: part.id, reason: heights.length ? 'multiple-exposed-heights' : 'surface-fully-covered', heights: heights.slice(0, 8), totalHeights: heights.length,
  }, '当前扩展需要一个明确的水平表面。');
  const surfaceY = heights[0];
  if ([...columns.values()].some(column => column.top.cell.y > surfaceY)) {
    throw new SurfaceEditError('UNSUPPORTED_SURFACE', { partId: part.id, reason: 'higher-covered-surface', surfaceY });
  }
  const surface = [...columns.values()].filter(column => column.top.cell.y === surfaceY).sort(order);
  for (const column of surface) {
    column.voxels.sort((a, b) => a.cell.y - b.cell.y);
    if (column.voxels.length !== surfaceY - column.voxels[0].cell.y + 1) {
      throw new SurfaceEditError('UNSUPPORTED_SURFACE', { partId: part.id, reason: 'non-contiguous-depth', column: { x: column.x, z: column.z } });
    }
  }

  const rows = new Map<number, { min: Column; max: Column }>();
  const lines = new Map<number, { min: Column; max: Column }>();
  for (const column of surface) {
    const row = rows.get(column.z);
    if (!row) rows.set(column.z, { min: column, max: column });
    else { if (column.x < row.min.x) row.min = column; if (column.x > row.max.x) row.max = column; }
    const line = lines.get(column.x);
    if (!line) lines.set(column.x, { min: column, max: column });
    else { if (column.z < line.min.z) line.min = column; if (column.z > line.max.z) line.max = column; }
  }
  const expansion = new Map<string, { x: number; z: number; donor: Column; distance: number }>();
  let candidateWork = 0;
  const addColumn = (donor: Column, dx: number, dz: number) => {
    candidateWork += donor.voxels.length;
    if (candidateWork > MAX_CANDIDATE_CELLS) throw new SurfaceEditError('EXPANSION_BUDGET', { limit: MAX_CANDIDATE_CELLS, kind: 'candidate-cells' });
    const x = donor.x + dx, z = donor.z + dz, distance = Math.abs(dx) + Math.abs(dz);
    if (!inBounds({ x, y: surfaceY, z })) throw new SurfaceEditError('OUT_OF_BOUNDS', { world: { x, y: surfaceY, z } });
    const id = columnKey(x, z), previous = expansion.get(id);
    if (!previous || distance < previous.distance || (distance === previous.distance && order(donor, previous.donor) < 0)) {
      expansion.set(id, { x, z, donor, distance });
    }
  };
  for (let amount = 1; amount <= spec.amount; amount++) {
    if (spec.axes !== 'z') for (const { min, max } of rows.values()) { addColumn(min, -amount, 0); addColumn(max, amount, 0); }
    if (spec.axes !== 'x') for (const { min, max } of lines.values()) { addColumn(min, 0, -amount); addColumn(max, 0, amount); }
  }

  const deletions = new Map<string, Patch['cells']>();
  const additions: Patch['cells'] = [];
  let deletionCount = 0;
  const collision = (voxel: Voxel, phase: string): never => {
    throw new SurfaceEditError('SURFACE_COLLISION', { partId: part.id, cell: { ...voxel.cell }, occupiedBy: voxel.partId, phase }, '扩展区域碰到了其他部件，场景尚未改变。');
  };
  for (const column of [...expansion.values()].sort(order)) {
    const targetCells = terrain.get(columnKey(column.x, column.z));
    if (targets && !targetCells?.length) throw new SurfaceEditError('OUTSIDE_TERRAIN', {
      partId: part.id, column: { x: column.x, z: column.z }, terrainGroupId: spec.terrainGroupId ?? null, terrainPartId: spec.terrainPartId ?? null,
    }, '完整加宽会超出指定地形，场景尚未改变。');
    let terrainTop: number | undefined;
    if (targetCells) {
      terrainTop = Math.max(...targetCells.map(voxel => voxel.cell.y));
      if (terrainTop < surfaceY) throw new SurfaceEditError('OUTSIDE_TERRAIN', {
        partId: part.id, column: { x: column.x, z: column.z }, surfaceY, terrainTop,
      });
      // Check the entire clearance, including foreign objects in gaps between terrain layers.
      for (let y = surfaceY; y <= terrainTop; y++) {
        if (++candidateWork > MAX_CANDIDATE_CELLS) throw new SurfaceEditError('EXPANSION_BUDGET', { limit: MAX_CANDIDATE_CELLS, kind: 'candidate-cells' });
        const voxel = occupied.get(key({ x: column.x, y, z: column.z }));
        if (!voxel) continue;
        if (voxel.partId === part.id) continue;
        if (!targets!.has(voxel.partId)) collision(voxel, 'terrain-clearance');
        const writes = deletions.get(voxel.partId) ?? [];
        writes.push({ cell: localCell(parts.get(voxel.partId)!, voxel.cell), color: null });
        deletions.set(voxel.partId, writes); deletionCount++;
      }
    }
    for (const source of column.donor.voxels) {
      const world = { x: column.x, y: source.cell.y, z: column.z };
      const existing = occupied.get(key(world));
      // A buried remnant belonging to this surface keeps its ID and color.
      if (existing?.partId === part.id) continue;
      if (existing && !(targets?.has(existing.partId) && world.y >= surfaceY && terrainTop !== undefined && world.y <= terrainTop)) {
        collision(existing, world.y < surfaceY ? 'below-waterline' : 'surface-write');
      }
      additions.push({ cell: localCell(part, world), color: source.color });
    }
    if (targets && part.role === 'water') {
      let bottomY = column.donor.voxels[0].cell.y;
      // Existing contiguous water below the donor depth remains part of the resulting column.
      const existingColumn = columns.get(columnKey(column.x, column.z));
      const existingBottom = existingColumn ? Math.min(...existingColumn.voxels.map(voxel => voxel.cell.y)) : bottomY;
      // Walk only this finite occupied column; removing a world bound must not
      // turn numeric underflow into an unbounded scan.
      while (bottomY > existingBottom && Number.isSafeInteger(bottomY - 1) && occupied.get(key({ x: column.x, y: bottomY - 1, z: column.z }))?.partId === part.id) {
        if (++candidateWork > MAX_CANDIDATE_CELLS) throw new SurfaceEditError('EXPANSION_BUDGET', { limit: MAX_CANDIDATE_CELLS, kind: 'candidate-cells' });
        bottomY--;
      }
      const bedCell = { x: column.x, y: bottomY - 1, z: column.z };
      const bed = occupied.get(key(bedCell));
      if (!bed || !targets.has(bed.partId)) throw new SurfaceEditError('SURFACE_BED_REQUIRED', {
        partId: part.id, waterBottomY: bottomY, cell: bedCell, occupiedBy: bed?.partId ?? null,
        terrainGroupId: spec.terrainGroupId ?? null, terrainPartId: spec.terrainPartId ?? null,
      }, '加宽后的水面需要紧贴指定地形的河床，场景尚未改变。');
    }
    if (deletionCount + additions.length > MAX_BATCH_CELLS) {
      throw new SurfaceEditError('EXPANSION_BUDGET', { limit: MAX_BATCH_CELLS, kind: 'changed-cells' });
    }
  }
  if (snapshot.voxels.length - deletionCount + additions.length > MAX_SCENE_VOXELS) {
    throw new SurfaceEditError('SCENE_CAPACITY', { limit: MAX_SCENE_VOXELS });
  }
  const operations: AiOperation[] = [];
  const append = (partId: string, cells: Patch['cells']) => {
    for (let offset = 0; offset < cells.length; offset += 4096) operations.push({ op: 'patch_cells', partId, cells: cells.slice(offset, offset + 4096) });
  };
  for (const [partId, cells] of [...deletions].sort(([a], [b]) => a.localeCompare(b, 'en'))) append(partId, cells);
  append(part.id, additions);
  if (operations.length > 32) throw new SurfaceEditError('EXPANSION_BUDGET', { limit: 32, kind: 'operations' });
  if (!operations.length) throw new SurfaceEditError('EMPTY_EXPANSION', { partId: part.id });
  try {
    preview.executeBatch({ protocolVersion: 1, baseRevision: snapshot.revision, operations }, 'surface-expansion-validation');
  } catch (error) {
    throw new SurfaceEditError('COMPILE_REJECTED', { engineCode: error instanceof EngineError ? error.code : 'INVALID_GEOMETRY' });
  }
  return operations;
}
