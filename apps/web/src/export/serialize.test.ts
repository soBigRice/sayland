import test from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync, unzlibSync } from 'fflate';
import { createExportArchive, exportFilename } from './serialize.ts';
import { createInitialScene } from '../../../../packages/scene/src/initialScene.ts';

test('download contains standard 3MF, binary FBX with texture, exact source colors and selected data only', () => {
  const scene = createInitialScene(); scene.model.name = '小岛 <&"测试>';
  const before = JSON.stringify(scene);
  const { bytes, filename } = createExportArchive(scene, { scope: { kind: 'parts', partIds: ['home-roof'] }, millimetersPerVoxel: 3 });
  assert.equal(JSON.stringify(scene), before);
  assert.equal(filename, '小岛 _&_测试_-模型.zip');
  const archive = unzipSync(bytes);
  assert.deepEqual(Object.keys(archive).filter(name => !name.startsWith('textures/')).sort(), ['materials.json', 'model.3mf', 'model.fbx', 'scene.snapshot.json', '打印说明.txt'].sort());
  const threeMF = unzipSync(archive['model.3mf']);
  assert.deepEqual(Object.keys(threeMF).sort(), ['3D/3dmodel.model','[Content_Types].xml','_rels/.rels'].sort());
  const model = strFromU8(threeMF['3D/3dmodel.model']);
  assert.match(model, /unit="millimeter"/); assert.match(model, /小岛 &lt;&amp;&quot;测试&gt;/);
  assert.match(model, /<basematerials id="1">/); assert.match(model, /pindex="0"/);
  assert.match(model, /<m:colorgroup id="2">/); assert.match(model, /pid="2" p1="0" p2="0" p3="0"/);
  const fbx = archive['model.fbx']; assert.equal(strFromU8(fbx.slice(0,23)), 'Kaydara FBX Binary  \0\x1a\0');
  const png = archive['textures/voxel-edge.png']; assert.deepEqual([...png.slice(0,8)], [137,80,78,71,13,10,26,10]);
  assert.equal(new DataView(png.buffer, png.byteOffset).getUint32(16), 64);
  const metadata = JSON.parse(strFromU8(archive['materials.json']));
  for (const color of metadata.colors as string[]) {
    const baked = archive[`textures/Sayland-${color.slice(1)}.png`];
    assert.ok(Buffer.from(fbx).includes(Buffer.from(baked)), 'actual color PNG embedded in FBX');
    const view = new DataView(baked.buffer, baked.byteOffset, baked.byteLength);
    const chunks: Uint8Array[] = [];
    for (let offset = 8; offset < baked.length;) {
      const size = view.getUint32(offset);
      if (strFromU8(baked.slice(offset + 4, offset + 8)) === 'IDAT') chunks.push(baked.slice(offset + 8, offset + 8 + size));
      offset += size + 12;
    }
    const pixels = unzlibSync(Buffer.concat(chunks));
    const center = 32 * (1 + 64 * 4) + 1 + 32 * 4;
    assert.deepEqual([...pixels.slice(center, center + 3)], [1,3,5].map(i => parseInt(color.slice(i, i + 2), 16)), 'baked texture must carry original color even when the importer ignores material tint');
  }
  const selected = JSON.parse(strFromU8(archive['scene.snapshot.json']));
  assert.equal(metadata.millimetersPerVoxel, 3);
  assert.deepEqual(metadata.colors, [...new Set(scene.voxels.filter(v => v.partId === 'home-roof').map(v => v.color.toUpperCase()))].sort());
  assert.deepEqual(selected.parts.map((p: { id: string }) => p.id), ['home-roof']);
  assert.ok(selected.voxels.every((v: { partId: string }) => v.partId === 'home-roof'));
  assert.ok(!('messages' in selected));
  assert.match(strFromU8(archive['打印说明.txt']), /不包含 G-code/);
});
test('archive filenames cannot create paths or illegal platform filenames', () => {
  assert.equal(exportFilename('../../a\\b:岛'), '.._.._a_b_岛-模型.zip');
  assert.equal(exportFilename('... '), 'Sayland-模型.zip');
});
