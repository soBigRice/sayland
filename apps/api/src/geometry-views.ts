import { deflateSync } from 'node:zlib';
import { z } from 'zod';
import { groupIdSchema, partIdSchema, MAX_SCENE_GROUPS, MAX_SCENE_VOXELS, type SceneSnapshot } from '../../../packages/protocol/src/index.ts';
import { localReadRegionSchema } from './scene-context.ts';

type Vec3 = SceneSnapshot['voxels'][number]['cell'];
type Bounds = { min: Vec3; max: Vec3; size: Vec3 };
const AXES = ['x', 'y', 'z'] as const;
export const VIEW_SIZE = 320;
export const VIEW_HEADER = 32;
export const viewsQuerySchema = z.object({
  revision: z.number().int().nonnegative().describe('必须等于当前场景摘要revision，不能把旧图作为当前几何'),
  groupIds: z.array(groupIdSchema).min(1).max(32).nullable().describe('指定物件组；与partIds取并集，两者都为null时读取整个场景'),
  partIds: z.array(partIdSchema).min(1).max(32).nullable().describe('指定部件；region特写时必须只有一个部件且groupIds为null'),
  region: localReadRegionSchema.nullable().describe('null查看全部选中几何；非null为单一部件的局部整数闭区间'),
}).strict().superRefine((query, context) => {
  if (query.region && (query.groupIds !== null || query.partIds?.length !== 1)) {
    context.addIssue({ code: 'custom', path: ['region'], message: '局部三视图必须groupIds:null且partIds只指定一个部件，region为其局部坐标' });
  }
});
export type ViewsQuery = z.infer<typeof viewsQuerySchema>;
export class GeometryViewError extends Error {
  constructor(readonly code: 'INVALID_QUERY' | 'STALE_REVISION' | 'PART_NOT_FOUND' | 'GROUP_NOT_FOUND' | 'EMPTY_VIEW' | 'SCENE_CAPACITY', message: string) {
    super(message); this.name = 'GeometryViewError';
  }
}
export interface ModelViews {
  revision: number; scope: ViewsQuery; coordinateSpace: 'world-minimum-corner'; bounds: Bounds;
  voxelCount: number; partCount: number; partsComplete: boolean;
  parts: { id: string; name: string; groupId: string | null; origin: Vec3; voxelCount: number; worldBounds: Bounds }[];
  groups: { id: string; name: string; partIds: string[] }[];
  image: string; width: number; height: number; pixelsPerVoxel: number;
  directions: { name: string; camera: string; horizontal: string; vertical: string; nearest: string }[];
  semantics: string;
}
function extend(bounds: Bounds | null, cell: Vec3): Bounds {
  if (!bounds) return { min: { ...cell }, max: { ...cell }, size: { x: 1, y: 1, z: 1 } };
  for (const axis of AXES) {
    bounds.min[axis] = Math.min(bounds.min[axis], cell[axis]); bounds.max[axis] = Math.max(bounds.max[axis], cell[axis]);
    bounds.size[axis] = bounds.max[axis] - bounds.min[axis] + 1;
  }
  return bounds;
}

// PNG needs only lossless RGBA scanlines, zlib, and CRC32; no browser, native image library, or file IO.
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : value >>> 1;
  return value >>> 0;
});
function pngChunk(name: string, data: Buffer): Buffer {
  const type = Buffer.from(name, 'ascii'), payload = Buffer.concat([type, data]);
  let crc = 0xffffffff;
  for (const byte of payload) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length); payload.copy(chunk, 4); chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}
