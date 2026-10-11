import { add, assertCell, MAX_CANDIDATE_CELLS, type Vec3 } from './coordinates.ts';
import type { AiOperation, Part } from '../../protocol/src/index.ts';

export type LayerWrite = Extract<AiOperation, { op: 'write_layers' }>;
export type CellWrite = { cell: Vec3; color: string | null };

export function expandLayers(part: Part, op: LayerWrite): CellWrite[] {
  const colors = new Map<string, string>();
  for (const entry of op.palette) {
    if (colors.has(entry.symbol)) throw new Error(`颜色符号 ${entry.symbol} 重复`);
    colors.set(entry.symbol, entry.color.toUpperCase());
  }
  const width = op.layers[0].rows[0].length;
  const depth = op.layers[0].rows.length;
  if (width * depth * op.layers.length > MAX_CANDIDATE_CELLS) throw new Error('本次切片超过候选格数限制，请分批写入');
  const levels = new Set<number>();
  const writes: CellWrite[] = [];
  const origin = add(part.origin, op.offset);
  for (const layer of op.layers) {
    if (levels.has(layer.y)) throw new Error(`高度 ${layer.y} 重复，请在一个切片中描述这一层`);
    levels.add(layer.y);
    if (layer.rows.length !== depth) throw new Error('同一补丁的切片行数必须一致');
    for (let z = 0; z < depth; z++) {
      const row = layer.rows[z];
      if (row.length !== width) throw new Error(`Y=${layer.y}、Z=${z} 的行宽应为 ${width}`);
      for (let x = 0; x < width; x++) {
        const cell = add(origin, { x, y: layer.y, z });
        assertCell(cell);
        const symbol = row[x];
        if (symbol === '.') {
          if (op.mode === 'replace') writes.push({ cell, color: null });
        } else {
          const color = colors.get(symbol);
          if (!color) throw new Error(`符号 ${symbol} 没有对应的颜色`);
          writes.push({ cell, color });
        }
      }
    }
  }
  return writes;
}

export function inRegion(cell: Vec3, origin: Vec3, region: { min: Vec3; max: Vec3 }): boolean {
  return (['x', 'y', 'z'] as const).every(axis => cell[axis] - origin[axis] >= region.min[axis] && cell[axis] - origin[axis] <= region.max[axis]);
}

export function assertRegion(region: { min: Vec3; max: Vec3 }): void {
  if ((['x', 'y', 'z'] as const).some(axis => region.min[axis] > region.max[axis])) throw new Error('区域最小坐标不能大于最大坐标');
}
