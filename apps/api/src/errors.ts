import type { Operation, Part, SceneBatch, SceneSnapshot } from '../../../packages/protocol/src/index.ts';
import { boundsOf, EngineError, VoxelEngine, type Vec3 } from '../../../packages/scene/src/index.ts';
import { inspectScene, sceneQuerySchema, type OccupancyRun } from './scene-context.ts';

type Bounds = { min: Vec3; max: Vec3 };
interface PrefixPartGeometry {
  partId: string;
  groupId: string | null;
  origin: Vec3;
  localCell: Vec3;
  voxelCount: number;
  worldBounds: Bounds | null;
  localBounds: Bounds | null;
}
interface PrefixOccupancy {
  coordinateSpace: 'world-minimum-corner';
  region: Bounds;
  regionCoversWholePart: boolean;
  matchedVoxelCount: number | null;
  returnedVoxelCount: number;
  totalRunsInRegion: number | null;
  complete: boolean;
  truncated: boolean;
  unavailable?: true;
  runs: OccupancyRun[];
}

/** Bounded geometry diagnostics only: no conversation, credentials or provider response body. */
export interface PlanDiagnostic {
  kind: 'engine' | 'schema' | 'query' | 'protocol' | 'limit';
  code: string;
  message: string;
  operationIndex?: number;
  operation?: Record<string, unknown>;
  issues?: Array<{ path: string; code: string }>;
  partIds?: string[];
  partCount?: number;
  partIdsComplete?: boolean;
  budget?: {
    scope: 'tokens' | 'content' | 'frame' | 'transport';
    unit: 'tokens' | 'bytes';
    limit: number | null;
    observed?: number;
    modelCall: number;
  };
  conflict?: {
    cell: Vec3;
    targetPartId?: string;
    targetLocalCell?: Vec3;
    source: 'before-failed-operation';
    boundsAreSolid: false;
    targetPart?: PrefixPartGeometry;
    occupiedBy?: PrefixPartGeometry & { occupancy: PrefixOccupancy };
    nearby: Array<{ cell: Vec3; partId: string }>;
  };
}
export interface PlanTrace {
  modelCalls: number;
  queryCalls: number;
  applyAttempts: number;
  failures: PlanDiagnostic[];
  committedBatches?: number;
  readRegionCalls?: number;
  viewCalls?: number;
  automaticViewPasses?: number;
  automaticViewImages?: number;
  currentRevision?: number;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly publicMessage: string,
    readonly diagnostic?: PlanDiagnostic,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

export function planningError(diagnostic: PlanDiagnostic): ApiError {
  const messages: Record<string, string> = {
    COLLISION: '我还没把新旧方块的位置安排好，这次没有改动作品。',
    PART_NOT_FOUND: '我没能正确找到要修改的部件，这次没有改动作品。',
    PART_EXISTS: '我给物件分配的编号重复了，这次没有改动作品。',
    STALE_REVISION: '作品刚刚发生了变化，这次搭建尚未提交。',
    OUT_OF_BOUNDS: '我规划的位置超出了当前世界边界，这次没有改动作品。',
    BATCH_BUDGET: '这次计划超过单次修改额度，尚未改动作品。',
    SCENE_CAPACITY: '这次计划超过当前世界的方块容量，尚未改动作品。',
    PART_CAPACITY: '这次计划超过当前世界的部件容量，尚未改动作品。',
    GROUP_REQUIRED: '我还没把新物件和部件整理完整，这次没有改动作品。',
    GROUP_NOT_FOUND: '我没能正确找到要修改的物件组，这次没有改动作品。',
    GROUP_EXISTS: '我给新物件分配的编号重复了，这次没有改动作品。',
    GROUP_CAPACITY: '这次计划超过当前世界的物件组容量，尚未改动作品。',
    PLANNING_LIMIT: '我还没在这轮时间内安排好完整的搭建步骤，作品保持原样。',
    TRUNCATED: '这批搭建步骤还没传完整，本批没有提交。',
    OUTPUT_BUDGET: '这批搭建步骤太长，暂时没能拆分完成，本批没有提交。',
    RESPONSE_FRAME_BUDGET: '这批搭建步骤的传输格式异常，本批没有提交。',
    TRANSPORT_BUDGET: '这批搭建步骤的传输量异常，本批没有提交。',
  };
  return new ApiError(`PLAN_${diagnostic.code}`, 502,
    messages[diagnostic.code] ?? '我还没把完整的搭建步骤检查好，这次没有改动作品。', diagnostic);
}

/** Describe the failed instruction without retaining large patches, names or arbitrary text. */
function operationSummary(operation: Operation): Record<string, unknown> {
  if (operation.op === 'define_group') return { op: operation.op, group: { id: operation.group.id } };
  if (operation.op === 'rename_group') return { op: operation.op, groupId: operation.groupId };
  if (operation.op === 'define_part') {
    const { id, origin, role } = operation.part;
    return { op: operation.op, part: { id, origin, role } };
  }
  if (operation.op === 'clear_scene') return { op: operation.op };
  if (operation.op === 'add_prefab') {
    const { op, prefab, origin, id } = operation;
    return { op, prefab, origin, id };
  }
  if (operation.op === 'write_layers') {
    const { op, partId, offset, mode, layers } = operation;
    return { op, partId, offset, mode, layerYs: layers.map(layer => layer.y),
      width: layers[0].rows[0].length, depth: layers[0].rows.length };
  }
  if (operation.op === 'patch_cells') return { op: operation.op, partId: operation.partId, cellCount: operation.cells.length, cells: operation.cells.slice(0, 8) };
  if ('voxelIds' in operation) return { op: operation.op, voxelCount: operation.voxelIds?.length ?? null };
  return structuredClone(operation);
}

function prefixPartGeometry(snapshot: SceneSnapshot, part: Part, cell: Vec3): PrefixPartGeometry {
  const cells = snapshot.voxels.filter(voxel => voxel.partId === part.id).map(voxel => voxel.cell);
  const bounds = boundsOf(cells);
  const relative = (point: Vec3): Vec3 => ({ x: point.x - part.origin.x, y: point.y - part.origin.y, z: point.z - part.origin.z });
  return {
    partId: part.id, groupId: part.groupId ?? null, origin: { ...part.origin }, localCell: relative(cell), voxelCount: cells.length,
    worldBounds: bounds ? { min: bounds.min, max: bounds.max } : null,
    localBounds: bounds ? { min: relative(bounds.min), max: relative(bounds.max) } : null,
  };
}

/** Query the actual preflight prefix, including new parts absent from the submitted snapshot. */
function prefixOccupancy(snapshot: SceneSnapshot, part: PrefixPartGeometry, cell: Vec3): PrefixOccupancy {
  const bounds = part.worldBounds!; // A blocking owner necessarily has the occupied collision cell.
  let region = structuredClone(bounds);
  if (!sceneQuerySchema.safeParse({ region, partId: part.partId, offset: 0 }).success) {
    // Keep oversized parts bounded by the same query contract; explicitly report partial coverage.
    const upper = (axis: keyof Vec3) => Math.min(bounds.max[axis], cell[axis] + 20);
    const lower = (axis: keyof Vec3) => Math.max(bounds.min[axis], upper(axis) - 39);
    region = { min: { x: lower('x'), y: lower('y'), z: lower('z') }, max: { x: upper('x'), y: upper('y'), z: upper('z') } };
  }
  let page;
  try { page = inspectScene(snapshot, { region, partId: part.partId, offset: 0 }); }
  catch {
    // A secondary diagnostic failure must never replace the original collision or imply free space.
    return { coordinateSpace: 'world-minimum-corner', region, regionCoversWholePart: false,
      matchedVoxelCount: null, returnedVoxelCount: 0, totalRunsInRegion: null,
      complete: false, truncated: true, unavailable: true, runs: [] };
  }
  const regionCoversWholePart = page.occupiedVoxelCount === part.voxelCount;
  const complete = regionCoversWholePart && page.complete;
  return {
    coordinateSpace: page.coordinateSpace, region, regionCoversWholePart,
    matchedVoxelCount: page.occupiedVoxelCount,
    returnedVoxelCount: page.runs.reduce((count, run) => count + run.xMax - run.xMin + 1, 0),
    totalRunsInRegion: page.totalRuns, complete, truncated: !complete, runs: page.runs,
  };
}

/** Prefix replay locates the first failing operation while preserving batch-wide budgets. */
export function diagnoseBatchFailure(snapshot: SceneSnapshot, batch: SceneBatch, failure: unknown, signal?: AbortSignal): PlanDiagnostic {
  let low = 1, high = batch.operations.length;
  let error = failure;
  while (low < high) {
    if (signal) throwIfAborted(signal);
    const middle = Math.floor((low + high) / 2);
    try {
      VoxelEngine.fromSnapshot(snapshot).executeBatch({ ...batch, operations: batch.operations.slice(0, middle) }, 'diagnose-prefix');
      low = middle + 1;
    } catch (caught) { high = middle; error = caught; }
  }
  const operationIndex = low - 1;
  const engine = VoxelEngine.fromSnapshot(snapshot);
  const preceding = operationIndex > 0
    ? engine.executeBatch({ ...batch, operations: batch.operations.slice(0, operationIndex) }, 'diagnose-before').snapshot
    : snapshot;
  const operation = batch.operations[operationIndex];
  const diagnostic: PlanDiagnostic = {
    kind: 'engine', code: error instanceof EngineError ? error.code : 'INVALID_GEOMETRY',
    message: error instanceof EngineError ? error.message.slice(0, 240) : '几何步骤未通过内核检查。',
    operationIndex, operation: operationSummary(operation),
  };
  const match = diagnostic.message.match(/\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)/);
  if (match && diagnostic.code === 'COLLISION') {
    const cell = { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
    const occupied = preceding.voxels.find(voxel => voxel.cell.x === cell.x && voxel.cell.y === cell.y && voxel.cell.z === cell.z);
    const owner = preceding.parts.find(part => part.id === occupied?.partId);
    const targetPart = 'partId' in operation ? preceding.parts.find(part => part.id === operation.partId) : undefined;
    const target = targetPart ? prefixPartGeometry(preceding, targetPart, cell) : undefined;
    const blocker = owner ? prefixPartGeometry(preceding, owner, cell) : undefined;
    diagnostic.conflict = {
      cell, source: 'before-failed-operation', boundsAreSolid: false,
      ...(target ? { targetPartId: target.partId, targetLocalCell: target.localCell, targetPart: target } : {}),
      ...(blocker ? { occupiedBy: { ...blocker, occupancy: prefixOccupancy(preceding, blocker, cell) } } : {}),
      nearby: preceding.voxels.filter(voxel => Math.abs(voxel.cell.x - cell.x) <= 1 && Math.abs(voxel.cell.y - cell.y) <= 1 && Math.abs(voxel.cell.z - cell.z) <= 1)
        .map(voxel => ({ cell: voxel.cell, partId: voxel.partId })).slice(0, 27),
    };
  }
  return diagnostic;
}

export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof ApiError) return { code: error.code, message: error.publicMessage };
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return { code: 'CANCELLED', message: '这次操作已经停下啦。' };
  }
  return { code: 'INTERNAL_ERROR', message: '刚刚没有完成，请再试一次。' };
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ApiError('CANCELLED', 499, '这次操作已经停下啦。');
}
