import { boundsOf, cellKey, chunkAddress, type Vec3 } from './coordinates.ts';
import type { Voxel, Change } from './engine.ts';

// Copy-on-write pages: a transaction shares immutable pages until it touches them.
// The directory is sparse, so distant empty space consumes no voxel storage.
export class VoxelStore {
  readonly chunks = new Map<string, Map<number, Voxel>>();
  private ids = new Map<number, string>();
  private positions = new Map<string, number>();
  private shared = new Set<string>();
  private original = new Map<number, Voxel | null>();
  private parts = new Map<string, Map<string, Set<number>>>();
  private sharedParts = new Set<string>();
  private writablePartPages = new Set<string>();
  private stats = new Map<string, { count: number; worldBounds: ReturnType<typeof boundsOf>; colors: string[] }>();
  private pageStats = new WeakMap<Set<number>, { count: number; worldBounds: ReturnType<typeof boundsOf>; colors: string[] }>();
  size = 0;
  private partIds(partId: string, key: string): Set<number> {
    let pages = this.parts.get(partId);
    if (!pages || this.sharedParts.has(partId)) { pages = new Map(pages); this.parts.set(partId, pages); this.sharedParts.delete(partId); }
    const tag = `${partId}:${key}`;
    let ids = pages.get(key);
    if (!ids || !this.writablePartPages.has(tag)) { ids = new Set(ids); pages.set(key, ids); this.writablePartPages.add(tag); }
    this.stats.delete(partId); this.pageStats.delete(ids); return ids;
  }
  private removePartId(voxel: Voxel): void {
    const key = chunkAddress(voxel.cell).key;
    const ids = this.partIds(voxel.partId, key); ids.delete(voxel.id);
    if (!ids.size) this.parts.get(voxel.partId)?.delete(key);
  }
  forPart(partId: string): Voxel[] { return [...(this.parts.get(partId)?.values() ?? [])].flatMap(ids => [...ids].map(id => this.get(id)!)); }
  partStats(partId: string) {
    let stats = this.stats.get(partId);
    if (!stats) {
      const pieces = [...(this.parts.get(partId)?.values() ?? [])].map(ids => {
        let piece = this.pageStats.get(ids);
        if (!piece) { const voxels = [...ids].map(id => this.get(id)!); piece = { count: ids.size, worldBounds: boundsOf(voxels.map(v => v.cell)), colors: [...new Set(voxels.map(v => v.color))] }; this.pageStats.set(ids, piece); }
        return piece;
      });
      stats = { count: pieces.reduce((n,p)=>n+p.count,0), worldBounds: boundsOf(pieces.flatMap(p=>p.worldBounds?[p.worldBounds.min,p.worldBounds.max]:[])), colors: [...new Set(pieces.flatMap(p=>p.colors))] }; this.stats.set(partId, stats);
    }
    return stats;
  }
  resetTracking(): void { this.original.clear(); }

  constructor(values: Iterable<readonly [number, Voxel]> = []) { for (const [id, v] of values) this.set(id, v); this.original.clear(); }
  fork(): VoxelStore {
    const draft = new VoxelStore();
    for (const [key, page] of this.chunks) { draft.chunks.set(key, page); draft.shared.add(key); this.shared.add(key); }
    // Index overlays avoid copying every occupied position for a local edit.
    for (const [id, ids] of this.parts) { draft.parts.set(id, ids); draft.sharedParts.add(id); this.sharedParts.add(id); }
    this.writablePartPages.clear();
    draft.stats = new Map(this.stats); draft.pageStats = this.pageStats;
    draft.base = this;
    draft.size = this.size;
    return draft;
  }
  private base: VoxelStore | null = null;
  private deleted = new Set<number>();
  private erased = new Set<string>();
  get(id: number): Voxel | undefined {
    if (this.deleted.has(id)) return undefined;
    const key = this.ids.get(id) ?? this.base?.keyOf(id);
    return key === undefined ? undefined : this.chunks.get(key)?.get(id);
  }
  private keyOf(id: number): string | undefined { return this.deleted.has(id) ? undefined : this.ids.get(id) ?? this.base?.keyOf(id); }
  has(id: number): boolean { return this.get(id) !== undefined; }
  at(cell: Vec3): number | undefined {
    const key = cellKey(cell);
    if (this.erased.has(key)) return undefined;
    return this.positions.get(key) ?? this.base?.at(cell);
  }
  private page(key: string): Map<number, Voxel> {
    let page = this.chunks.get(key);
    if (!page || this.shared.has(key)) { page = new Map(page); this.chunks.set(key, page); this.shared.delete(key); }
    return page;
  }
  set(id: number, voxel: Voxel): this {
    const previous = this.get(id);
    if (!this.original.has(id)) this.original.set(id, previous ?? null);
    if (previous) {
      this.removePartId(previous);
      this.page(chunkAddress(previous.cell).key).delete(id);
      this.positions.delete(cellKey(previous.cell)); this.erased.add(cellKey(previous.cell));
    } else this.size++;
    const key = chunkAddress(voxel.cell).key;
    this.partIds(voxel.partId, key).add(id);
    this.page(key).set(id, voxel); this.ids.set(id, key); this.deleted.delete(id);
    this.positions.set(cellKey(voxel.cell), id); this.erased.delete(cellKey(voxel.cell));
    return this;
  }
  delete(id: number): boolean {
    const previous = this.get(id); if (!previous) return false;
    if (!this.original.has(id)) this.original.set(id, previous);
    this.removePartId(previous);
    const key = chunkAddress(previous.cell).key;
    const page = this.page(key); page.delete(id); if (!page.size) this.chunks.delete(key);
    this.ids.delete(id); this.deleted.add(id); this.positions.delete(cellKey(previous.cell)); this.erased.add(cellKey(previous.cell)); this.size--;
    return true;
  }
  clear(): void { for (const voxel of this.values()) this.delete(voxel.id); }
  *values(): IterableIterator<Voxel> { for (const page of this.chunks.values()) yield* page.values(); }
  *[Symbol.iterator](): IterableIterator<[number, Voxel]> { for (const voxel of this.values()) yield [voxel.id, voxel]; }
  get touchedCount(): number { return this.original.size; }
  changes(): Change[] {
    return [...this.original].map(([id, before]) => ({ before, after: this.get(id) ?? null })).filter(c => {
      if (!c.before || !c.after) return !!(c.before || c.after);
      return c.before.partId !== c.after.partId || c.before.color !== c.after.color || cellKey(c.before.cell) !== cellKey(c.after.cell);
    });
  }
  // Commit just the touched pages into the root. Do not retain a growing overlay chain.
  commit(draft: VoxelStore): void {
    const final = [...draft.original.keys()].map(id => [id, draft.get(id)] as const);
    for (const [id] of final) this.delete(id);
    for (const [id, v] of final) if (v) this.set(id, v);
    this.original.clear(); this.shared.clear(); this.sharedParts.clear();
  }
  pageValues(key: string): Voxel[] { return [...(this.chunks.get(key)?.values() ?? [])]; }
}
