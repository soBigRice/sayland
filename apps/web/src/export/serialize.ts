import { BufferGeometry, Color, Float32BufferAttribute, Group, Mesh, MeshPhongMaterial, SRGBColorSpace, type DataTexture } from 'three';
import { FBXExporter, encodeRGBA8PNG } from '@comfyorg/fbx-exporter-three';
import { strToU8, zipSync } from 'fflate';
import type { SceneSnapshot } from '../../../../packages/protocol/src/index.ts';
import { buildExportMeshes, inspectExport, type ExportInspection, type ExportMesh, type ExportOptions } from '../../../../packages/scene/src/export.ts';
import { makeEdgeTexture } from '../scene/voxelMaterial.ts';

const xml = (value: string) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
export const exportFilename = (name: string) => (name.replace(/[\u0000-\u001F<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').slice(0, 80) || 'Sayland') + '-模型.zip';

export function createThreeMF(info: ExportInspection, meshes: ExportMesh[], scale: number): Uint8Array<ArrayBuffer> {
  const objects = meshes.map((mesh, i) => {
    const part = info.selected.parts.find(p => p.id === mesh.partId)!;
    const vertices = mesh.vertices.map(([x, y, z]) => `<vertex x="${x * scale}" y="${(info.extent[2] - z) * scale}" z="${y * scale}"/>`).join('');
    const colorIndex = info.colors.indexOf(mesh.color);
    // Bambu Studio's standard 3MF importer reads m:colorgroup and triangle
    // properties. Also retain the core base material as an object default.
    const triangles = mesh.triangles.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}" pid="2" p1="${colorIndex}" p2="${colorIndex}" p3="${colorIndex}"/>`).join('');
    return `<object id="${i + 3}" type="model" name="${xml(`${part.name} ${mesh.color}`)}" partnumber="${xml(part.id)}" pid="1" pindex="${colorIndex}"><mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh></object>`;
  }).join('');
  const rootId = meshes.length + 3;
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="zh-CN" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
<metadata name="Title">${xml(info.selected.model.name)}</metadata><metadata name="Application">Sayland</metadata>
<resources><basematerials id="1">${info.colors.map(color => `<base name="${color}" displaycolor="${color}FF"/>`).join('')}</basematerials><m:colorgroup id="2">${info.colors.map(color => `<m:color color="${color}FF"/>`).join('')}</m:colorgroup>${objects}
<object id="${rootId}" type="model" name="${xml(info.selected.model.name)}"><components>${meshes.map((_, i) => `<component objectid="${i + 3}"/>`).join('')}</components></object></resources>
<build><item objectid="${rootId}"/></build></model>`;
  // A single assembly preserves heights and relative positions on import. Each
  // color/part is a closed volume, including interfaces to other materials.
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': strToU8(model),
  }, { level: 6 });
}

export function createFBX(info: ExportInspection, meshes: ExportMesh[], scale: number) {
  const scene = new Group(); scene.name = info.selected.model.name;
  const texture = makeEdgeTexture(), textures: DataTexture[] = [texture];
  const textureFiles: Record<string, Uint8Array> = {
    'textures/voxel-edge.png': encodeRGBA8PNG(texture.image.data as Uint8Array, 64, 64),
  };
  const materials = new Map<string, MeshPhongMaterial>(), geometries: BufferGeometry[] = [];
  try {
    const groups = new Map<string, Group>(), parts = new Map<string, Group>();
    for (const group of info.selected.groups ?? []) {
      const node = new Group(); node.name = group.name; node.userData = { saylandGroupId: group.id };
      groups.set(group.id, node); scene.add(node);
    }
    for (const part of info.selected.parts) {
      const node = new Group(); node.name = part.name; node.userData = { saylandPartId: part.id, role: part.role };
      parts.set(part.id, node); (groups.get(part.groupId ?? '') ?? scene).add(node);
    }
    for (const mesh of meshes) {
      let material = materials.get(mesh.color);
      if (!material) {
        // Blender connects an FBX diffuse texture straight to Base Color,
        // ignoring its material tint. Bake tint * edge in linear light, then
        // encode sRGB pixels; white diffuse avoids double tinting in Three.
        const tinted = makeEdgeTexture(); textures.push(tinted);
        tinted.name = `Sayland-${mesh.color.slice(1)}`;
        const pixels = tinted.image.data as Uint8Array, tint = new Color(mesh.color), pixel = new Color();
        for (let i = 0; i < pixels.length; i += 4) {
          const shade = pixels[i] / 255;
          pixel.setRGB(shade, shade, shade, SRGBColorSpace).multiply(tint).convertLinearToSRGB();
          pixels[i] = Math.round(pixel.r * 255); pixels[i + 1] = Math.round(pixel.g * 255); pixels[i + 2] = Math.round(pixel.b * 255);
        }
        textureFiles[`textures/${tinted.name}.png`] = encodeRGBA8PNG(pixels, 64, 64);
        material = new MeshPhongMaterial({ color: '#FFFFFF', map: tinted, specular: 0, shininess: 0 });
        material.name = mesh.color;
        materials.set(mesh.color, material);
      }
      const position: number[] = [], normal: number[] = [], uv: number[] = [], indices: number[] = [];
      for (const face of mesh.faces) {
        const base = position.length / 3;
        for (const p of face.corners) { position.push(...p.map(n => n * scale)); normal.push(...face.normal); }
        uv.push(0,0, 1,0, 1,1, 0,1); indices.push(base,base+1,base+2, base,base+2,base+3);
      }
      const geometry = new BufferGeometry(); geometries.push(geometry);
      geometry.setAttribute('position', new Float32BufferAttribute(position, 3));
      geometry.setAttribute('normal', new Float32BufferAttribute(normal, 3));
      geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2)); geometry.setIndex(indices);
      const node = new Mesh(geometry, material); node.name = `${parts.get(mesh.partId)!.name} ${mesh.color}`;
      node.userData = { saylandPartId: mesh.partId, color: mesh.color };
      parts.get(mesh.partId)!.add(node);
    }
    scene.updateMatrixWorld(true);
    const fbx = new FBXExporter().parseSync(scene, { unitScale: 0.1, axisUp: 'Y', axisForward: 'Z',
      includeAnimations: false, embedTextures: true, customProperties: true, creator: 'Sayland' });
    return { fbx, textureFiles };
  } finally {
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose()); scene.clear();
  }
}

export function createExportArchive(snapshot: SceneSnapshot, options: ExportOptions) {
  const info = inspectExport(snapshot, options), meshes = buildExportMeshes(info), scale = options.millimetersPerVoxel;
  const threeMF = createThreeMF(info, meshes, scale), { fbx, textureFiles } = createFBX(info, meshes, scale);
  const metadata = {
    format: 'sayland-model-export', version: 1, name: snapshot.model.name, revision: snapshot.revision,
    millimetersPerVoxel: scale, dimensionsMm: info.dimensions, sourceMinimum: info.min,
    coordinates: { threeMF: 'X=x-minX; Y=maxZ+1-z; Z=y-minY; millimeters', fbx: 'Y-up; rebased to sourceMinimum; millimeters (UnitScaleFactor=0.1)' },
    colors: info.colors, materials: info.colors.map(color => ({ color, sourceShading: 'MeshLambertMaterial', opacity: 1,
      sourceTexture: 'textures/voxel-edge.png', fbxTexture: `textures/Sayland-${color.slice(1)}.png`, physicalFilament: null })),
    parts: info.selected.parts, groups: info.selected.groups, voxelCount: info.selected.voxels.length,
    components: info.components, floatingComponents: info.floatingComponents, unsupportedFaces: info.unsupportedFaces,
    meshes: meshes.map(m => ({ partId: m.partId, color: m.color, triangles: m.triangles.length })),
  };
  const readme = `说说岛 · Sayland 模型导出

model.3mf：毫米单位的打印模型，保留部件、颜色分区与相对位置。一个装配体内的每个颜色部件均为闭合实体。
model.fbx：二进制 FBX 7.4，保留物件/部件层级、颜色、UV及内嵌方块边缘贴图，Y向上，毫米单位。
materials.json：原始颜色、材质说明、物件归属、尺寸及打印检查结果。
scene.snapshot.json：仅所选内容的原始场景快照；不含对话/历史，也不是设置中可直接导入的作品备份。
textures/：原始方块边缘贴图，以及 FBX 内嵌的各颜色贴图副本。FBX 将原色和边缘效果合成到贴图，避免不同软件忽略材质底色；原始色值仍在材质名和 materials.json 中。

当前尺寸：${info.dimensions.map(n => Number(n.toFixed(3))).join(' × ')} mm（长×宽×高），每格 ${scale} mm，共 ${info.colors.length} 种颜色。

拓竹打印：
1. 解压，在 Bambu Studio 导入 model.3mf，保留单一装配体/多个部件的结构与相对位置。
2. 选择你的打印机、喷嘴、打印板和真实耗材。支持标准3MF颜色解析的版本可映射颜色；未识别颜色时，按部件名称中的 #RRGGBB 手动指定耗材。模型没有预设或替换你的机器配置。
3. 按实际 AMS 容量映射/合并颜色；${info.colors.length} 种模型颜色不代表机器能同时打印这些颜色。颜色值不等于 PLA/PETG 等物理材料。
4. 检查尺寸、最薄处、悬垂与支撑，再切片并查看每层预览；本文件不包含 G-code，未经实际打印验收。

结构检查：${info.components} 个面相连实体，其中 ${info.floatingComponents} 个未接触底面；${info.unsupportedFaces} 个底面上方的朝下暴露面。分离、仅边/点接触、悬空或过薄细节可能需要支撑、拆件或改造。
不会自动加底座、支撑、合并颜色或删除水面/地形。FBX的漫反射材质和贴图用于数字外观；灯光、阴影、AO及屏幕渲染效果不是可打印材质，边缘贴图不会变为打印几何。
`;
  const bytes = zipSync({
    'model.3mf': [threeMF, { level: 0 }], 'model.fbx': fbx,
    'materials.json': strToU8(JSON.stringify(metadata, null, 2)),
    'scene.snapshot.json': strToU8(JSON.stringify(info.selected)),
    ...textureFiles, '打印说明.txt': strToU8(readme),
  }, { level: 6 });
  return { bytes, filename: exportFilename(snapshot.model.name) };
}
