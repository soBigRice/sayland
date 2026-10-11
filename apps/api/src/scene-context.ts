import { z } from 'zod';
import {
  coordinateSchema, MAX_CANDIDATE_CELLS, MAX_SCENE_GROUPS, MAX_SCENE_VOXELS, partIdSchema, vecSchema,
  type ChatRequest, type Part, type SceneSnapshot,
} from '../../../packages/protocol/src/index.ts';

type Vec3 = SceneSnapshot['voxels'][number]['cell'];
type Voxel = SceneSnapshot['voxels'][number];
type Bounds = { min: Vec3; max: Vec3 };
const AXES = ['x', 'y', 'z'] as const;
const RUN_PAGE_SIZE = 256;
const SUMMARY_COLOR_LIMIT = 8;
const SUMMARY_SURFACE_LEVEL_LIMIT = 8;

export const sceneQuerySchema = z.object({
  region: z.object({ min: vecSchema, max: vecSchema }).strict()
    .describe('世界整数最小角坐标的闭区间，每轴最多64格，候选体积最多64000格；不是部件局部坐标'),
  partId: partIdSchema.nullable().describe('null读取区域内所有部件；指定部件会隐藏其他占位，不能用于判断碰撞或可放置空间'),
  offset: z.number().int().min(0).max(MAX_SCENE_VOXELS).describe('X连续段的分页偏移，首次为0，后续使用返回的nextOffset'),
}).strict().superRefine((query, context) => {
  const sizes = AXES.map(axis => query.region.max[axis] - query.region.min[axis] + 1);
  for (const [index, size] of sizes.entries()) {
    if (size < 1) context.addIssue({ code: 'custom', path: ['region', 'max', AXES[index]], message: '查询区域最大坐标不能小于最小坐标' });
    if (size > 64) context.addIssue({ code: 'custom', path: ['region'], message: '查询区域每轴最多64格，请缩小区域后分次读取' });
  }
  if (sizes.every(size => size > 0) && sizes.reduce((volume, size) => volume * size, 1) > MAX_CANDIDATE_CELLS) {
    context.addIssue({ code: 'custom', path: ['region'], message: `查询候选空间超过${MAX_CANDIDATE_CELLS}格，请分区读取` });
  }
});
export type SceneQuery = z.infer<typeof sceneQuerySchema>;

export class SceneQueryError extends Error {
  readonly code: 'INVALID_QUERY' | 'PART_NOT_FOUND' | 'OFFSET_OUT_OF_RANGE' | 'SCENE_CAPACITY' | 'STALE_REVISION' | 'REGION_TOO_LARGE';
  constructor(code: SceneQueryError['code'], message: string) { super(message); this.name = 'SceneQueryError'; this.code = code; }
}

// Local offsets have the same numeric safety contract as world coordinates.
const localInteger = coordinateSchema;
const localVector = z.object({ x: localInteger, y: localInteger, z: localInteger }).strict();
export const localReadRegionSchema = z.object({ min: localVector, max: localVector }).strict()
  .describe('部件局部整数最小角闭区间，world=part.origin+local；不是世界坐标')
  .superRefine((region, context) => {
    for (const axis of AXES) if (region.max[axis] < region.min[axis]) {
      context.addIssue({ code: 'custom', path: ['max', axis], message: '局部区域最大坐标不能小于最小坐标' });
    }
  });
export const readRegionSchema = z.object({
  revision: z.number().int().nonnegative().describe('必须等于当前场景摘要的revision；旧版本读取不复用'),
  partId: partIdSchema,
  region: localReadRegionSchema.nullable().describe('null读取整个部件；超过4096实际方块会报错，请按薄层缩小局部区域'),
}).strict();
export type ReadRegionQuery = z.infer<typeof readRegionSchema>;
type RegionEncoding = { encoding: 'cells'; palette: string[]; cells: [number, number, number, number][] }
  | { encoding: 'layers'; slices: { offset: Vec3; palette: { symbol: string; color: string }[]; layers: { y: number; rows: string[] }[] } };
