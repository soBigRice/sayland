import { z } from 'zod';
import { add, assertCell, boundsOf, cellKey, MAX_BATCH_CELLS, MAX_SCENE_CELLS, rotateCell } from './coordinates.ts';
import { batchSchema, snapshotSchema, type Group, type Operation, type Part, type SceneSnapshot, type ShapeDefinition } from '../../protocol/src/index.ts';
import { assertRegion, expandLayers, inRegion, type CellWrite } from './layers.ts';
import { generateCells } from './shapes.ts';
import { VoxelStore } from './voxelStore.ts';
import { prefabOperations } from './prefabs.ts';

export type Snapshot = SceneSnapshot;
export type Voxel = Snapshot['voxels'][number];
export type Change = Readonly<{ before: Voxel | null; after: Voxel | null }>;
export type EngineResult = { snapshot: Snapshot; changes: Change[]; canUndo: boolean; canRedo: boolean; replayed: boolean };
type Metadata = { source: ShapeDefinition | null; parts: Map<string, Part>; groups: Map<string, Group>; name: string };
type State = Metadata & { voxels: VoxelStore };
type History = { changes: Change[]; before: Metadata; after: Metadata; group?: string };
const savedMetadataSchema = z.object({ source: snapshotSchema.shape.source, parts: snapshotSchema.shape.parts, groups: snapshotSchema.shape.groups, name: snapshotSchema.shape.model.shape.name }).strict();
const savedHistorySchema = z.object({
  changes: z.array(z.object({ before: snapshotSchema.shape.voxels.element.nullable(), after: snapshotSchema.shape.voxels.element.nullable() }).strict()).max(80_000),
  before: savedMetadataSchema, after: savedMetadataSchema, group: z.string().min(1).max(160).optional(),
}).strict();
const serializedSchema = z.object({
  version: z.literal(1), snapshot: snapshotSchema, nextId: z.number().int().positive(),
  past: z.array(savedHistorySchema).max(50), future: z.array(savedHistorySchema).max(50),
  requests: z.array(z.tuple([z.string().min(1).max(160), z.string().max(2_000_000)])).max(64),
}).strict();
export type EngineSerialized = z.infer<typeof serializedSchema>;
export class EngineError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'EngineError'; this.code = code; }
}
const metadata = (s: State): Metadata => ({ source: s.source, parts: new Map(s.parts), groups: new Map(s.groups), name: s.name });
function validMembership(parts: Map<string, Part>, groups: Map<string, Group>): boolean {
  return [...parts.values()].every(part => part.groupId == null || groups.has(part.groupId));
}
function selected(state: State, ids: number[] | null): Voxel[] {
  if (ids === null) return [...state.voxels.values()];
  return [...new Set(ids)].map(id => {
    const voxel = state.voxels.get(id);
    if (!voxel) throw new EngineError('TARGET_NOT_FOUND', `方块 ${id} 已不存在`);
    return voxel;
  });
}
function same(a: Voxel, b: Voxel): boolean { return a.color === b.color && a.partId === b.partId && cellKey(a.cell) === cellKey(b.cell); }
function mergeChanges(first: Change[], next: Change[]): Change[] {
  const merged = new Map(first.map(c => [(c.after ?? c.before)!.id, c]));
  for (const c of next) {
    const id = (c.after ?? c.before)!.id;
    const previous = merged.get(id);
    merged.set(id, previous ? { before: previous.before, after: c.after } : c);
  }
  return [...merged.values()].filter(c => c.before || c.after).filter(c => !c.before || !c.after || !same(c.before, c.after));
}

export class VoxelEngine {
  private state: State = { voxels: new VoxelStore(), source: null, parts: new Map(), groups: new Map(), name: '我的第一座小岛' };
  private revision = 0;
  private modelId = 'sayland-island';
  private nextId = 1;
  private past: History[] = [];
  private future: History[] = [];
  private requests = new Map<string, string>();

