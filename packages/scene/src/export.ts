import type { SceneSnapshot } from '../../protocol/src/index.ts';

type Voxel = SceneSnapshot['voxels'][number];
export type Point = [number, number, number];
export type ExportScope = { kind: 'all' } | { kind: 'parts'; partIds: string[] };
export interface ExportOptions { scope: ExportScope; millimetersPerVoxel: number }
export interface ExportFace { corners: Point[]; normal: Point; voxelId: number }
export interface ExportMesh {
  partId: string; color: string; faces: ExportFace[]; vertices: Point[]; triangles: Point[];
}

const directions: { delta: Point; corners: Point[] }[] = [
  { delta: [1, 0, 0], corners: [[1,0,0], [1,1,0], [1,1,1], [1,0,1]] },
  { delta: [-1, 0, 0], corners: [[0,0,1], [0,1,1], [0,1,0], [0,0,0]] },
  { delta: [0, 1, 0], corners: [[0,1,1], [1,1,1], [1,1,0], [0,1,0]] },
  { delta: [0, -1, 0], corners: [[0,0,0], [1,0,0], [1,0,1], [0,0,1]] },
  { delta: [0, 0, 1], corners: [[1,0,1], [1,1,1], [0,1,1], [0,0,1]] },
  { delta: [0, 0, -1], corners: [[0,0,0], [0,1,0], [1,1,0], [1,0,0]] },
];
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
const cellKey = (v: Voxel) => key(v.cell.x, v.cell.y, v.cell.z);

export function selectExportSnapshot(snapshot: SceneSnapshot, scope: ExportScope): SceneSnapshot {
  const ids = new Set(scope.kind === 'all' ? snapshot.parts.map(p => p.id) : scope.partIds);
  if ([...ids].some(id => !snapshot.parts.some(p => p.id === id))) throw new Error('所选部件已变化，请重新选择。');
  const voxels = snapshot.voxels.filter(v => ids.has(v.partId));
  if (!voxels.length) throw new Error('请至少选择一个有方块的物件或部件。');
  const used = new Set(voxels.map(v => v.partId));
  const parts = snapshot.parts.filter(p => used.has(p.id));
  const groups = snapshot.groups?.filter(g => parts.some(p => p.groupId === g.id)) ?? [];
  // Only the selected scene is included; conversations and unrelated geometry never enter the archive.
  return { ...snapshot, source: null, parts, groups, voxels };
}

export function inspectExport(snapshot: SceneSnapshot, options: ExportOptions, checkTopology = true) {
  const scale = options.millimetersPerVoxel;
  if (!Number.isFinite(scale) || scale < 0.1 || scale > 100) throw new Error('每格尺寸需在 0.1～100 毫米之间。');
  const selected = selectExportSnapshot(snapshot, options.scope);
  const min: Point = [Infinity, Infinity, Infinity], max: Point = [-Infinity, -Infinity, -Infinity];
  const cells = new Map<string, Voxel>();
  for (const v of selected.voxels) {
    const c: Point = [v.cell.x, v.cell.y, v.cell.z];
    c.forEach((n, axis) => { min[axis] = Math.min(min[axis], n); max[axis] = Math.max(max[axis], n); });
    if (checkTopology) cells.set(cellKey(v), v);
  }
  // Rebase before adding corners to preserve unit cells near safe-integer coordinate limits.
  const extent = max.map((n, axis) => n - min[axis] + 1) as Point;
  if (extent.some(n => !Number.isSafeInteger(n) || n > 1_000_000)) throw new Error('所选物件相距太远，无法精确导出；请分开导出。');
  const remaining = new Set(cells.keys());
  let components = 0, floatingComponents = 0, unsupportedFaces = 0;
  for (const v of checkTopology ? selected.voxels : []) {
    if (v.cell.y > min[1] && !cells.has(key(v.cell.x, v.cell.y - 1, v.cell.z))) unsupportedFaces++;
    if (!remaining.delete(cellKey(v))) continue;
    components++;
    const queue = [v]; let touchesBed = false;
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];
      if (current.cell.y === min[1]) touchesBed = true;
      for (const { delta: [x, y, z] } of directions) {
        const k = key(current.cell.x + x, current.cell.y + y, current.cell.z + z);
        if (remaining.delete(k)) queue.push(cells.get(k)!);
      }
    }
    if (!touchesBed) floatingComponents++;
  }
  const colors = [...new Set(selected.voxels.map(v => v.color.toUpperCase()))].sort();
  return { selected, min, extent, colors, components, floatingComponents, unsupportedFaces,
    // Print coordinates are X, -Z, Y; a proper rotation keeps winding and handedness.
    dimensions: [extent[0] * scale, extent[2] * scale, extent[1] * scale] as Point };
}
export type ExportInspection = ReturnType<typeof inspectExport>;

