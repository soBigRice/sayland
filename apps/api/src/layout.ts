import { z } from 'zod';
import { aiOperationSchema, MAX_BATCH_CELLS, MAX_CANDIDATE_CELLS, partIdSchema, vecSchema, type AiOperation, type Part, type SceneSnapshot } from '../../../packages/protocol/src/index.ts';
import { boundsOf, cellKey, EngineError, VoxelEngine, type Vec3, type Voxel } from '../../../packages/scene/src/index.ts';

export const layoutPlacementSchema = z.object({
  mode: z.enum(['on_surface', 'in_surface', 'near', 'absolute']),
  targetGroupId: partIdSchema.describe('明确的目标物件组ID，与targetPartId二选一；absolute不填').optional(),
  targetPartId: partIdSchema.describe('明确的目标部件ID，与targetGroupId二选一；absolute不填').optional(),
  position: vecSchema.describe('仅absolute：新物件实际体素包围盒最小角的精确世界整数坐标，不是某个部件origin').optional(),
  depth: z.number().int().min(1).max(64).describe('in_surface嵌入深度，默认2格；新物件底部Y=目标占用表面Y-depth+1，下方保留目标地形支撑').optional(),
  gap: z.number().int().min(0).max(64).describe('near的最小水平间距，默认1格；最多在gap至gap+4格范围寻找真实地形支撑').optional(),
}).strict();
export type LayoutPlacement = z.infer<typeof layoutPlacementSchema>;

export class LayoutError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message); this.name = 'LayoutError';
  }
}

