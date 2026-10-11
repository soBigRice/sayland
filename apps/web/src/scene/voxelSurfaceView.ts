import { BoxGeometry, Color, Group, InstancedMesh, Mesh, MeshLambertMaterial, Object3D, type Intersection } from 'three';
import type { SceneSnapshot } from '../../../../packages/protocol/src/index.ts';
import { VoxelMotion } from './voxelMotion.ts';
import { makeEdgeTexture } from './voxelMaterial.ts';
import { VoxelSurface, type SurfaceChunk } from './voxelSurface.ts';

/** Owns all manually created GPU resources; React owns only the containing primitive. */
export class VoxelSurfaceView {
  readonly group = new Group();
  readonly surface = new VoxelSurface();
  private texture = makeEdgeTexture();
  private material = new MeshLambertMaterial({ map: this.texture, vertexColors: true });
  private movingMaterial = new MeshLambertMaterial({ map: this.texture });
  private cube = new BoxGeometry(1, 1, 1);
  private meshes = new Map<string, Mesh>();
  private picks = new WeakMap<Object3D, SurfaceChunk>();
  private moving: InstancedMesh | null = null;
  private movingIds: number[] = [];
  private slots = new Map<number, number>();
  private transform = new Object3D();
  private color = new Color();

  sync(voxels: SceneSnapshot['voxels'], motion: VoxelMotion): void {
    this.updateChunks(this.surface.sync(voxels, motion.activeIds));
    this.syncMoving(motion);
  }

  advance(changed: ReadonlySet<number>, motion: VoxelMotion): void {
    const settled: SceneSnapshot['voxels'] = [];
    for (const id of changed) {
      const visual = motion.get(id);
      if (visual && !motion.activeIds.has(id)) settled.push(visual.target);
      else this.writeMoving(id, motion);
    }
    if (settled.length) {
      this.updateChunks(this.surface.settle(settled));
      this.syncMoving(motion);
    } else if (this.moving && changed.size) {
      this.moving.instanceMatrix.needsUpdate = true;
      this.moving.computeBoundingBox(); this.moving.computeBoundingSphere();
    }
  }

  pick(event: Pick<Intersection, 'object' | 'faceIndex' | 'face' | 'instanceId'>): { voxelId: number; normal: { x: number; y: number; z: number } } | null {
    if (event.faceIndex == null || !event.face) return null;
    const chunk = this.picks.get(event.object);
    const voxelId = chunk?.kind === 'surface' ? chunk.faceVoxelIds[Math.floor(event.faceIndex / 2)]
      : event.instanceId === undefined ? undefined : chunk?.voxels[event.instanceId]?.id;
    if (voxelId === undefined) return null;
    const { x, y, z } = event.face.normal;
    return { voxelId, normal: { x: Math.round(x) || 0, y: Math.round(y) || 0, z: Math.round(z) || 0 } };
  }

  private updateChunks(dirty: ReadonlySet<string>): void {
    for (const key of dirty) {
      const chunk = this.surface.chunks.get(key);
      let mesh = this.meshes.get(key);
      if (mesh) {
        this.group.remove(mesh); this.picks.delete(mesh); this.meshes.delete(key);
        if (mesh instanceof InstancedMesh) mesh.dispose();
      }
      if (!chunk) continue;
      if (chunk.kind === 'surface') mesh = new Mesh(chunk.geometry, this.material);
      else {
        const instances = new InstancedMesh(this.cube, this.movingMaterial, chunk.voxels.length);
        chunk.voxels.forEach((voxel, index) => {
          this.transform.position.set(voxel.cell.x - chunk.origin.x + 0.5, voxel.cell.y - chunk.origin.y + 0.5, voxel.cell.z - chunk.origin.z + 0.5);
          this.transform.updateMatrix(); instances.setMatrixAt(index, this.transform.matrix);
          instances.setColorAt(index, this.color.set(voxel.color));
        });
        instances.instanceMatrix.needsUpdate = true;
        if (instances.instanceColor) instances.instanceColor.needsUpdate = true;
        instances.computeBoundingBox(); instances.computeBoundingSphere(); mesh = instances;
      }
      mesh.name = `Voxel surface ${key}`; mesh.castShadow = true; mesh.receiveShadow = true;
      this.meshes.set(key, mesh); this.group.add(mesh);
      mesh.position.set(chunk.origin.x, chunk.origin.y, chunk.origin.z);
      this.picks.set(mesh, chunk);
    }
  }

  private syncMoving(motion: VoxelMotion): void {
    this.movingIds = [...motion.activeIds];
    this.slots.clear();
    if (this.moving && (!this.movingIds.length || this.moving.instanceMatrix.count < this.movingIds.length)) {
      this.group.remove(this.moving); this.moving.dispose(); this.moving = null;
    }
    if (!this.movingIds.length) return;
    if (!this.moving) {
      this.moving = new InstancedMesh(this.cube, this.movingMaterial, 2 ** Math.ceil(Math.log2(this.movingIds.length)));
      this.moving.name = 'Moving voxels'; this.moving.castShadow = true; this.moving.receiveShadow = true;
      this.group.add(this.moving);
    }
    this.moving.count = this.movingIds.length;
    this.movingIds.forEach((id, index) => {
      this.slots.set(id, index); this.writeMoving(id, motion);
      this.moving!.setColorAt(index, this.color.set(motion.get(id)!.target.color));
    });
    this.moving.instanceMatrix.needsUpdate = true;
    if (this.moving.instanceColor) this.moving.instanceColor.needsUpdate = true;
    this.moving.computeBoundingBox(); this.moving.computeBoundingSphere();
  }

  private writeMoving(id: number, motion: VoxelMotion): void {
    const index = this.slots.get(id), visual = motion.get(id);
    if (!this.moving || index === undefined || !visual) return;
    this.transform.position.copy(visual.position); this.transform.updateMatrix();
    this.moving.setMatrixAt(index, this.transform.matrix);
  }

  dispose(): void {
    this.group.clear(); this.surface.dispose();
    for (const mesh of this.meshes.values()) if (mesh instanceof InstancedMesh) mesh.dispose();
    this.meshes.clear(); this.picks = new WeakMap();
    this.moving?.dispose(); this.moving = null; this.movingIds = []; this.slots.clear();
    this.cube.dispose(); this.material.dispose(); this.movingMaterial.dispose(); this.texture.dispose();
  }
}