/** Weld face corners through edges, not just coordinates: diagonal cells must not
 * turn one geometric edge into a non-manifold edge shared by four triangles. */
function weldSurface(faces: ExportFace[]): Pick<ExportMesh, 'vertices' | 'triangles'> {
  const parent = Int32Array.from({ length: faces.length * 4 }, (_, i) => i);
  const root = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const join = (a: number, b: number) => { parent[root(a)] = root(b); };
  type Edge = { a: number; b: number; voxelId: number };
  const edges = new Map<string, Edge[]>();
  faces.forEach((face, fi) => {
    face.corners.forEach((p, corner) => {
      const next = (corner + 1) % 4, q = face.corners[next];
      const pk = p.join(','), qk = q.join(',');
      const forward = pk < qk, k = forward ? `${pk}/${qk}` : `${qk}/${pk}`;
      const edge = { a: fi * 4 + (forward ? corner : next), b: fi * 4 + (forward ? next : corner), voxelId: face.voxelId };
      const bucket = edges.get(k);
      if (bucket) bucket.push(edge); else edges.set(k, [edge]);
    });
  });
  for (const bucket of edges.values()) {
    if (bucket.length !== 2 && bucket.length !== 4) throw new Error('模型表面未闭合，无法导出打印文件。');
    for (let i = 0; i < bucket.length; i++) for (let j = i + 1; j < bucket.length; j++) {
      if (bucket.length === 2 || bucket[i].voxelId === bucket[j].voxelId) {
        join(bucket[i].a, bucket[j].a); join(bucket[i].b, bucket[j].b);
      }
    }
  }
  const vertices: Point[] = [], triangles: Point[] = [], ids = new Map<number, number>();
  faces.forEach((face, fi) => {
    const corners = face.corners.map((point, ci) => {
      const r = root(fi * 4 + ci);
      if (!ids.has(r)) { ids.set(r, vertices.length); vertices.push(point); }
      return ids.get(r)!;
    });
    triangles.push([corners[0], corners[1], corners[2]], [corners[0], corners[2], corners[3]]);
  });
  return { vertices, triangles };
}

export function buildExportMeshes(inspection: ExportInspection): ExportMesh[] {
  const buckets = new Map<string, Voxel[]>();
  for (const voxel of inspection.selected.voxels) {
    const k = `${voxel.partId}/${voxel.color.toUpperCase()}`;
    const bucket = buckets.get(k);
    if (bucket) bucket.push(voxel); else buckets.set(k, [voxel]);
  }
  let surfaceFaces = 0;
  return [...buckets.values()].map(voxels => {
    const cells = new Set(voxels.map(cellKey)), faces: ExportFace[] = [];
    for (const voxel of voxels) {
      for (const { delta, corners } of directions) {
        if (cells.has(key(voxel.cell.x + delta[0], voxel.cell.y + delta[1], voxel.cell.z + delta[2]))) continue;
        // Sparse/checkerboard scenes can expand into millions of faces even
        // within the scene cell budget. Fail explicitly rather than lose detail.
        if (++surfaceFaces > 2_000_000) throw new Error('所选模型的表面过于复杂（超过 200 万个方块面），请分批选择物件导出；不会删减模型细节。');
        faces.push({ voxelId: voxel.id, normal: delta, corners: corners.map(p => [
          voxel.cell.x - inspection.min[0] + p[0], voxel.cell.y - inspection.min[1] + p[1], voxel.cell.z - inspection.min[2] + p[2],
        ]) });
      }
    }
    return { partId: voxels[0].partId, color: voxels[0].color.toUpperCase(), faces, ...weldSurface(faces) };
  });
}
