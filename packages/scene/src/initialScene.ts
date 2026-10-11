import { snapshotSchema, type Group, type Part, type SceneSnapshot } from '../../protocol/src/index.ts';
import { add, cellKey, type Vec3 } from './coordinates.ts';
import { createPrefabGeometry, type PrefabVoxel } from './prefabs.ts';

// This starter island is real editable geometry, built deterministically without a model request.
export function createInitialScene(): SceneSnapshot {
  const parts = new Map<string, Part>();
  const groups = new Map<string, Group>();
  const cells = new Map<string, PrefabVoxel>();
  const define = (id: string, name: string, role: Part['role'], groupId = id, groupName = name) => {
    groups.set(groupId, { id: groupId, name: groupName });
    parts.set(id, { id, name, role, origin: { x: 0, y: 0, z: 0 }, groupId });
    return id;
  };
  const put = (partId: string, x: number, y: number, z: number, color: string) => {
    const cell = { x, y, z }; cells.set(cellKey(cell), { partId, cell, color });
  };
  const box = (id: string, min: Vec3, size: Vec3, colors: string[]) => {
    for (let y = 0; y < size.y; y++) for (let z = 0; z < size.z; z++) for (let x = 0; x < size.x; x++) {
      put(id, min.x + x, min.y + y, min.z + z, colors[Math.abs((x + min.x) * 17 + (y + min.y) * 3 + (z + min.z) * 11) % colors.length]);
    }
  };
  const prefab = (id: string, name: string, kind: 'house' | 'tree' | 'duck' | 'flowers', origin: Vec3) => {
    const geometry = createPrefabGeometry({ op: 'add_prefab', prefab: kind, id, name, origin });
    for (const group of geometry.groups) groups.set(group.id, group);
    for (const part of geometry.parts) parts.set(part.id, part);
    for (const voxel of geometry.voxels) {
      const cell = add(origin, voxel.cell);
      cells.set(cellKey(cell), { ...voxel, cell });
    }
  };
  const water = define('lagoon', '环岛的小河', 'water');
  const soil = define('island-soil', '小岛泥土', 'terrain', 'island-terrain', '小岛地形');
  const grass = define('island-grass', '青青的草地', 'terrain', 'island-terrain', '小岛地形');
  const sand = define('beach', '奶油色沙滩', 'terrain', 'island-terrain', '小岛地形');
  const stone = define('rocks', '岸边石头', 'detail');
  const path = define('path', '门前的小路', 'detail');
  const bridge = define('bridge', '河上的小木桥', 'detail');
  const reeds = define('grass-tufts', '草丛', 'plant');
  const lily = define('lily-pads', '水上的荷叶', 'plant');
  // Starter terrain is a place to begin, never a boundary for later creations.
  // Leave broad, genuinely editable plains around the starter buildings; keep the full soil/water depth.
  for (let x = -72; x <= 71; x++) for (let z = -88; z <= 39; z++) {
    const corner = Math.max(0, Math.abs(x + 0.5) - 56) + Math.max(0, Math.abs(z + 24.5) - 48);
    if (corner > 18 || (x === -72 && z % 4 === 0) || (z === 39 && x % 5 === 0)) continue;
    for (let y = -3; y <= 0; y++) put(water, x, y, z, ['#48BFDE', '#4CC3E0', '#45BCDB', '#4AC1DF'][Math.abs(x * 3 + y + z * 5) % 4]);
  }
  for (let x = -56; x <= 55; x++) for (let z = -73; z <= 6; z++) {
    const corner = Math.max(0, Math.abs(x + 0.5) - 44) + Math.max(0, Math.abs(z + 33.5) - 28);
    if (corner > 12 || (x < -52 && z > 2) || (x > 51 && z > 3)) continue;
    const top = z >= 5 ? 3 : 5;
    for (let y = -2; y <= top; y++) {
      const isSand = y <= -1 || (z >= 5 && y <= 1);
      put(y === top ? grass : isSand ? sand : soil, x, y, z,
        y === top ? ['#9CCA53', '#A0CD57', '#9AC850', '#9FCD56'][Math.abs(x * 5 + z * 3) % 4]
          : isSand ? ['#F3DBA7', '#F6DEAC', '#F0D8A4'][Math.abs(x + z + y) % 3]
            : ['#B48151', '#B78454', '#BA8756', '#B58252'][Math.abs(x + z * 3 + y) % 4]);
    }
  }
  // A low sandy tongue and two stepping islands keep the silhouette irregular.
  for (let x = -17; x <= -7; x++) for (let z = 6; z <= 12; z++) {
    if (z > 9 && x > -10 || x === -17 && z > 10) continue;
    box(sand, { x, y: -2, z }, { x: 1, y: 4, z: 1 }, ['#F5DEA9', '#F7E1AD', '#F2DBA5']);
  }
  box(soil, { x: 13, y: 0, z: 5 }, { x: 4, y: 3, z: 4 }, ['#B48150', '#C1915C']);
  box(grass, { x: 13, y: 3, z: 5 }, { x: 4, y: 1, z: 4 }, ['#A3CD61', '#B0D772']);
  box(soil, { x: 3, y: -1, z: 13 }, { x: 3, y: 3, z: 3 }, ['#B78450', '#C39158']);
  box(grass, { x: 3, y: 2, z: 13 }, { x: 3, y: 1, z: 3 }, ['#AAD36B', '#96C355']);
  // Space the three tall landmarks across the enlarged meadow, with separate silhouettes
  // from the default +X/+Z view. Keep their actual prefab scale and leave room to create between them.
  const home = { x: -32, y: 6, z: -40 };
  prefab('home', '小房子', 'house', home);
  prefab('tree-back', '后面的树', 'tree', { x: 12, y: 6, z: -54 });
  prefab('tree-right', '右边的树', 'tree', { x: 31, y: 6, z: -15 });
  prefab('duck', '小黄鸭', 'duck', { x: -23, y: 1, z: 22 });
  prefab('flowers-left', '门边的小花', 'flowers', { x: -40, y: 6, z: -29 });
  prefab('flowers-right', '树下的小花', 'flowers', { x: 25, y: 6, z: -7 });
  // Lead from the +Z-facing door to the existing sandy tongue, following each real surface height.
  // Isolated pavers leave the meadow editable rather than covering it with a solid road.
  const shore = { x: -13, z: 4 };
  const pathStart = { x: home.x + 4, z: home.z + 9 };
  const steps = 12;
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    const bend = t * t * (3 - 2 * t);
    box(path, { x: Math.round(pathStart.x + (shore.x - pathStart.x) * bend), y: 6,
      z: Math.round(pathStart.z + (shore.z - pathStart.z) * t) }, { x: 3, y: 1, z: 1 }, ['#D0CDD0', '#BDBFC2', '#DCD5D1']);
  }
  for (const [z, y] of [[6, 4], [8, 2]]) box(path, { x: shore.x, y, z }, { x: 3, y: 1, z: 1 }, ['#D0CDD0', '#BDBFC2', '#DCD5D1']);
  for (const [x, z] of [[0, 7], [3, 8], [6, 9]]) box(path, { x, y: 1, z }, { x: 2, y: 1, z: 2 }, ['#D1CECA', '#C1C4C3']);
  box(bridge, { x: 9, y: 2, z: 9 }, { x: 7, y: 1, z: 5 }, ['#C48A4D', '#C88E50', '#C18749', '#CB9254']);
  for (const x of [9, 15]) for (const z of [9, 13]) box(bridge, { x, y: -1, z }, { x: 1, y: 5, z: 1 }, ['#A96F38', '#B5793E']);
  box(stone, { x: -21, y: 0, z: 9 }, { x: 3, y: 5, z: 2 }, ['#B8BDB8', '#BDC1BC', '#B4B9B5']);
  box(stone, { x: -18, y: 1, z: 12 }, { x: 2, y: 3, z: 2 }, ['#B5B7B7', '#CFD0C9']);
  for (const [x, y, z] of [[-42, 6, -25], [-35, 6, -43], [18, 6, -51], [34, 6, -10], [-15, 2, 10], [4, 3, 14], [14, 4, 6]]) {
    put(reeds, x, y, z, '#78B748'); put(reeds, x, y + 1, z, '#93C650');
    put(reeds, x + 1, y, z, '#78AD42'); put(reeds, x, y, z + 1, '#99C85C');
  }
  for (const [x, z] of [[-32, 18], [-13, 25], [24, 23], [38, 11]]) {
    put(lily, x, 1, z, '#8AB448'); put(lily, x + 1, 1, z, '#9BC653'); put(lily, x, 1, z + 1, '#7CAA3A');
  }
  const voxels = [...cells.values()].map((voxel, index) => ({ ...voxel, id: index + 1 }));
  return snapshotSchema.parse({ schemaVersion: 2, revision: 0, nextVoxelId: voxels.length + 1,
    grid: { cellSize: 1, up: '+Y', front: '+Z', coordinates: 'minimum-corner' },
    model: { id: 'my-first-island', name: '我的第一座小岛' }, source: null, groups: [...groups.values()], parts: [...parts.values()], voxels });
}