// Search limits are work budgets, not claims about a device's measured performance.
export const MAX_LAYOUT_CANDIDATES = 4096;
export const MAX_LAYOUT_CHECKS = MAX_CANDIDATE_CELLS * 16;
const MAX_NEAR_EXTRA_GAP = 4;
const PATCH_LIMIT = 4096;
type Bounds = NonNullable<ReturnType<typeof boundsOf>>;
type Column = { x: number; z: number; top: number; voxels: Voxel[] };
type Candidate = { position: Vec3; top: number; score: number };
const columnKey = (cell: Pick<Vec3, 'x' | 'z'>) => `${cell.x},${cell.z}`;
const inWorld = (cell: Vec3) => Object.values(cell).every(value => Number.isSafeInteger(value));
const checked = (cell: Vec3): Vec3 => {
  if (!inWorld(cell)) throw new LayoutError('LAYOUT_OUT_OF_BOUNDS', '坐标运算超出安全整数精度');
  return cell;
};
const add = (a: Vec3, b: Vec3): Vec3 => checked({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const subtract = (a: Vec3, b: Vec3): Vec3 => checked({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

function engineError(error: unknown, stage: string): never {
  if (error instanceof LayoutError) throw error;
  throw new LayoutError('LAYOUT_INVALID_GEOMETRY', error instanceof Error ? error.message : '造型数据无效', {
    stage, ...(error instanceof EngineError ? { engineCode: error.code } : {}),
  });
}

function columnsOf(voxels: Voxel[]): Map<string, Column> {
  const columns = new Map<string, Column>();
  for (const voxel of voxels) {
    const key = columnKey(voxel.cell), column = columns.get(key);
    if (column) { column.top = Math.max(column.top, voxel.cell.y); column.voxels.push(voxel); }
    else columns.set(key, { x: voxel.cell.x, z: voxel.cell.z, top: voxel.cell.y, voxels: [voxel] });
  }
  return columns;
}

function validateOpenInsetWater(parts: Part[], columns: Column[]) {
  const waterIds = new Set(parts.filter(part => part.role === 'water').map(part => part.id));
  if (!waterIds.size) return;
  for (const column of columns) {
    const water = column.voxels.filter(voxel => waterIds.has(voxel.partId));
    if (!water.length) continue;
    const surface = water.reduce((highest, voxel) => voxel.cell.y > highest.cell.y ? voxel : highest);
    const cover = column.voxels.find(voxel => voxel.cell.y > surface.cell.y);
    // A new water object must not bury its own surface. This does not prohibit
    // existing bridges or roofs outside the excavation and actual new geometry.
    if (cover) throw new LayoutError('LAYOUT_WATER_COVERED', '嵌入水面上方被本次新造型遮挡，请移除本次盖板或调整局部造型，保留新水面', {
      waterPartId: surface.partId, localWaterCell: surface.cell, coverPartId: cover.partId, localCoverCell: cover.cell,
    });
    const occupiedY = new Set(column.voxels.map(voxel => voxel.cell.y));
    // Excavation starts at local y=0. The new column must connect water to the
    // retained bed at y=-1, which is checked per candidate.
    for (let y = 0; y <= surface.cell.y; y++) {
      if (!occupiedY.has(y)) {
        throw new LayoutError('LAYOUT_WATER_UNSUPPORTED', '嵌入水面到保留地形之间有空洞，请补足实际河床或连续水层，不能只依靠物件包围盒底部的支撑', {
          waterPartId: surface.partId, localWaterCell: surface.cell, localMissingCell: { x: column.x, y, z: column.z },
        });
      }
    }
  }
}

function creationGeometry(snapshot: SceneSnapshot, input: AiOperation[]) {
  const parsed = z.array(aiOperationSchema).min(1).max(32).safeParse(input);
  if (!parsed.success) throw new LayoutError('LAYOUT_INVALID_OPERATIONS', '新造型操作必须是1至32条完整有效命令', { issues: parsed.error.issues.slice(0, 4).map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
  const operations = parsed.data;
  const prefab = operations.length === 1 && operations[0].op === 'add_prefab';
  if (!prefab) {
    const groups = operations.filter(op => op.op === 'define_group');
    const definitions = operations.filter(op => op.op === 'define_part');
    const partIds = new Set(definitions.map(op => op.part.id));
    if (groups.length !== 1 || !definitions.length || partIds.size !== definitions.length || definitions.some(op => op.part.groupId !== groups[0].group.id)) {
      throw new LayoutError('LAYOUT_CREATION_ONLY', '布局只接受一个全新物件组及明确归属于它的新部件');
    }
    for (const op of operations) {
      if (op.op === 'define_group' || op.op === 'define_part') continue;
      if (!['fill_shape', 'carve_shape', 'write_layers', 'patch_cells'].includes(op.op) || !('partId' in op) || !partIds.has(op.partId)) {
        throw new LayoutError('LAYOUT_CREATION_ONLY', '局部造型只能操作本次新建的部件，不能夹带现有物件编辑或其他预设');
      }
    }
  }
  let local: SceneSnapshot;
  try { local = new VoxelEngine().executeBatch({ protocolVersion: 1, baseRevision: 0, operations }, 'layout-local-preview').snapshot; }
  catch (error) { engineError(error, 'local-geometry'); }
  const occupied = boundsOf(local.voxels.map(voxel => voxel.cell));
  if (!occupied) throw new LayoutError('LAYOUT_EMPTY_GEOMETRY', '新物件没有实际方块，无法放置');
  const existingParts = new Set(snapshot.parts.map(part => part.id));
  const existingGroups = new Set((snapshot.groups ?? []).map(group => group.id));
  if (local.parts.some(part => existingParts.has(part.id)) || local.groups?.some(group => existingGroups.has(group.id))) {
    throw new LayoutError('LAYOUT_ID_CONFLICT', '新物件使用了已有组或部件编号，请保留旧物件并换一个新编号');
  }
  return { operations, local, bounds: occupied };
}

function resolveTarget(snapshot: SceneSnapshot, placement: LayoutPlacement): { parts: Part[]; voxels: Voxel[]; bounds: Bounds } {
  if (Number(!!placement.targetGroupId) + Number(!!placement.targetPartId) !== 1) {
    throw new LayoutError('LAYOUT_TARGET_REQUIRED', '此放置方式必须明确一个目标物件组或目标部件');
  }
  const parts = snapshot.parts.filter(part => placement.targetPartId ? part.id === placement.targetPartId : part.groupId === placement.targetGroupId);
  const ids = new Set(parts.map(part => part.id)), voxels = snapshot.voxels.filter(voxel => ids.has(voxel.partId));
  const bounds = boundsOf(voxels.map(voxel => voxel.cell));
  if (!bounds) throw new LayoutError('LAYOUT_TARGET_NOT_FOUND', '目标不存在或没有实际方块', { targetGroupId: placement.targetGroupId, targetPartId: placement.targetPartId });
  if (placement.mode === 'in_surface' && parts.some(part => part.role !== 'terrain')) {
    throw new LayoutError('LAYOUT_TERRAIN_REQUIRED', '嵌入只允许编辑明确目标中的地形部件，不能挖除房屋、树木或水体');
  }
  return { parts, voxels, bounds };
}

/** Compile one local object into ordinary atomic scene operations; never mutate the input scene. */
export function compileCreation(snapshot: SceneSnapshot, input: AiOperation[], placementInput: LayoutPlacement): AiOperation[] {
  const parsedPlacement = layoutPlacementSchema.safeParse(placementInput);
  if (!parsedPlacement.success) throw new LayoutError('LAYOUT_INVALID_PLACEMENT', '放置方式、坐标或深度无效');
  const placement = parsedPlacement.data;
  try { VoxelEngine.fromSnapshot(snapshot); } catch (error) { engineError(error, 'snapshot'); }
  const creation = creationGeometry(snapshot, input), localBounds = creation.bounds;
  const voxels = creation.local.voxels.map(voxel => ({ ...voxel, cell: subtract(voxel.cell, localBounds.min) }));
  const shifted = (position: Vec3): AiOperation[] => {
    const delta = subtract(position, localBounds.min);
    return creation.operations.map(op => op.op === 'define_part'
      ? { ...op, part: { ...op.part, origin: add(op.part.origin, delta) } }
      : op.op === 'add_prefab' ? { ...op, origin: add(op.origin, delta) } : op);
  };
  const validateOutput = (operations: AiOperation[]): AiOperation[] => {
    if (operations.length > 32) throw new LayoutError('LAYOUT_OPERATION_BUDGET', '清理地形和建造合计超过32条操作，请简化当前造型', { operations: operations.length });
    // The first covered fallback and the chosen open candidate are independent
    // previews, so neither may advance the other's revision or voxel allocator.
    try { VoxelEngine.fromSnapshot(snapshot).executeBatch({ protocolVersion: 1, baseRevision: snapshot.revision, operations }, 'layout-final-preview'); }
    catch (error) { engineError(error, 'compiled-batch'); }
    return operations;
  };
  const validBounds = (position: Vec3) => inWorld(position)
    && inWorld(add(position, { x: localBounds.size.x - 1, y: localBounds.size.y - 1, z: localBounds.size.z - 1 }))
    && creation.local.parts.every(part => inWorld(add(part.origin, subtract(position, localBounds.min))));
  if (placement.mode === 'absolute') {
    if (!placement.position) throw new LayoutError('LAYOUT_POSITION_REQUIRED', '精确放置需要新物件实际包围盒最小角的世界坐标');
    if (placement.targetGroupId || placement.targetPartId || placement.depth !== undefined || placement.gap !== undefined) throw new LayoutError('LAYOUT_INVALID_PLACEMENT', '精确放置不同时指定目标、深度或间距');
    if (!validBounds(placement.position)) throw new LayoutError('LAYOUT_OUT_OF_BOUNDS', '精确位置运算超出安全整数精度，不会自动挪动物件');
    return validateOutput(shifted(placement.position));
  }
  if (placement.position) throw new LayoutError('LAYOUT_INVALID_PLACEMENT', 'position仅用于absolute精确放置，不能把精确坐标作为自动搜索建议');
  if (placement.mode === 'on_surface' && snapshot.voxels.length === 0 && !placement.targetGroupId && !placement.targetPartId) {
    // An empty world has no terrain to reference. Its agreed starting surface is
    // virtual y=0: align the real object minimum to the origin without adding floor voxels.
    const start = { x: 0, y: 0, z: 0 };
    if (!validBounds(start)) throw new LayoutError('LAYOUT_OUT_OF_BOUNDS', '造型从空世界原点起建时超出安全整数精度，请调整局部造型');
    return validateOutput(shifted(start));
  }
  const target = resolveTarget(snapshot, placement);
  const surfaceParts = placement.mode === 'near' ? snapshot.parts.filter(part => part.role === 'terrain') : target.parts;
  const surfaceIds = new Set(surfaceParts.map(part => part.id));
  const surface = columnsOf(snapshot.voxels.filter(voxel => surfaceIds.has(voxel.partId)));
  if (!surface.size) throw new LayoutError('LAYOUT_NO_SURFACE', '目标附近没有可承载新物件的实际地形');
  const depth = placement.depth ?? 2, gap = placement.gap ?? 1;
  if (placement.mode === 'in_surface' && ![...surface.values()].some(column => {
    const occupiedY = new Set(column.voxels.map(voxel => voxel.cell.y));
    for (let distance = 0; distance <= depth; distance++) if (!occupiedY.has(column.top - distance)) return false;
    return true;
  })) {
    // A single surface part (for example grass) may omit the soil in its parent
    // group. This is a target/depth mismatch, not evidence that the island is full.
    const existingGroups = new Set((snapshot.groups ?? []).map(group => group.id));
    const suggestedTargetGroupIds = [...new Set(target.parts.flatMap(part => part.groupId && part.groupId !== placement.targetGroupId && existingGroups.has(part.groupId) ? [part.groupId] : []))].sort();
    throw new LayoutError('LAYOUT_TERRAIN_TOO_SHALLOW', `所选目标没有任何一列连续${depth + 1}格地形（嵌入${depth}格加下方1格河床），请检查目标部件、目标组或深度；不会自动扩大挖掘范围`, {
      ...(placement.targetPartId ? { targetPartId: placement.targetPartId } : { targetGroupId: placement.targetGroupId }),
      depth, requiredContinuousCells: depth + 1, suggestedTargetGroupIds,
    });
  }
  const allColumns = columnsOf(snapshot.voxels), occupied = new Map(snapshot.voxels.map(voxel => [cellKey(voxel.cell), voxel]));
  const footprint = [...columnsOf(voxels).values()].sort((a, b) => a.x - b.x || a.z - b.z);
  if (placement.mode === 'in_surface') validateOpenInsetWater(creation.local.parts, footprint);
  // Overhangs are intentional local geometry. Only the actual lowest layer needs support.
  const bottom = voxels.filter(voxel => voxel.cell.y === 0).sort((a, b) => a.cell.x - b.cell.x || a.cell.z - b.cell.z);
  const pivot = placement.mode === 'in_surface' ? footprint[0] : bottom[0].cell;
  const center = { x: (target.bounds.min.x + target.bounds.max.x) / 2, z: (target.bounds.min.z + target.bounds.max.z) / 2 };
  const candidates: Candidate[] = [];
  for (const column of surface.values()) {
    const position = { x: column.x - pivot.x, y: column.top + (placement.mode === 'in_surface' ? 1 - depth : 1), z: column.z - pivot.z };
    if (!validBounds(position)) continue;
    const maxX = position.x + localBounds.size.x - 1, maxZ = position.z + localBounds.size.z - 1;
    const dx = Math.max(0, target.bounds.min.x - maxX - 1, position.x - target.bounds.max.x - 1);
    const dz = Math.max(0, target.bounds.min.z - maxZ - 1, position.z - target.bounds.max.z - 1);
    const distance = Math.hypot(dx, dz);
    const overlap = position.x <= target.bounds.max.x && maxX >= target.bounds.min.x && position.z <= target.bounds.max.z && maxZ >= target.bounds.min.z;
    if (placement.mode === 'near' && (overlap || distance < gap || distance > gap + MAX_NEAR_EXTRA_GAP)) continue;
    const centered = (position.x + (localBounds.size.x - 1) / 2 - center.x) ** 2 + (position.z + (localBounds.size.z - 1) / 2 - center.z) ** 2;
    candidates.push({ position, top: column.top, score: placement.mode === 'near' ? distance * 1_000_000 + centered : centered });
  }
  candidates.sort((a, b) => a.score - b.score || b.top - a.top || a.position.x - b.position.x || a.position.z - b.position.z);
  let checks = 0, candidateCount = 0;
  const reasons: Record<string, number> = {};
  const check = () => {
    if (++checks > MAX_LAYOUT_CHECKS) throw new LayoutError('LAYOUT_SEARCH_LIMIT', '已达到本次布局检查预算，未改动作品；不能据此断言没有可用位置', { checks, candidateCount, limit: MAX_LAYOUT_CHECKS });
  };
  const reject = (reason: string) => { reasons[reason] = (reasons[reason] ?? 0) + 1; };
  let fallback: AiOperation[] | undefined;
  try {
    for (const candidate of candidates) {
      if (++candidateCount > MAX_LAYOUT_CANDIDATES) throw new LayoutError('LAYOUT_SEARCH_LIMIT', '本次候选位置搜索达到上限，未改动作品', { candidateCount: candidateCount - 1, totalCandidates: candidates.length, reasons });
      const position = candidate.position, removed = new Map<number, Voxel>();
      let reason = '', covered = false;
      if (placement.mode === 'in_surface') {
        for (const cell of footprint) {
          check();
          const world = add(position, { x: cell.x, y: 0, z: cell.z }), column = surface.get(columnKey(world));
          const bed = occupied.get(cellKey({ ...world, y: world.y - 1 }));
          // A rigid, level inset needs a measured level surface and surviving target terrain below it.
          if (!column || column.top !== candidate.top || !bed || !surfaceIds.has(bed.partId)) { reason = 'missing-level-terrain-or-bed'; break; }
          for (const voxel of allColumns.get(columnKey(world))?.voxels ?? []) {
            check();
            // Higher old objects survive. Prefer another valid location where
            // the new object is visible, but do not treat roofs as collisions.
            if (voxel.cell.y > column.top) { covered = true; continue; }
            if (voxel.cell.y < world.y) continue;
            if (!surfaceIds.has(voxel.partId)) { reason = 'protected-object-in-excavation'; break; }
            removed.set(voxel.id, voxel);
          }
          if (reason) break;
        }
      } else {
        for (const voxel of bottom) {
          check(); const cell = add(position, voxel.cell), support = occupied.get(cellKey({ ...cell, y: cell.y - 1 }));
          if (!support || !surfaceIds.has(support.partId) || surface.get(columnKey(cell))?.top !== cell.y - 1) { reason = 'missing-target-support'; break; }
        }
      }
      if (reason) { reject(reason); continue; }
      for (const voxel of voxels) {
        check(); const obstruction = occupied.get(cellKey(add(position, voxel.cell)));
        if (obstruction && !removed.has(obstruction.id)) { reason = 'occupied'; break; }
      }
      if (reason) { reject(reason); continue; }
      if (covered && fallback) continue;
      if (removed.size + voxels.length > MAX_BATCH_CELLS) throw new LayoutError('LAYOUT_BATCH_BUDGET', '地形清理与新增方块合计超过单批16000格，未改动作品', { removed: removed.size, added: voxels.length });
      const cleanup: AiOperation[] = [];
      for (const part of surfaceParts) {
        const cells = [...removed.values()].filter(voxel => voxel.partId === part.id).map(voxel => ({ cell: subtract(voxel.cell, part.origin), color: null }));
        if (cells.length > PATCH_LIMIT) throw new LayoutError('LAYOUT_PATCH_BUDGET', '同一地形部件本次需要清理超过4096格，请缩小这一批布局范围', { partId: part.id, cells: cells.length });
        if (cells.length) cleanup.push({ op: 'patch_cells', partId: part.id, cells });
      }
      const operations = validateOutput([...cleanup, ...shifted(position)]);
      if (!covered) return operations;
      // Candidates are already sorted. Keep only the best fully validated
      // covered placement while searching, within the same budgets, for an open one.
      fallback = operations;
    }
  } catch (error) {
    if (fallback && error instanceof LayoutError && error.code === 'LAYOUT_SEARCH_LIMIT') return fallback;
    throw error;
  }
  if (fallback) return fallback;
  throw new LayoutError('LAYOUT_NO_SPACE', '目标范围内没有满足完整支撑、地形范围和障碍保护的可用位置，未改动作品', { mode: placement.mode, candidatesChecked: candidateCount, checks, reasons, ...(placement.mode === 'near' ? { gap, maximumGap: gap + MAX_NEAR_EXTRA_GAP } : {}) });
}
