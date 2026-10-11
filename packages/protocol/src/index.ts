import { z } from 'zod';
export const COORD_MIN = -128;
export const COORD_MAX = 128;
export const MAX_BATCH_CELLS = 16000;
export const MAX_CANDIDATE_CELLS = 64000;
export const MAX_SCENE_VOXELS = 40000;
export const MAX_SCENE_GROUPS = 512;

const integer = z.number().int('必须是整数').min(COORD_MIN).max(COORD_MAX);
export const vecSchema = z.object({ x: integer, y: integer, z: integer }).strict();
const dimension = z.number().int('尺寸必须是整数').min(1, '尺寸至少为 1').max(64, '单轴尺寸最多为 64');
export const sizeSchema = z.object({ x: dimension, y: dimension, z: dimension }).strict();
export const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, '颜色使用 #RRGGBB');
export const shapeSchema = z.object({ kind: z.enum(['box', 'ellipsoid', 'cylinder', 'wedge']), origin: vecSchema, size: sizeSchema, color: colorSchema }).strict();
// Compact AI volumes describe a contour, never a stored generator to replay on edits.
const contourBounds = { offset: vecSchema, size: sizeSchema };
export const contourSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('box'), ...contourBounds }).strict(),
  z.object({ kind: z.literal('ellipsoid'), ...contourBounds }).strict(),
  z.object({ kind: z.literal('cylinder'), ...contourBounds, axis: z.enum(['x', 'y', 'z']) }).strict(),
  z.object({ kind: z.literal('wedge'), ...contourBounds }).strict(),
]);
const ids = z.array(z.number().int().positive()).min(1).max(MAX_BATCH_CELLS);
export const partIdSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/, '部件 ID 使用字母开头的短标识');
export const groupIdSchema = partIdSchema;
export const groupSchema = z.object({ id: groupIdSchema, name: z.string().min(1).max(80) }).strict();
export type Group = z.infer<typeof groupSchema>;
// Groups organize objects; cells and part origins remain in the existing world coordinate system.
export const partSchema = z.object({ id: partIdSchema, name: z.string().min(1).max(80), role: z.enum(['floor', 'wall', 'roof', 'door', 'window', 'detail', 'other', 'terrain', 'water', 'plant', 'animal']), origin: vecSchema, groupId: groupIdSchema.nullable().optional() }).strict();
const paletteEntrySchema = z.object({ symbol: z.string().regex(/^[A-Za-z0-9]$/, '颜色符号使用单个字母或数字'), color: colorSchema }).strict();
const layerSchema = z.object({ y: z.number().int().min(0).max(63), rows: z.array(z.string().min(1).max(64).regex(/^[.A-Za-z0-9]+$/)).min(1).max(64) }).strict();
const regionSchema = z.object({ min: vecSchema, max: vecSchema }).strict();
const quarterTurns = z.union([z.literal(-3), z.literal(-2), z.literal(-1), z.literal(1), z.literal(2), z.literal(3)]);
// Contours handle dense bulk geometry; layers/cells retain arbitrary detail geometry.
export const aiOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_prefab'), prefab: z.enum(['tree', 'house', 'duck', 'flowers', 'river']), origin: vecSchema, id: partIdSchema, name: z.string().min(1).max(80) }).strict(),
  z.object({ op: z.literal('clear_scene'), name: z.string().min(1).max(80) }).strict(),
  z.object({ op: z.literal('define_group'), group: groupSchema }).strict(),
  z.object({ op: z.literal('assign_part_group'), partId: partIdSchema, groupId: groupIdSchema.nullable() }).strict(),
  z.object({ op: z.literal('rename_group'), groupId: groupIdSchema, name: z.string().min(1).max(80) }).strict(),
  z.object({ op: z.literal('translate_group'), groupId: groupIdSchema, delta: vecSchema }).strict(),
  z.object({ op: z.literal('paint_group'), groupId: groupIdSchema, color: colorSchema }).strict(),
  z.object({ op: z.literal('remove_group'), groupId: groupIdSchema }).strict(),
  z.object({ op: z.literal('define_part'), part: partSchema }).strict(),
  z.object({ op: z.literal('fill_shape'), partId: partIdSchema, shape: contourSchema, color: colorSchema }).strict(),
  z.object({ op: z.literal('carve_shape'), partId: partIdSchema, shape: contourSchema }).strict(),
  z.object({ op: z.literal('write_layers'), partId: partIdSchema, offset: vecSchema, palette: z.array(paletteEntrySchema).min(1).max(62), layers: z.array(layerSchema).min(1).max(64), mode: z.enum(['add', 'replace']) }).strict(),
  z.object({ op: z.literal('patch_cells'), partId: partIdSchema, cells: z.array(z.object({ cell: vecSchema, color: colorSchema.nullable() }).strict()).min(1).max(4096) }).strict(),
  z.object({ op: z.literal('paint_part'), partId: partIdSchema, color: colorSchema, region: regionSchema.nullable() }).strict(),
  z.object({ op: z.literal('remove_region'), partId: partIdSchema, region: regionSchema }).strict(),
  z.object({ op: z.literal('translate_region'), partId: partIdSchema, region: regionSchema, delta: vecSchema }).strict(),
  z.object({ op: z.literal('translate_part'), partId: partIdSchema, delta: vecSchema }).strict(),
  z.object({ op: z.literal('remove_part'), partId: partIdSchema }).strict(),
]);
export type Part = z.infer<typeof partSchema>;
export type AiOperation = z.infer<typeof aiOperationSchema>;
export const operationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('generate_shape'), definition: shapeSchema }).strict(),
  z.object({ op: z.literal('put'), cell: vecSchema, color: colorSchema }).strict(),
  z.object({ op: z.literal('remove'), voxelIds: ids }).strict(),
  z.object({ op: z.literal('paint'), voxelIds: ids, color: colorSchema }).strict(),
  z.object({ op: z.literal('translate'), voxelIds: ids.nullable(), delta: vecSchema }).strict(),
  z.object({ op: z.literal('rotate90'), voxelIds: ids.nullable(), axis: z.enum(['x', 'y', 'z']), quarterTurns, pivot: vecSchema }).strict(),
  ...aiOperationSchema.options,
]);
export const batchSchema = z.object({ protocolVersion: z.literal(1), baseRevision: z.number().int().nonnegative(), operations: z.array(operationSchema).min(1).max(32) }).strict();
export type ShapeDefinition = z.infer<typeof shapeSchema>;
export type Operation = z.infer<typeof operationSchema>;
export type SceneBatch = z.infer<typeof batchSchema>;

