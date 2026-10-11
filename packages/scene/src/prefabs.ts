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
        put(window, 10, y, z, y === 4 || z === 4 ? '#B78040' : '#FFD766');
        put(window, 0, y, z, y === 4 || z === 4 ? '#B78040' : '#FFD766');
      }
      for (let y = 3; y <= 5; y++) for (let x = 1; x <= 2; x++) put(window, x, y, 8, y === 4 ? '#B78040' : '#FFE185');
      for (let level = 0; level < 6; level++) {
        const insetZ = Math.floor(level / 2);
        box(roof, { x: -1 + level, y: 8 + level, z: -1 + insetZ }, { x: 13 - level * 2, y: 1, z: 11 - insetZ * 2 }, ['#E95136', '#ED5539', '#E84F35', '#EB5338']);
      }
      box(chimney, { x: 2, y: 12, z: 2 }, { x: 2, y: 6, z: 2 }, ['#B9BAC0', '#BDBEC3', '#B7B8BE']);
      put(chimney, 2, 17, 2, '#84858B');
      break;
    }
    case 'tree': {
      const trunk = part('trunk', '树干', 'plant');
      const leaves = part('leaves', '树冠', 'plant');
      box(trunk, { x: 0, y: 0, z: 0 }, { x: 2, y: 9, z: 2 }, ['#A8793B', '#AD7D3F', '#A57538']);
      box(leaves, { x: -2, y: 6, z: -2 }, { x: 6, y: 4, z: 6 }, ['#83BA3E', '#88BF43', '#80B63B', '#86BD41']);
      box(leaves, { x: -1, y: 10, z: -1 }, { x: 4, y: 3, z: 4 }, ['#8BC345', '#91C84A', '#88BF42']);
      box(leaves, { x: 0, y: 13, z: 0 }, { x: 2, y: 1, z: 2 }, ['#96CB4B', '#92C747']);
      break;
    }
    case 'duck': {
      const body = part('', '', 'animal');
      const beak = part('beak', '小嘴', 'animal');
      box(body, { x: -1, y: 0, z: 0 }, { x: 3, y: 2, z: 4 }, ['#FFD447', '#FFDA50', '#F7C432']);
      box(body, { x: -1, y: 2, z: 2 }, { x: 3, y: 2, z: 2 }, ['#FFE16A', '#FFDE57']);
      put(body, -2, 1, 1, '#F2B829'); put(body, 2, 1, 1, '#F7C434');
      put(body, -1, 3, 3, '#51452F'); put(body, 1, 3, 3, '#51452F');
      put(beak, 0, 2, 4, '#F18729');
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
