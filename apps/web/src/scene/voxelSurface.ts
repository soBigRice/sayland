import { BoxGeometry, BufferGeometry, Color, Float32BufferAttribute } from 'three';
import type { SceneSnapshot } from '../../../../packages/protocol/src/index.ts';

type Voxel = SceneSnapshot['voxels'][number];
type Cell = Voxel['cell'];
// Rendering pages are independent of storage pages. 32 balances small rebuilds and draw calls.
export const SURFACE_CHUNK_SIZE = 32;
const keyOf = ({ x, y, z }: Cell) => `${x},${y},${z}`;
const originOf = ({ x, y, z }: Cell): Cell => ({
  x: Math.floor(x / SURFACE_CHUNK_SIZE) * SURFACE_CHUNK_SIZE,
  y: Math.floor(y / SURFACE_CHUNK_SIZE) * SURFACE_CHUNK_SIZE,
  z: Math.floor(z / SURFACE_CHUNK_SIZE) * SURFACE_CHUNK_SIZE,
});
const chunkOf = (cell: Cell) => keyOf(originOf(cell));
const directions: Cell[] = [
  { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
];
const sameCell = (a: Cell, b: Cell) => a.x === b.x && a.y === b.y && a.z === b.z;

export type SurfaceChunk = { origin: Cell; faceCount: number } & (
  | { kind: 'surface'; geometry: BufferGeometry; faceVoxelIds: number[] }
  | { kind: 'instances'; voxels: Voxel[] }
);

/** Disposable display cache; the complete editable voxel document remains authoritative. */
export class VoxelSurface {
  readonly chunks = new Map<string, SurfaceChunk>();
  private voxels = new Map<number, Voxel>();
  private occupied = new Map<string, number>();
  private pages = new Map<string, Map<number, Voxel>>();
  private cube = new BoxGeometry(1, 1, 1);
  private color = new Color();

  sync(voxels: readonly Voxel[], moving: ReadonlySet<number>): ReadonlySet<string> {
    const retained = new Set<number>(), writes: Voxel[] = [], dirty = new Set<string>();
    for (const voxel of voxels) {
      if (moving.has(voxel.id)) continue;
      retained.add(voxel.id);
      const before = this.voxels.get(voxel.id);
      if (!before || !sameCell(before.cell, voxel.cell) || before.color !== voxel.color) writes.push(voxel);
    }
    // Remove all old positions first: adjacent IDs may exchange positions in a single transaction.
    for (const [id, before] of this.voxels) if (!retained.has(id)) this.remove(before, dirty);
    for (const voxel of writes) {
      const before = this.voxels.get(voxel.id);
      if (before && !sameCell(before.cell, voxel.cell)) this.remove(before, dirty);
    }
    for (const voxel of writes) this.put(voxel, dirty);
    this.rebuild(dirty);
    return dirty;
  }

  /** Only newly settled voxels rejoin the static surface; no whole-scene scan per animation frame. */
  settle(voxels: readonly Voxel[]): ReadonlySet<string> {
    const dirty = new Set<string>();
    for (const voxel of voxels) this.put(voxel, dirty);
    this.rebuild(dirty);
    return dirty;
  }

  private touch(cell: Cell, dirty: Set<string>): void {
    dirty.add(chunkOf(cell));
    // Cross-page neighbours need their newly exposed/covered faces rebuilt too.
    for (const d of directions) dirty.add(chunkOf({ x: cell.x + d.x, y: cell.y + d.y, z: cell.z + d.z }));
  }

  private remove(voxel: Voxel, dirty: Set<string>): void {
    this.voxels.delete(voxel.id); this.occupied.delete(keyOf(voxel.cell));
    const key = chunkOf(voxel.cell), page = this.pages.get(key);
    page?.delete(voxel.id);
    if (!page?.size) this.pages.delete(key);
    this.touch(voxel.cell, dirty);
  }

  private put(voxel: Voxel, dirty: Set<string>): void {
    const before = this.voxels.get(voxel.id), key = chunkOf(voxel.cell);
    this.voxels.set(voxel.id, voxel); this.occupied.set(keyOf(voxel.cell), voxel.id);
    let page = this.pages.get(key);
    if (!page) { page = new Map(); this.pages.set(key, page); }
    page.set(voxel.id, voxel);
    if (before) dirty.add(key); else this.touch(voxel.cell, dirty);
  }

  private rebuild(dirty: Set<string>): void {
    for (const key of dirty) {
      const previous = this.chunks.get(key);
      if (previous?.kind === 'surface') previous.geometry.dispose();
      this.chunks.delete(key);
      const page = this.pages.get(key);
      if (!page?.size) continue;
      const origin = originOf(page.values().next().value!.cell);
      const visible: { voxel: Voxel; mask: number }[] = [];
      let faceCount = 0;
      for (const voxel of page.values()) {
        let mask = 0;
        for (let face = 0; face < directions.length; face++) {
          const d = directions[face], p = voxel.cell;
          if (this.occupied.has(keyOf({ x: p.x + d.x, y: p.y + d.y, z: p.z + d.z }))) continue;
          mask |= 1 << face; faceCount++;
        }
        if (mask) visible.push({ voxel, mask });
      }
      if (!faceCount) continue;
      // Isolated/thin objects gain little from meshing but would multiply vertex-buffer memory.
      // Keep shared cubes for these pages, without reducing their detail or changing the document.
      if (faceCount > page.size * 3) {
        this.chunks.set(key, { kind: 'instances', origin, faceCount, voxels: [...page.values()] });
        continue;
      }
      const positions: number[] = [], normals: number[] = [], uvs: number[] = [], colors: number[] = [], indices: number[] = [], faceVoxelIds: number[] = [];
      const cubePosition = this.cube.getAttribute('position'), cubeNormal = this.cube.getAttribute('normal'), cubeUv = this.cube.getAttribute('uv');
      for (const { voxel, mask } of visible) {
        this.color.set(voxel.color);
        for (let face = 0; face < directions.length; face++) {
          if (!(mask & (1 << face))) continue;
          const p = voxel.cell;
          const base = positions.length / 3;
          // Copy the original cube's winding and UVs exactly, including the per-cell edge texture.
          for (let corner = 0; corner < 4; corner++) {
            const index = face * 4 + corner;
            positions.push(p.x - origin.x + 0.5 + cubePosition.getX(index), p.y - origin.y + 0.5 + cubePosition.getY(index), p.z - origin.z + 0.5 + cubePosition.getZ(index));
            normals.push(cubeNormal.getX(index), cubeNormal.getY(index), cubeNormal.getZ(index));
            uvs.push(cubeUv.getX(index), cubeUv.getY(index));
            colors.push(this.color.r, this.color.g, this.color.b);
          }
          for (let i = 0; i < 6; i++) indices.push(base + this.cube.index!.getX(face * 6 + i) - face * 4);
          faceVoxelIds.push(voxel.id);
        }
      }
      if (!faceVoxelIds.length) continue;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
      geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
      geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
      geometry.setIndex(indices); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
      this.chunks.set(key, { kind: 'surface', origin, faceCount, geometry, faceVoxelIds });
    }
  }

  dispose(): void {
    for (const chunk of this.chunks.values()) if (chunk.kind === 'surface') chunk.geometry.dispose();
    this.chunks.clear(); this.pages.clear(); this.voxels.clear(); this.occupied.clear(); this.cube.dispose();
  }
}
