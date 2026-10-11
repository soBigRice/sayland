import type { AiOperation, Group, Part } from '../../protocol/src/index.ts';
import { partSchema } from '../../protocol/src/index.ts';
import { cellKey, type Vec3 } from './coordinates.ts';

type Prefab = Extract<AiOperation, { op: 'add_prefab' }>;
export type PrefabVoxel = { cell: Vec3; color: string; partId: string };
export type PrefabGeometry = { groups: Group[]; parts: Part[]; voxels: PrefabVoxel[] };

// Templates produce ordinary editable cells; they are never replayed after a local edit.
export function createPrefabGeometry(input: Prefab): PrefabGeometry {
  const parts: Part[] = [];
  const cells = new Map<string, PrefabVoxel>();
  const part = (suffix: string, label: string, role: Part['role']) => {
    const id = suffix ? `${input.id}-${suffix}` : input.id;
    parts.push(partSchema.parse({ id, name: `${input.name}${label}`, role, origin: input.origin, groupId: input.id }));
    return id;
  };
  const put = (id: string, x: number, y: number, z: number, color: string) => {
    const cell = { x, y, z };
    cells.set(cellKey(cell), { cell, color, partId: id });
  };
  const box = (id: string, min: Vec3, size: Vec3, colors: string[]) => {
    for (let y = 0; y < size.y; y++) for (let z = 0; z < size.z; z++) for (let x = 0; x < size.x; x++) {
      const variation = Math.abs((min.x + x) * 17 + (min.y + y) * 7 + (min.z + z) * 13) % colors.length;
      put(id, min.x + x, min.y + y, min.z + z, colors[variation]);
    }
  };
  switch (input.prefab) {
    case 'house': {
      const floor = part('floor', '地基', 'floor');
      const wall = part('walls', '墙壁', 'wall');
      const roof = part('roof', '屋顶', 'roof');
      const door = part('door', '木门', 'door');
      const window = part('windows', '窗户', 'window');
      const chimney = part('chimney', '烟囱', 'detail');
      box(floor, { x: 0, y: 0, z: 0 }, { x: 11, y: 1, z: 9 }, ['#AAAFA9', '#A7ACA6', '#ADB2AC']);
      for (let y = 1; y <= 7; y++) for (let z = 0; z < 9; z++) for (let x = 0; x < 11; x++) {
        if (x === 0 || x === 10 || z === 0 || z === 8) put(wall, x, y, z, ['#F3E2B7', '#F1DFB3', '#F5E5BB'][(x + z + y) % 3]);
      }
      for (let y = 1; y <= 5; y++) for (let x = 4; x <= 6; x++) put(door, x, y, 8, (x + y) % 3 === 0 ? '#B37536' : '#B97B3B');
      put(door, 6, 3, 8, '#65452D');
      for (let y = 3; y <= 5; y++) for (let z = 3; z <= 5; z++) {
        put(window, 10, y, z, y === 4 || z === 4 ? '#B78040' : '#A9DAD8');
        put(window, 0, y, z, y === 4 || z === 4 ? '#B78040' : '#A9DAD8');
      }
      for (let y = 3; y <= 5; y++) for (const x of [1, 2, 8, 9]) put(window, x, y, 8, y === 4 ? '#B78040' : '#FFE6A0');
      for (const x of [1, 2, 8, 9]) put(window, x, 2, 9, '#E6CE9E');
      for (const x of [0, 10]) for (let z = 2; z <= 6; z++) put(window, x === 0 ? -1 : 11, 2, z, '#E6CE9E');
      // True gable, continuous eaves and a ridge: a roof silhouette, rather than stacked solid boxes.
      for (let level = 0; level < 6; level++) {
        const left = -1 + level, right = 11 - level;
        for (let z = -1; z <= 9; z++) for (let x = left; x <= right; x++) {
          if (x === left || x === right || level === 5) {
            put(roof, x, 8 + level, z, z === -1 || z === 9 ? '#BA4935' : (z + level) % 3 === 0 ? '#ED6447' : '#E8583D');
          } else if (z === 0 || z === 8) put(wall, x, 8 + level, z, '#F1DFB3');
        }
      }
      for (let z = -1; z <= 9; z++) put(roof, 5, 14, z, '#F0734C');
      put(window, 5, 10, 8, '#A9DAD8'); put(window, 5, 11, 8, '#B78040');
      box(chimney, { x: 2, y: 12, z: 2 }, { x: 2, y: 6, z: 2 }, ['#B9BAC0', '#BDBEC3', '#B7B8BE']);
      box(chimney, { x: 2, y: 16, z: 2 }, { x: 2, y: 1, z: 2 }, ['#969BA1']);
      for (const x of [2, 3]) for (const z of [2, 3]) put(chimney, x, 17, z, '#767B81');
      break;
    }
    case 'tree': {
      const trunk = part('trunk', '树干', 'plant');
      const leaves = part('leaves', '树冠', 'plant');
      box(trunk, { x: 0, y: 0, z: 0 }, { x: 2, y: 9, z: 2 }, ['#A8793B', '#AD7D3F', '#A57538']);
      put(trunk, -1, 5, 0, '#A57538'); put(trunk, -1, 6, 0, '#AD7D3F');
      put(trunk, 2, 6, 1, '#A57538'); put(trunk, 2, 7, 1, '#AD7D3F');
      // Overlapping rounded lobes keep a recognizable canopy from all sides, with coherent light/shade patches.
      const lobes = [[-0.5, 8.5, 0.5, 3.3, 3.5, 3.2], [2, 8, 1.5, 2.8, 3, 2.7], [0.5, 11, 0.5, 2.7, 3.2, 2.6]];
      for (let y = 5; y <= 14; y++) for (let z = -3; z <= 4; z++) for (let x = -3; x <= 4; x++) {
        if (!lobes.some(([cx, cy, cz, rx, ry, rz]) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2 <= 1)) continue;
        put(leaves, x, y, z, y >= 12 ? '#A1CF54' : y <= 6 ? '#6FA33A' : x + z < 0 ? '#8FC448' : '#82B741');
      }
      break;
    }
    case 'duck': {
      const body = part('', '', 'animal');
      const beak = part('beak', '小嘴', 'animal');
      for (let y = 0; y <= 2; y++) for (let z = 0; z <= 4; z++) for (let x = -2; x <= 2; x++) {
        if ((x / 2.5) ** 2 + ((z - 2) / 3) ** 2 + ((y - 1) / 1.8) ** 2 > 1) continue;
        put(body, x, y, z, y === 0 ? '#F5C33D' : '#FFDA50');
      }
      box(body, { x: -1, y: 2, z: 2 }, { x: 3, y: 3, z: 2 }, ['#FFE16A']);
      put(body, 0, 5, 3, '#FFE780');
      for (const x of [-2, 2]) for (const z of [1, 2]) put(body, x, 1, z, '#EDB837');
      put(body, 0, 2, 0, '#FFE780'); put(body, 0, 2, -1, '#FFE780');
      put(body, -1, 4, 3, '#51452F'); put(body, 1, 4, 3, '#51452F');
      for (const x of [-1, 0, 1]) put(beak, x, 3, 4, '#F39B35');
      put(beak, 0, 3, 5, '#ED882C');
      break;
    }
    case 'flowers': {
      const stems = part('stems', '花茎', 'plant');
      const petals = part('petals', '花瓣', 'plant');
      for (const [x, z, height] of [[0, 0, 2], [3, 2, 3], [5, 0, 2]]) {
        for (let y = 0; y < height; y++) put(stems, x, y, z, '#5EAC4A');
        put(stems, x + 1, 0, z, '#84BC4D');
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) put(petals, x + dx, height, z + dz, '#FFFAE6');
        put(petals, x, height, z, '#F2CE53');
      }
      break;
    }
    case 'river': {
      const water = part('', '', 'water');
      for (let z = 0; z < 14; z++) {
        const bend = Math.round(Math.sin(z * 0.38) * 2);
        for (let x = -2; x <= 2; x++) put(water, x + bend, 0, z, ['#48BFDD', '#4CC3E0', '#45BCDA'][(x + z + 20) % 3]);
      }
      break;
    }
  }
  return { groups: [{ id: input.id, name: input.name }], parts, voxels: [...cells.values()] };
}

export function prefabOperations(input: Prefab): Exclude<AiOperation, Prefab>[] {
  const geometry = createPrefabGeometry(input);
  const operations: Exclude<AiOperation, Prefab>[] = geometry.groups.map(group => ({ op: 'define_group', group }));
  operations.push(...geometry.parts.map(part => ({ op: 'define_part' as const, part })));
  for (const part of geometry.parts) {
    const cells = geometry.voxels.filter(v => v.partId === part.id).map(v => ({ cell: v.cell, color: v.color }));
    for (let i = 0; i < cells.length; i += 4096) operations.push({ op: 'patch_cells', partId: part.id, cells: cells.slice(i, i + 4096) });
  }
  return operations;
}