  static fromSnapshot(input: unknown): VoxelEngine {
    const snapshot = snapshotSchema.parse(input);
    if (snapshot.voxels.length > MAX_SCENE_CELLS) throw new EngineError('SCENE_CAPACITY', '这座小岛超过40000块，请先缩小作品');
    const engine = new VoxelEngine();
    const parts = new Map(snapshot.parts.map(p => [p.id, p]));
    if (parts.size !== snapshot.parts.length) throw new EngineError('INVALID_SNAPSHOT', '部件编号重复');
    const groups = new Map((snapshot.groups ?? []).map(group => [group.id, group]));
    if (groups.size !== (snapshot.groups ?? []).length || !validMembership(parts, groups)) throw new EngineError('INVALID_SNAPSHOT', '作品中存在重复物件组或部件所属组不存在');
    const occupied = new Set<string>();
    const voxels = new VoxelStore();
    for (const v of snapshot.voxels) {
      assertCell(v.cell);
      if (!parts.has(v.partId) || voxels.has(v.id) || occupied.has(cellKey(v.cell))) throw new EngineError('INVALID_SNAPSHOT', '作品中存在重复位置、编号或未知部件');
      occupied.add(cellKey(v.cell));
      voxels.set(v.id, { ...v, color: v.color.toUpperCase() });
      engine.nextId = Math.max(engine.nextId, v.id + 1);
    }
    if (snapshot.nextVoxelId !== undefined) {
      if (!Number.isSafeInteger(snapshot.nextVoxelId) || snapshot.nextVoxelId < engine.nextId) throw new EngineError('INVALID_SNAPSHOT', '下一个方块编号与作品不一致');
      engine.nextId = snapshot.nextVoxelId;
    }
    voxels.resetTracking();
    engine.state = { voxels, parts, groups, source: snapshot.source, name: snapshot.model.name };
    engine.revision = snapshot.revision; engine.modelId = snapshot.model.id;
    return engine;
  }
  serialize(): EngineSerialized {
    const savedMeta = (meta: Metadata) => ({ ...meta, parts: [...meta.parts.values()], groups: [...meta.groups.values()] });
    const saved = (entry: History) => ({ ...entry, before: savedMeta(entry.before), after: savedMeta(entry.after) });
    return structuredClone({ version: 1, snapshot: this.snapshot(), nextId: this.nextId, past: this.past.map(saved), future: this.future.map(saved), requests: [...this.requests] });
  }
  static restore(input: unknown): VoxelEngine {
    const saved = serializedSchema.parse(input);
    const engine = VoxelEngine.fromSnapshot(saved.snapshot);
    const restored = (meta: EngineSerialized['past'][number]['before']): Metadata => {
      const parts = new Map(meta.parts.map(p => [p.id, p]));
      if (parts.size !== meta.parts.length) throw new EngineError('INVALID_SAVED_SCENE', '标签页备份含重复部件');
      const groups = new Map((meta.groups ?? []).map(group => [group.id, group]));
      if (groups.size !== (meta.groups ?? []).length || !validMembership(parts, groups)) throw new EngineError('INVALID_SAVED_SCENE', '标签页备份含重复物件组或未知组归属');
      return { ...meta, parts, groups };
    };
    const histories = (entries: EngineSerialized['past']): History[] => entries.map(entry => ({ ...entry, before: restored(entry.before), after: restored(entry.after) }));
    const past = histories(saved.past), future = histories(saved.future);
    const invalid = () => { throw new EngineError('INVALID_SAVED_SCENE', '标签页备份的历史或方块 ID 不一致'); };
    if (past.length + future.length > 50 || [...past, ...future].reduce((n, item) => n + item.changes.length, 0) > 100_000) invalid();
    let maxId = saved.snapshot.voxels.reduce((n, v) => Math.max(n, v.id), 0);
    const metaKey = (meta: Metadata) => JSON.stringify([meta.source, [...meta.parts.values()], [...meta.groups.values()], meta.name]);
    // Check both history branches against the actual scene before accepting a backup.
    const validate = (entries: History[], undo: boolean) => {
      const state: State = { ...metadata(engine.state), voxels: new VoxelStore(engine.state.voxels) };
      for (const entry of [...entries].reverse()) {
        if (metaKey(state) !== metaKey(undo ? entry.after : entry.before)) invalid();
        const seen = new Set<number>();
        for (const change of entry.changes) {
          const from = undo ? change.after : change.before, to = undo ? change.before : change.after;
          const id = (from ?? to)?.id;
          if (!id || seen.has(id) || (from && to && from.id !== to.id)) invalid();
          seen.add(id!); maxId = Math.max(maxId, id!);
          const actual = state.voxels.get(id!);
          if (from ? !actual || !same(from, actual) : !!actual) invalid();
          if (to) state.voxels.set(to.id, to); else state.voxels.delete(id!);
        }
        const meta = undo ? entry.before : entry.after;
        Object.assign(state, meta);
        const occupied = new Set<string>();
        for (const voxel of state.voxels.values()) {
          const key = cellKey(voxel.cell);
          if (!state.parts.has(voxel.partId) || occupied.has(key)) invalid();
          occupied.add(key);
        }
      }
    };
    validate(past, true); validate(future, false);
    if (saved.nextId <= maxId || (saved.snapshot.nextVoxelId !== undefined && saved.snapshot.nextVoxelId !== saved.nextId) || new Map(saved.requests).size !== saved.requests.length) invalid();
    engine.nextId = saved.nextId; engine.past = past; engine.future = future; engine.requests = new Map(saved.requests);
    return engine;
  }
  snapshot(): Snapshot {
    // Snapshots cross the application boundary; callers never receive mutable store objects.
    return structuredClone({ schemaVersion: 2, revision: this.revision, nextVoxelId: this.nextId,
      grid: { cellSize: 1, up: '+Y', front: '+Z', coordinates: 'minimum-corner' },
      model: { id: this.modelId, name: this.state.name }, source: this.state.source,
      groups: [...this.state.groups.values()], parts: [...this.state.parts.values()], voxels: [...this.state.voxels.values()] });
  }
  get count(): number { return this.state.voxels.size; }
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  partVoxels(id: string): Voxel[] { return structuredClone(this.state.voxels.forPart(id)); }
  private result(changes: Change[], replayed = false): EngineResult {
    return { snapshot: this.snapshot(), changes: structuredClone(changes), canUndo: this.canUndo, canRedo: this.canRedo, replayed };
  }
  rename(value: string): EngineResult {
    const name = snapshotSchema.shape.model.shape.name.parse(value.trim());
    if (name === this.state.name) return this.result([]);
    const before = metadata(this.state);
    this.state = { ...this.state, name };
    this.past.push({ changes: [], before, after: metadata(this.state) });
    this.future = [];
    if (this.past.length > 50) this.past.shift();
    this.revision++;
    return this.result([]);
  }
  readState(): EngineResult { return this.result([]); }
  executeBatch(input: unknown, requestId: string, historyGroup?: string): EngineResult {
    if (!requestId || requestId.length > 160) throw new EngineError('INVALID_REQUEST_ID', '请求编号无效');
    if (historyGroup !== undefined && (!historyGroup || historyGroup.length > 160)) throw new EngineError('INVALID_HISTORY_GROUP', '操作分组编号无效');
    const parsed = batchSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new EngineError('INVALID_ARGUMENT', `${issue.path.join('.')}: ${issue.message}`);
    }
    const batch = parsed.data;
    const fingerprint = JSON.stringify({ batch, historyGroup });
    const cached = this.requests.get(requestId);
    if (cached !== undefined) {
      if (cached !== fingerprint) throw new EngineError('REQUEST_ID_CONFLICT', '重复请求编号携带了不同命令');
      return this.result([], true);
    }
    if (batch.baseRevision !== this.revision) throw new EngineError('STALE_REVISION', '小岛已经发生变化，请读取当前版本后重试');
    const draft: State = { ...metadata(this.state), voxels: this.state.voxels.fork() };
    const idBefore = this.nextId;
    try {
      for (const op of batch.operations) {
        this.apply(draft, op);
        if (!snapshotSchema.shape.parts.safeParse([...draft.parts.values()]).success) throw new EngineError('PART_CAPACITY', '小岛部件太多或编号无效，请先整理一下');
        if (!snapshotSchema.shape.groups.safeParse([...draft.groups.values()]).success) throw new EngineError('GROUP_CAPACITY', '小岛物件组太多或编号无效，请先整理一下');
        if (draft.voxels.touchedCount > MAX_BATCH_CELLS) throw new EngineError('BATCH_BUDGET', '一次最多修改16000块，请分批完成');
        if (draft.voxels.size > MAX_SCENE_CELLS) throw new EngineError('SCENE_CAPACITY', '小岛最多容纳40000块，请先移除一些方块');
      }
    } catch (error) {
      this.nextId = idBefore;
      if (error instanceof EngineError) throw error;
      throw new EngineError('INVALID_GEOMETRY', error instanceof Error ? error.message : '这次搭建没有完成');
    }
    const changes = draft.voxels.changes();
    const metaChanged = JSON.stringify([this.state.source, [...this.state.parts], [...this.state.groups], this.state.name]) !== JSON.stringify([draft.source, [...draft.parts], [...draft.groups], draft.name]);
    if (changes.length || metaChanged) {
      const last = this.past.at(-1);
      if (historyGroup && last?.group === historyGroup && !this.future.length) {
        last.changes = mergeChanges(last.changes, changes); last.after = metadata(draft);
      } else this.past.push({ changes, before: metadata(this.state), after: metadata(draft), group: historyGroup });
      this.future = [];
      let retained = this.past.reduce((n, item) => n + item.changes.length, 0);
      // Preserve the complete latest conversation, even when older history is discarded.
      while (this.past.length > 1 && (this.past.length > 50 || retained > 100_000)) retained -= this.past.shift()!.changes.length;
      this.state.voxels.commit(draft.voxels); this.state = { ...draft, voxels: this.state.voxels }; this.revision++;
    }
    this.requests.set(requestId, fingerprint);
    if (this.requests.size > 64) this.requests.delete(this.requests.keys().next().value!);
    return this.result(changes);
  }
  private allocateId(): number {
    if (!Number.isSafeInteger(this.nextId) || this.nextId >= Number.MAX_SAFE_INTEGER) throw new EngineError('ID_PRECISION_LIMIT', '方块 ID 已达整数精度边界，请导出并新建标签页');
    return this.nextId++;
  }
  private part(state: State, id: string): Part {
    const part = state.parts.get(id);
    if (!part) throw new EngineError('PART_NOT_FOUND', `部件 ${id} 不存在，请先读取场景或定义部件`);
    return part;
  }
  private group(state: State, id: string): Group {
    const group = state.groups.get(id);
    if (!group) throw new EngineError('GROUP_NOT_FOUND', `物件组 ${id} 不存在，请先读取场景或定义物件组`);
    return group;
  }
  private write(state: State, partId: string, writes: CellWrite[]): void {
    const seen = new Set<string>();
    for (const { cell, color } of writes) {
      assertCell(cell);
      const key = cellKey(cell);
      if (seen.has(key)) throw new EngineError('INVALID_GEOMETRY', '同一补丁不能重复指定一个位置');
      seen.add(key);
      const id = state.voxels.at(cell);
      const existing = id === undefined ? undefined : state.voxels.get(id);
      // Empty pixels erase this part only; they never erase a neighboring part.
      if (color === null) { if (existing?.partId === partId) { state.voxels.delete(existing.id); } continue; }
      if (existing && existing.partId !== partId) throw new EngineError('COLLISION', `位置 (${cell.x},${cell.y},${cell.z}) 被部件 ${existing.partId} 占据`);
      const nextId = existing?.id ?? this.allocateId();
      state.voxels.set(nextId, { id: nextId, cell, color: color.toUpperCase(), partId });
    }
  }
  private move(state: State, voxels: Voxel[], transform: (v: Voxel) => Voxel): void {
    const moving = new Set(voxels.map(v => v.id));
    const occupied = new Set<string>();
    const transformed = voxels.map(transform);
    for (const v of transformed) {
      assertCell(v.cell);
      const key = cellKey(v.cell);
      if (occupied.has(key) || (state.voxels.at(v.cell) !== undefined && !moving.has(state.voxels.at(v.cell)!))) throw new EngineError('COLLISION', `目标位置 (${v.cell.x}, ${v.cell.y}, ${v.cell.z}) 已有方块`);
      occupied.add(key);
    }
    for (const v of voxels) state.voxels.delete(v.id);
    for (const v of transformed) state.voxels.set(v.id, v);
  }
  private apply(state: State, op: Operation): void {
    if (op.op === 'add_prefab') {
      const operations = prefabOperations(op);
      for (const item of operations) {
        if (item.op === 'define_group' && state.groups.has(item.group.id)) throw new EngineError('GROUP_EXISTS', '这个物件组编号已经存在，请换一个编号');
        if (item.op === 'define_part' && state.parts.has(item.part.id)) throw new EngineError('PART_EXISTS', '这个物件编号已经存在，请换一个编号');
        this.apply(state, item);
      }
      return;
    }
    if (op.op === 'clear_scene') { state.voxels.clear(); state.parts.clear(); state.groups.clear(); state.source = null; state.name = op.name; return; }
    if (op.op === 'define_group') { state.groups.set(op.group.id, op.group); return; }
    if (op.op === 'assign_part_group') {
      const part = this.part(state, op.partId);
      if (op.groupId !== null) this.group(state, op.groupId);
      if ((part.groupId ?? null) !== op.groupId) state.parts.set(part.id, { ...part, groupId: op.groupId });
      return;
    }
    if (op.op === 'rename_group') {
      const group = this.group(state, op.groupId);
      state.groups.set(group.id, { ...group, name: op.name }); return;
    }
    if (op.op === 'translate_group' || op.op === 'paint_group' || op.op === 'remove_group') {
      this.group(state, op.groupId);
      const parts = [...state.parts.values()].filter(part => part.groupId === op.groupId);
      const voxels = parts.flatMap(part => state.voxels.forPart(part.id));
      if (voxels.length > MAX_BATCH_CELLS) throw new EngineError('BATCH_BUDGET', '单次修改超过 16000 块，整组操作未执行');
      if (op.op === 'translate_group') {
        const movedParts = parts.map(part => ({ ...part, origin: add(part.origin, op.delta) }));
        for (const part of movedParts) assertCell(part.origin);
        // All member IDs form one moving set, so adjacent parts do not block each other.
        this.move(state, voxels, voxel => ({ ...voxel, cell: add(voxel.cell, op.delta) }));
        for (const part of movedParts) state.parts.set(part.id, part);
      } else if (op.op === 'paint_group') {
        for (const voxel of voxels) state.voxels.set(voxel.id, { ...voxel, color: op.color.toUpperCase() });
      } else {
        for (const voxel of voxels) state.voxels.delete(voxel.id);
        for (const part of parts) state.parts.delete(part.id);
        state.groups.delete(op.groupId);
      }
      return;
    }
    if (op.op === 'define_part') {
      if (op.part.groupId != null) this.group(state, op.part.groupId);
      const previous = state.parts.get(op.part.id);
      if (previous && cellKey(previous.origin) !== cellKey(op.part.origin) && state.voxels.partStats(previous.id).count > 0) throw new EngineError('INVALID_GEOMETRY', '已有方块的部件请使用 translate_part 移动原点');
      // A legacy metadata update omits groupId; it must not silently detach an existing member.
      state.parts.set(op.part.id, { ...previous, ...op.part }); return;
    }
    if (op.op === 'write_layers') { this.write(state, op.partId, expandLayers(this.part(state, op.partId), op)); return; }
    if (op.op === 'fill_shape' || op.op === 'carve_shape') {
      const part = this.part(state, op.partId);
      const cells = generateCells({ kind: op.shape.kind, origin: add(part.origin, op.shape.offset), size: op.shape.size, ...('axis' in op.shape ? { axis: op.shape.axis } : {}) });
      // The same ownership/collision/ID rules as arbitrary patches apply after sampling.
      this.write(state, part.id, cells.map(cell => ({ cell, color: op.op === 'fill_shape' ? op.color : null }))); return;
    }
    if (op.op === 'patch_cells') {
      const part = this.part(state, op.partId);
      this.write(state, part.id, op.cells.map(c => ({ ...c, cell: add(part.origin, c.cell) }))); return;
    }
    if (op.op === 'paint_part' || op.op === 'remove_region' || op.op === 'remove_part' || op.op === 'translate_part' || op.op === 'translate_region') {
      const part = this.part(state, op.partId);
      const region = 'region' in op ? op.region : null;
      if (region) assertRegion(region);
      const voxels = state.voxels.forPart(part.id).filter(v => !region || inRegion(v.cell, part.origin, region));
      if (voxels.length > MAX_BATCH_CELLS) throw new EngineError('BATCH_BUDGET', '单次修改超过 16000 块，请用 region 或多个批次完成；小岛最多容纳40000块');
      if (op.op === 'paint_part') { for (const v of voxels) state.voxels.set(v.id, { ...v, color: op.color.toUpperCase() }); }
      else if (op.op === 'translate_part' || op.op === 'translate_region') {
        const origin = op.op === 'translate_part' ? add(part.origin, op.delta) : part.origin; assertCell(origin);
        this.move(state, voxels, v => ({ ...v, cell: add(v.cell, op.delta) }));
        state.parts.set(part.id, { ...part, origin });
      } else { for (const v of voxels) state.voxels.delete(v.id); if (op.op === 'remove_part') state.parts.delete(part.id); }
      return;
    }
    if (op.op === 'generate_shape') {
      const oldByCell = new Map([...state.voxels.values()].map(v => [cellKey(v.cell), v]));
      const next = new VoxelStore();
      for (const cell of generateCells(op.definition)) {
        const id = oldByCell.get(cellKey(cell))?.id ?? this.allocateId();
        next.set(id, { id, cell, color: op.definition.color.toUpperCase(), partId: 'shape-body' });
      }
      state.voxels.clear(); for (const [id, v] of next) state.voxels.set(id, v); state.source = { ...op.definition, color: op.definition.color.toUpperCase() };
      state.name = '基础形状';
      state.groups.clear();
      state.parts = new Map([['shape-body', { id: 'shape-body', name: '主体', role: 'other', origin: op.definition.origin }]]); return;
    }
    if (op.op === 'put') {
      const existing = state.voxels.at(op.cell);
      const color = op.color.toUpperCase();
      if (existing !== undefined) {
        if (state.voxels.get(existing)!.color === color) return;
        throw new EngineError('COLLISION', '这个位置已有方块，请使用涂色工具');
      }
      if (!state.parts.has('shape-body')) {
        state.parts.set('shape-body', { id: 'shape-body', name: '手动方块', role: 'other', origin: { x: 0, y: 0, z: 0 } });
      }
      this.write(state, 'shape-body', [{ cell: op.cell, color }]); return;
    }
    const voxels = selected(state, op.voxelIds);
    if (voxels.length > MAX_BATCH_CELLS) throw new EngineError('BATCH_BUDGET', '单次变换超过 16000 块，请分区执行；小岛最多容纳40000块');
    if (op.op === 'remove') { for (const v of voxels) state.voxels.delete(v.id); return; }
    if (op.op === 'paint') { for (const v of voxels) state.voxels.set(v.id, { ...v, color: op.color.toUpperCase() }); return; }
    this.move(state, voxels, v => ({ ...v, cell: op.op === 'translate' ? add(v.cell, op.delta) : rotateCell(v.cell, op.axis, op.quarterTurns, op.pivot) }));
  }
  undo(): EngineResult {
    const entry = this.past.pop(); if (!entry) return this.result([]);
    const changes = entry.changes.map(c => ({ before: c.after, after: c.before }));
    this.applyHistory(changes, entry.before); this.future.push(entry); return this.result(changes);
  }
  redo(): EngineResult {
    const entry = this.future.pop(); if (!entry) return this.result([]);
    this.applyHistory(entry.changes, entry.after); this.past.push(entry); return this.result(entry.changes);
  }
  private applyHistory(changes: Change[], meta: Metadata): void {
    for (const c of changes) if (c.before) this.state.voxels.delete(c.before.id);
    for (const c of changes) {
      if (c.after) this.state.voxels.set(c.after.id, c.after);
      else if (c.before) this.state.voxels.delete(c.before.id);
    }
    this.state.voxels.resetTracking();
    Object.assign(this.state, { ...meta, parts: new Map(meta.parts), groups: new Map(meta.groups) }); this.revision++;
  }
}
export const snapshotBounds = (snapshot: Snapshot) => boundsOf(snapshot.voxels.map(v => v.cell));