function encodePng(pixels: Uint8Array, width: number, height: number): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) rows.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}
const font: Record<string, string[]> = {
  F: ['11111','10000','10000','11110','10000','10000','10000'], R: ['11110','10001','10001','11110','10100','10010','10001'],
  O: ['01110','10001','10001','10001','10001','10001','01110'], N: ['10001','11001','11001','10101','10011','10011','10001'],
  T: ['11111','00100','00100','00100','00100','00100','00100'], I: ['11111','00100','00100','00100','00100','00100','11111'],
  G: ['01110','10001','10000','10111','10001','10001','01110'], H: ['10001','10001','10001','11111','10001','10001','10001'],
  P: ['11110','10001','10001','11110','10000','10000','10000'], X: ['10001','10001','01010','00100','01010','10001','10001'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'], Z: ['11111','00001','00010','00100','01000','10000','11111'],
  '+': ['00000','00100','00100','11111','00100','00100','00000'], '-': ['00000','00000','00000','11111','00000','00000','00000'],
};
function label(pixels: Uint8Array, width: number, left: number, text: string): void {
  for (let letter = 0; letter < text.length; letter++) for (let y = 0; y < 7; y++) for (let x = 0; x < 5; x++) {
    if (font[text[letter]]?.[y][x] !== '1') continue;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const index = ((9 + y * 2 + dy) * width + left + letter * 12 + x * 2 + dx) * 4;
      pixels[index] = 38; pixels[index + 1] = 61; pixels[index + 2] = 52;
    }
  }
}