export const snapshotSchema = z.object({
  schemaVersion: z.literal(2), revision: z.number().int().nonnegative(),
  nextVoxelId: z.number().int().positive().optional(),
  grid: z.object({ cellSize: z.literal(1), up: z.literal('+Y'), front: z.literal('+Z'), coordinates: z.literal('minimum-corner') }).strict(),
  model: z.object({ id: z.string().min(1).max(80), name: z.string().min(1).max(80) }).strict(),
  source: shapeSchema.nullable(), parts: z.array(partSchema).max(512),
  groups: z.array(groupSchema).max(MAX_SCENE_GROUPS).optional(),
  voxels: z.array(z.object({ id: z.number().int().positive(), cell: vecSchema, color: colorSchema, partId: partIdSchema }).strict()).max(MAX_SCENE_VOXELS),
}).strict();
export type SceneSnapshot = z.infer<typeof snapshotSchema>;

export const SHAPE_NAMES: Record<ShapeDefinition['kind'], string> = { box: '长方体', ellipsoid: '椭球', cylinder: '圆柱', wedge: '斜坡' };
export const DEFAULT_SHAPE: ShapeDefinition = { kind: 'box', origin: { x: -4, y: 0, z: -3 }, size: { x: 8, y: 6, z: 6 }, color: '#DB8055' };

export const chatRequestSchema = z.object({
  requestId: z.string().min(8).max(80), text: z.string().trim().min(1).max(1500),
  snapshot: snapshotSchema,
  messages: z.array(z.object({role:z.enum(['user','assistant']),content:z.string().max(3000)}).strict()).max(12).default([]),
}).strict();
export type ChatRequest = z.infer<typeof chatRequestSchema>;
export interface ScenePlan { requestId: string; batch: SceneBatch; reply: string }
export interface ServiceHealth { ok: boolean; model: string; aiConfigured: boolean; asrConfigured: boolean; ttsConfigured: boolean }

// Canonical JSON makes a real browser commit comparable with the server preflight.
// Sorting IDs preserves semantics even when runtime storage has a different order.
export function canonicalSnapshotJson(snapshot: SceneSnapshot): string {
  // Missing legacy fields and explicit empty membership describe the same scene.
  const value = { ...snapshot,
    groups: [...(snapshot.groups ?? [])].sort((a,b)=>a.id.localeCompare(b.id, 'en')),
    parts: snapshot.parts.map(part => ({ ...part, groupId: part.groupId ?? null })).sort((a,b)=>a.id.localeCompare(b.id, 'en')),
    voxels: [...snapshot.voxels].sort((a,b)=>a.id-b.id) };
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,v])=>[key,canonical(v)]));
    return item;
  }
  return JSON.stringify(canonical(value));
}
export async function snapshotDigest(snapshot: SceneSnapshot): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalSnapshotJson(snapshot));
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(result), value => value.toString(16).padStart(2, '0')).join('');
}