export type RegionRead = RegionEncoding & {
  revision: number; part: Part; region: ReadRegionQuery['region']; count: number; complete: true;
  coordinateSpace: 'part-local-minimum-corner'; worldBounds: Bounds | null; localBounds: Bounds | null;
  semantics: string;
};

/** Lossless geometry for edits; unlike occupancy runs, this preserves every cell's exact color. */
export function readRegion(snapshot: SceneSnapshot, input: unknown): RegionRead {
  assertSceneCapacity(snapshot);
  const parsed = readRegionSchema.safeParse(input);
  if (!parsed.success) throw new SceneQueryError('INVALID_QUERY', parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；'));
  const { revision, partId, region } = parsed.data;
  if (revision !== snapshot.revision) throw new SceneQueryError('STALE_REVISION', `请求版本${revision}已过期，当前场景版本为${snapshot.revision}，请按最新摘要重新读取`);
  const part = snapshot.parts.find(item => item.id === partId);
  if (!part) throw new SceneQueryError('PART_NOT_FOUND', `部件 ${partId} 不存在，请读取场景摘要后重试`);
  const localPosition = (voxel: Voxel): Vec3 => {
    const local = { x: voxel.cell.x - part.origin.x, y: voxel.cell.y - part.origin.y, z: voxel.cell.z - part.origin.z };
    if (!Object.values(local).every(Number.isSafeInteger)) throw new SceneQueryError('INVALID_QUERY', '部件局部坐标运算超出安全整数精度');
    return local;
  };
  const cells = snapshot.voxels.filter(voxel => voxel.partId === partId && (!region || AXES.every(axis => {
    const local = localPosition(voxel)[axis];
    return local >= region.min[axis] && local <= region.max[axis];
  }))).sort((a, b) => a.cell.y - b.cell.y || a.cell.z - b.cell.z || a.cell.x - b.cell.x);
  if (cells.length > 4096) throw new SceneQueryError('REGION_TOO_LARGE', `该范围有${cells.length}个实际方块，超过4096格读取上限；请缩小局部region分区读取，未返回截断数据`);
  let worldBounds: Bounds | null = null, localBounds: Bounds | null = null;
  const palette: string[] = [], paletteIndex = new Map<string, number>();
  const tuples: [number, number, number, number][] = cells.map(voxel => {
    const local = localPosition(voxel);
    worldBounds = expandBounds(worldBounds, voxel.cell); localBounds = expandBounds(localBounds, local);
    if (!paletteIndex.has(voxel.color)) { paletteIndex.set(voxel.color, palette.length); palette.push(voxel.color); }
    return [local.x, local.y, local.z, paletteIndex.get(voxel.color)!];
  });
  let encoded: RegionEncoding = { encoding: 'cells', palette, cells: tuples };
  const bounds = localBounds as Bounds | null;
  const symbols = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  if (bounds && palette.length <= symbols.length) {
    const size = { x: bounds.max.x - bounds.min.x + 1, y: bounds.max.y - bounds.min.y + 1, z: bounds.max.z - bounds.min.z + 1 };
    // Dense output is bounded by its candidate volume, not just occupied count.
    if (AXES.every(axis => size[axis] <= 64) && size.x * size.y * size.z <= 16_384) {
      const positions = new Map(tuples.map(([x, y, z, color]) => [`${x},${y},${z}`, symbols[color]]));
      const dense: RegionEncoding = { encoding: 'layers', slices: {
        offset: { ...bounds.min }, palette: palette.map((color, index) => ({ symbol: symbols[index], color })),
        layers: Array.from({ length: size.y }, (_, y) => ({ y, rows: Array.from({ length: size.z }, (_, z) =>
          Array.from({ length: size.x }, (_, x) => positions.get(`${x + bounds.min.x},${y + bounds.min.y},${z + bounds.min.z}`) ?? '.').join('')) })),
      } };
      if (JSON.stringify(dense).length < JSON.stringify(encoded).length) encoded = dense;
    }
  }
  return { revision, part: structuredClone(part), region: structuredClone(region), count: cells.length, complete: true,
    coordinateSpace: 'part-local-minimum-corner', worldBounds, localBounds, ...encoded,
    semantics: '仅返回指定部件范围内的全部实际方块和逐格颜色，不含其他部件。cells为[x,y,z,colorIndex]，layers的offset同样是局部坐标；world=part.origin+local。局部空白不代表其他部件也为空，查碰撞请用inspect_scene且partId:null。' };
}

interface ColorStats {
  colors: { color: string; count: number }[];
  totalColors: number;
  colorsComplete: boolean;
}
interface PartStats { count: number; bounds: Bounds | null; colors: Map<string, number> }
interface SurfaceLevel {
  occupiedY: number;
  baseY: number;
  baseWithinBounds: boolean;
  columns: number;
  baseCellOccupiedColumns: number;
  columnsWithHigherOccupancy: number;
}
export interface OccupancyRun {
  y: number;
  z: number;
  xMin: number;
  xMax: number;
  partId: string;
  color: string | null;
  mixedColor: boolean;
}
export interface SceneInspection {
  revision: number;
  coordinateSpace: 'world-minimum-corner';
  query: SceneQuery;
  occupiedVoxelCount: number;
  totalRuns: number;
  matchedBounds: Bounds | null;
  parts: (ColorStats & {
    id: string; name: string; role: Part['role']; origin: Vec3; groupId: string | null;
    matchedVoxelCount: number; matchedBounds: Bounds;
  })[];
  offset: number;
  limit: number;
  complete: boolean;
  nextOffset: number | null;
  runs: OccupancyRun[];
  semantics: string;
}

function assertSceneCapacity(snapshot: SceneSnapshot): void {
  // The API validates snapshot structure before this boundary; still bound direct callers' work.
  if (snapshot.voxels.length > MAX_SCENE_VOXELS || snapshot.parts.length > 512 || (snapshot.groups?.length ?? 0) > MAX_SCENE_GROUPS) {
    throw new SceneQueryError('SCENE_CAPACITY', '场景超过当前查询容量，请缩小作品后重试');
  }
}
function expandBounds(bounds: Bounds | null, cell: Vec3): Bounds {
  if (!bounds) return { min: { ...cell }, max: { ...cell } };
  for (const axis of AXES) {
    bounds.min[axis] = Math.min(bounds.min[axis], cell[axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], cell[axis]);
  }
  return bounds;
}
function addStat(stats: Map<string, PartStats>, voxel: Voxel): void {
  const part = stats.get(voxel.partId) ?? { count: 0, bounds: null, colors: new Map<string, number>() };
  part.count++;
  part.bounds = expandBounds(part.bounds, voxel.cell);
  const color = voxel.color.toUpperCase();
  part.colors.set(color, (part.colors.get(color) ?? 0) + 1);
  stats.set(voxel.partId, part);
}
function colorStats(colors: Map<string, number>): ColorStats {
  const entries = [...colors].sort(([a, aCount], [b, bCount]) => bCount - aCount || a.localeCompare(b));
  return {
    colors: entries.slice(0, SUMMARY_COLOR_LIMIT).map(([color, count]) => ({ color, count })),
    totalColors: colors.size,
    colorsComplete: colors.size <= SUMMARY_COLOR_LIMIT,
  };
}
const positionKey = ({ x, y, z }: Vec3) => `${x},${y},${z}`;

/** Geometry observations are identical for every request text; they are not placement instructions. */
export function sceneSummary(input: ChatRequest): unknown {
  const { snapshot } = input;
  assertSceneCapacity(snapshot);
  const stats = new Map<string, PartStats>();
  const occupied = new Set<string>();
  const topOfColumn = new Map<string, number>();
  const partById = new Map(snapshot.parts.map(part => [part.id, part]));
  const supportTop = new Map<string, Voxel>();
  for (const voxel of snapshot.voxels) {
    addStat(stats, voxel);
    occupied.add(positionKey(voxel.cell));
    const columnKey = `${voxel.cell.x},${voxel.cell.z}`;
    topOfColumn.set(columnKey, Math.max(topOfColumn.get(columnKey) ?? -Infinity, voxel.cell.y));
    const role = partById.get(voxel.partId)?.role;
    if (role !== 'terrain' && role !== 'water') continue;
    const key = `${voxel.partId}:${columnKey}`;
    if (!supportTop.has(key) || supportTop.get(key)!.cell.y < voxel.cell.y) supportTop.set(key, voxel);
  }
  const surfaces = new Map<string, Map<number, SurfaceLevel>>();
  for (const voxel of supportTop.values()) {
    const levels = surfaces.get(voxel.partId) ?? new Map<number, SurfaceLevel>();
    const occupiedY = voxel.cell.y, baseY = occupiedY + 1;
    const level = levels.get(occupiedY) ?? { occupiedY, baseY, baseWithinBounds: Number.isSafeInteger(baseY),
      columns: 0, baseCellOccupiedColumns: 0, columnsWithHigherOccupancy: 0 };
    level.columns++;
    if (occupied.has(positionKey({ ...voxel.cell, y: baseY }))) level.baseCellOccupiedColumns++;
    if (topOfColumn.get(`${voxel.cell.x},${voxel.cell.z}`)! > occupiedY) level.columnsWithHigherOccupancy++;
    levels.set(occupiedY, level); surfaces.set(voxel.partId, levels);
  }
  const parts = snapshot.parts.map(part => {
    const stat = stats.get(part.id) ?? { count: 0, bounds: null, colors: new Map<string, number>() };
    const levels = [...(surfaces.get(part.id)?.values() ?? [])].sort((a, b) => b.columns - a.columns || a.occupiedY - b.occupiedY);
    return {
      ...part, groupId: part.groupId ?? null, origin: { ...part.origin }, voxelCount: stat.count, worldBounds: stat.bounds, ...colorStats(stat.colors),
      ...((part.role === 'terrain' || part.role === 'water') ? { surface: {
        columnCount: levels.reduce((count, level) => count + level.columns, 0),
        levelCount: levels.length, levelsComplete: levels.length <= SUMMARY_SURFACE_LEVEL_LIMIT,
        levels: levels.slice(0, SUMMARY_SURFACE_LEVEL_LIMIT),
      } } : {}),
    };
  });
  const groups = (snapshot.groups ?? []).map(group => {
    const members = parts.filter(part => part.groupId === group.id);
    let worldBounds: Bounds | null = null;
    for (const part of members) {
      if (!part.worldBounds) continue;
      worldBounds = expandBounds(worldBounds, part.worldBounds.min);
      worldBounds = expandBounds(worldBounds, part.worldBounds.max);
    }
    return { ...group, partIds: members.map(part => part.id), partCount: members.length,
      voxelCount: members.reduce((count, part) => count + part.voxelCount, 0), worldBounds };
  });
  return {
    model: { ...snapshot.model }, revision: snapshot.revision, voxelCount: snapshot.voxels.length,
    coordinateSpace: 'world-minimum-corner', groups, ungroupedPartIds: parts.filter(part => part.groupId === null).map(part => part.id), parts,
    groupingSemantics: 'groups按显式groupId列出物件与成员；role只表示部件用途，名称、ID前缀、坐标或同一轮创建都不能代替物件归属。未归组的旧部件保持在ungroupedPartIds中。',
    boundsSemantics: 'worldBounds只描述实际体素的最小包围盒，不代表内部实心、地面连续或区域可放置；用inspect_scene读取真实占位。',
    surfaceSemantics: 'surface按每个terrain/water部件每个XZ列的最高实际体素统计。occupiedY是已占用方块的最小角高度，baseY=occupiedY+1仅是表面以上候选高度；不是物件完整体积可放置保证。baseCellOccupiedColumns表示紧邻上一格已占用，columnsWithHigherOccupancy还包含更高处的障碍。颜色或高度列表不完整时明确标记，精确布局应查询局部。',
  };
}

/** Runs contain exactly the occupied cells in the region, sorted by Y/Z/X, with explicit pagination. */
export function inspectScene(snapshot: SceneSnapshot, input: unknown): SceneInspection {
  assertSceneCapacity(snapshot);
  const parsed = sceneQuerySchema.safeParse(input);
  if (!parsed.success) throw new SceneQueryError('INVALID_QUERY', parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；'));
  const query = parsed.data;
  const partById = new Map(snapshot.parts.map(part => [part.id, part]));
  if (query.partId !== null && !partById.has(query.partId)) throw new SceneQueryError('PART_NOT_FOUND', `部件 ${query.partId} 不存在，请读取场景摘要后重试`);
  const matches = snapshot.voxels.filter(voxel => (query.partId === null || voxel.partId === query.partId)
    && AXES.every(axis => voxel.cell[axis] >= query.region.min[axis] && voxel.cell[axis] <= query.region.max[axis]))
    .sort((a, b) => a.cell.y - b.cell.y || a.cell.z - b.cell.z || a.cell.x - b.cell.x);
  const stats = new Map<string, PartStats>();
  let matchedBounds: Bounds | null = null;
  const runs: OccupancyRun[] = [];
  for (const voxel of matches) {
    addStat(stats, voxel); matchedBounds = expandBounds(matchedBounds, voxel.cell);
    const color = voxel.color.toUpperCase();
    const last = runs.at(-1);
    if (last && last.y === voxel.cell.y && last.z === voxel.cell.z && last.xMax + 1 === voxel.cell.x && last.partId === voxel.partId) {
      last.xMax = voxel.cell.x;
      if (last.color !== color) { last.color = null; last.mixedColor = true; }
    } else runs.push({ y: voxel.cell.y, z: voxel.cell.z, xMin: voxel.cell.x, xMax: voxel.cell.x,
      partId: voxel.partId, color, mixedColor: false });
  }
  if (query.offset > runs.length) throw new SceneQueryError('OFFSET_OUT_OF_RANGE', `分页偏移超过当前结果，共${runs.length}段，请从offset=0重新读取`);
  const page = runs.slice(query.offset, query.offset + RUN_PAGE_SIZE);
  const nextOffset = query.offset + page.length < runs.length ? query.offset + page.length : null;
  return {
    revision: snapshot.revision, coordinateSpace: 'world-minimum-corner', query,
    occupiedVoxelCount: matches.length, totalRuns: runs.length, matchedBounds,
    parts: [...stats].map(([id, stat]) => {
      const part = partById.get(id)!;
      return { id, name: part.name, role: part.role, groupId: part.groupId ?? null, origin: { ...part.origin },
        matchedVoxelCount: stat.count, matchedBounds: stat.bounds!, ...colorStats(stat.colors) };
    }).sort((a, b) => a.id.localeCompare(b.id)),
    offset: query.offset, limit: RUN_PAGE_SIZE, complete: nextOffset === null, nextOffset, runs: page,
    semantics: '每段表示同一部件在(y,z)上从xMin到xMax闭区间的全部真实占位；color=null且mixedColor=true表示段内颜色混合，不能据此推断逐格颜色。matchedBounds是本次匹配体素的包围盒，不表示实心。complete仅表示已到分页末尾；存在nextOffset时必须继续读取。partId非null会隐藏其他部件，判断空位和碰撞必须以partId:null查询。',
  };
}