/** Projects committed snapshot cells, never the camera, loaded mesh, animation, or a guessed bounding-box solid. */
export function modelViews(snapshot: SceneSnapshot, input: unknown): ModelViews {
  if (snapshot.voxels.length > MAX_SCENE_VOXELS || snapshot.parts.length > 512 || (snapshot.groups?.length ?? 0) > MAX_SCENE_GROUPS) {
    throw new GeometryViewError('SCENE_CAPACITY', '场景超过当前三视图容量');
  }
  const parsed = viewsQuerySchema.safeParse(input);
  if (!parsed.success) throw new GeometryViewError('INVALID_QUERY', parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；'));
  const scope = parsed.data;
  if (scope.revision !== snapshot.revision) throw new GeometryViewError('STALE_REVISION', `请求版本${scope.revision}已过期，当前版本为${snapshot.revision}，请按最新摘要重新看图`);
  const partMap = new Map(snapshot.parts.map(part => [part.id, part])), groupMap = new Map((snapshot.groups ?? []).map(group => [group.id, group]));
  for (const id of scope.partIds ?? []) if (!partMap.has(id)) throw new GeometryViewError('PART_NOT_FOUND', `部件 ${id} 不存在，请读取场景摘要`);
  for (const id of scope.groupIds ?? []) if (!groupMap.has(id)) throw new GeometryViewError('GROUP_NOT_FOUND', `物件组 ${id} 不存在，请读取场景摘要`);
  const all = scope.partIds === null && scope.groupIds === null;
  const selected = new Set(scope.partIds ?? []), groups = new Set(scope.groupIds ?? []);
  for (const part of snapshot.parts) if (part.groupId && groups.has(part.groupId)) selected.add(part.id);
  let fullBounds: Bounds | null = null;
  const stats = new Map<string, { count: number; bounds: Bounds }>();
  const voxels = snapshot.voxels.filter(voxel => {
    if (!all && !selected.has(voxel.partId)) return false;
    const part = partMap.get(voxel.partId);
    if (!part) throw new GeometryViewError('PART_NOT_FOUND', '实际方块引用了不存在的部件');
    return !scope.region || AXES.every(axis => voxel.cell[axis] - part.origin[axis] >= scope.region!.min[axis]
      && voxel.cell[axis] - part.origin[axis] <= scope.region!.max[axis]);
  });
  for (const voxel of voxels) {
    fullBounds = extend(fullBounds, voxel.cell);
    const previous = stats.get(voxel.partId); stats.set(voxel.partId, { count: (previous?.count ?? 0) + 1, bounds: extend(previous?.bounds ?? null, voxel.cell) });
  }
  if (!fullBounds) throw new GeometryViewError('EMPTY_VIEW', '该范围没有实际方块，无法生成三视图');
  const bounds = fullBounds, scale = (VIEW_SIZE - 24) / Math.max(bounds.size.x, bounds.size.y, bounds.size.z);
  const width = VIEW_SIZE * 3, height = VIEW_SIZE + VIEW_HEADER;
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 244; pixels[i + 1] = 245; pixels[i + 2] = 242; pixels[i + 3] = 255; }
  const depth = Array.from({ length: 3 }, () => new Float64Array(VIEW_SIZE * VIEW_SIZE).fill(-Infinity));
  for (const voxel of voxels) {
    const cell = voxel.cell;
    const projections = [
      { u: cell.x - bounds.min.x, v: bounds.max.y - cell.y, w: bounds.size.x, h: bounds.size.y, depth: cell.z },
      { u: bounds.max.z - cell.z, v: bounds.max.y - cell.y, w: bounds.size.z, h: bounds.size.y, depth: cell.x },
      { u: cell.x - bounds.min.x, v: cell.z - bounds.min.z, w: bounds.size.x, h: bounds.size.z, depth: cell.y },
    ];
    const color = Number.parseInt(voxel.color.slice(1), 16);
    projections.forEach((projection, plane) => {
      const x0 = Math.max(0, Math.floor((VIEW_SIZE - projection.w * scale) / 2 + projection.u * scale));
      const y0 = Math.max(0, Math.floor((VIEW_SIZE - projection.h * scale) / 2 + projection.v * scale));
      const x1 = Math.min(VIEW_SIZE, Math.max(x0 + 1, Math.floor((VIEW_SIZE - projection.w * scale) / 2 + (projection.u + 1) * scale)));
      const y1 = Math.min(VIEW_SIZE, Math.max(y0 + 1, Math.floor((VIEW_SIZE - projection.h * scale) / 2 + (projection.v + 1) * scale)));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const address = y * VIEW_SIZE + x; if (projection.depth <= depth[plane][address]) continue;
        depth[plane][address] = projection.depth;
        const at = ((y + VIEW_HEADER) * width + plane * VIEW_SIZE + x) * 4;
        const shade = scale >= 6 && (x === x0 || y === y0) ? 0.85 : 1;
        pixels[at] = (color >> 16) * shade; pixels[at + 1] = ((color >> 8) & 255) * shade; pixels[at + 2] = (color & 255) * shade;
      }
    });
  }
  ['FRONT X+ Y+', 'RIGHT Z- Y+', 'TOP X+ Z+'].forEach((text, index) => label(pixels, width, index * VIEW_SIZE + 12, text));
  const parts = [...stats].sort(([a], [b]) => a.localeCompare(b)).slice(0, 128).map(([id, stat]) => {
    const part = partMap.get(id)!;
    return { id, name: part.name, groupId: part.groupId ?? null, origin: { ...part.origin }, voxelCount: stat.count, worldBounds: stat.bounds };
  });
  return { revision: snapshot.revision, scope, coordinateSpace: 'world-minimum-corner', bounds, voxelCount: voxels.length,
    partCount: stats.size, partsComplete: stats.size <= 128, parts,
    groups: (snapshot.groups ?? []).filter(group => snapshot.parts.some(part => stats.has(part.id) && part.groupId === group.id))
      .map(group => ({ ...group, partIds: snapshot.parts.filter(part => stats.has(part.id) && part.groupId === group.id).map(part => part.id) })),
    image: `data:image/png;base64,${encodePng(pixels, width, height).toString('base64')}`, width, height, pixelsPerVoxel: scale,
    directions: [
      { name: 'front', camera: '+Z看向-Z', horizontal: '+X向右', vertical: '+Y向上', nearest: '最大Z' },
      { name: 'right', camera: '+X看向-X', horizontal: '-Z向右', vertical: '+Y向上', nearest: '最大X' },
      { name: 'top', camera: '+Y看向-Y', horizontal: '+X向右', vertical: '+Z向下', nearest: '最大Y' },
    ],
    semantics: '按实际占位包围盒适配，三个视图共用比例；图像包含选中范围的全部实际方块。图例worldBounds仅为包围盒而非实心，partsComplete=false表示图例截断而非几何截断。正交图只显示最近表面，不能证明背面/内部；需要核对局部占位或颜色时可按需read_region，无关部件不应重建。' };
}
