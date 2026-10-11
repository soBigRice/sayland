/** Explicit paid-provider regression. Uses generated fixtures only; never opens the workspace database.
 * Run: node --import tsx apps/api/test/structural-edit.live.ts --run <output-directory> [scenario]
 * Recheck saved operations without a model call: replace --run with --replay.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { VoxelEngine } from '../../../packages/scene/src/index.ts';
import type { ChatRequest, SceneBatch, SceneSnapshot } from '../../../packages/protocol/src/index.ts';
import { loadConfig } from '../src/config.ts';
import type { PlanTrace } from '../src/errors.ts';
import { modelViews } from '../src/geometry-views.ts';
import { createProviders } from '../src/providers.ts';

const key = (cell: { x: number; y: number; z: number }) => `${cell.x},${cell.y},${cell.z}`;
const voxelMap = (snapshot: SceneSnapshot) => new Map(snapshot.voxels.map(voxel => [voxel.id, voxel]));

function fixture(): SceneSnapshot {
  // Fixed anchors are independent of ongoing changes to the welcome island's layout.
  const engine = new VoxelEngine();
  const snapshot = engine.executeBatch({ protocolVersion: 1, baseRevision: 0, operations: [
    { op: 'define_group', group: { id: 'ground', name: '测试草地' } },
    { op: 'define_part', part: { id: 'grass', name: '草地', role: 'terrain', groupId: 'ground', origin: { x: -16, y: 5, z: -16 } } },
    { op: 'fill_shape', partId: 'grass', color: '#82B741', shape: { kind: 'box', offset: { x: 0, y: 0, z: 0 }, size: { x: 48, y: 1, z: 24 } } },
    { op: 'add_prefab', id: 'home', name: '小房子', prefab: 'house', origin: { x: -8, y: 6, z: -9 } },
    { op: 'add_prefab', id: 'tree', name: '旁边的树', prefab: 'tree', origin: { x: 20, y: 6, z: -9 } },
  ] }, 'fixture').snapshot;
  return { ...snapshot, revision: 0 };
}

function verifyFlatRoof(before: SceneSnapshot, after: SceneSnapshot): void {
  const byId = new Map(after.voxels.map(voxel => [voxel.id, voxel]));
  const cells = new Map(after.voxels.map(voxel => [key(voxel.cell), voxel]));
  const houseParts = new Set(before.parts.filter(part => part.groupId === 'home').map(part => part.id));
  for (const voxel of before.voxels) {
    const preserved = !houseParts.has(voxel.partId) || ['home-floor', 'home-door'].includes(voxel.partId)
      || (['home-walls', 'home-windows'].includes(voxel.partId) && voxel.cell.y <= 13);
    if (preserved) assert.deepEqual(byId.get(voxel.id), voxel, `unrelated geometry changed: ${voxel.id}`);
  }
  assert.deepEqual(after.groups, before.groups, 'a local remodel must preserve object groups');
  const afterHouse = new Set(after.parts.filter(part => part.groupId === 'home').map(part => part.id));
  assert.deepEqual(after.voxels.filter(voxel => !afterHouse.has(voxel.partId)), before.voxels.filter(voxel => !houseParts.has(voxel.partId)),
    'no unrelated additions, recolors or deletions');
  const roofParts = new Set(after.parts.filter(part => part.groupId === 'home' && part.role === 'roof').map(part => part.id));
  const roof = after.voxels.filter(voxel => roofParts.has(voxel.partId));
  assert.ok(roof.length > 0, 'roof is present');
  assert.equal(Math.min(...roof.map(voxel => voxel.cell.y)), 14, 'roof meets the existing main wall line, not the gable peak');
  // Judge the surface above the house footprint. Thickness and an outer parapet are valid flat-roof details.
  const roofTops = new Map<string, number>();
  for (const voxel of roof) {
    if (voxel.cell.x < -8 || voxel.cell.x > 2 || voxel.cell.z < -9 || voxel.cell.z > -1) continue;
    const column = `${voxel.cell.x},${voxel.cell.z}`;
    roofTops.set(column, Math.max(roofTops.get(column) ?? -Infinity, voxel.cell.y));
  }
  assert.equal(new Set(roofTops.values()).size, 1, 'roof surface above the house is flat');
  for (let x = -8; x <= 2; x++) for (let z = -9; z <= -1; z++) {
    const cover = cells.get(key({ x, y: 14, z }));
    assert.ok(cover && (roofParts.has(cover.partId) || cover.partId === 'home-chimney'), `uncovered house column: ${x},${z}`);
  }
  assert.ok(!after.voxels.some(voxel => ['home-walls', 'home-windows'].includes(voxel.partId) && voxel.cell.y > 13),
    'obsolete gables and attic window must not protrude through the new roof');
  const chimney = after.voxels.filter(voxel => voxel.partId === 'home-chimney');
  assert.ok(chimney.length > 0, 'retain the chimney and reconnect it');
  const connected = new Set(roof.map(voxel => key(voxel.cell)));
  const pending = [...chimney];
  for (let progress = true; progress && pending.length;) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const { x, y, z } = pending[i].cell;
      if ([[x-1,y,z],[x+1,y,z],[x,y-1,z],[x,y+1,z],[x,y,z-1],[x,y,z+1]].some(([x,y,z]) => connected.has(key({ x,y,z })))) {
        connected.add(key(pending[i].cell)); pending.splice(i, 1); progress = true;
      }
    }
  }
  assert.equal(pending.length, 0, 'all chimney cells connect to the roof');
}

async function run() {
  const replay = process.argv[2] === '--replay';
  if ((!replay && process.argv[2] !== '--run') || !process.argv[3]) throw new Error('Use --run <output-directory> for a paid model call, or --replay for saved operations.');
  const output = resolve(process.argv[3]);
  await mkdir(output, { recursive: true });
  const provider = replay ? null : createProviders(loadConfig());
  const initial = fixture();
  const scenarios = ['roof-removed', 'incorrect-flat-roof'];
  if (process.argv[4]) assert.ok(scenarios.includes(process.argv[4]), 'unknown scenario');
  for (const scenario of process.argv[4] ? [process.argv[4]] : scenarios) {
    const engine = VoxelEngine.fromSnapshot(initial);
    engine.executeBatch({ protocolVersion: 1, baseRevision: engine.snapshot().revision, operations: [{ op: 'remove_part', partId: 'home-roof' }] }, 'fixture-remove');
    const history: ChatRequest['messages'] = [
      { role: 'user', content: '把房子的屋顶掀掉。' },
      { role: 'assistant', content: '掀掉屋顶啦，小房子现在是敞开的，还能看到墙壁上的小山墙和烟囱。' },
    ];
    if (scenario === 'incorrect-flat-roof') {
      // Exact geometry of the reported failure, reconstructed without reading private saved scenes.
      engine.executeBatch({ protocolVersion: 1, baseRevision: engine.snapshot().revision, operations: [
        { op: 'define_part', part: { id: 'home-roof', name: '小房子平屋顶', role: 'roof', groupId: 'home', origin: { x: -9, y: 19, z: -10 } } },
        { op: 'write_layers', partId: 'home-roof', offset: { x: 0, y: 0, z: 0 }, mode: 'add', palette: [{ symbol: 'R', color: '#B05C3E' }],
          layers: [{ y: 0, rows: Array.from({ length: 11 }, (_, z) => z === 3 || z === 4 ? 'RRR..RRRRRRRR' : 'RRRRRRRRRRRRR') }] },
      ] }, 'fixture-incorrect');
      history.push({ role: 'user', content: '给他把屋顶改成平的。' }, { role: 'assistant', content: '平屋顶铺好了，整整齐齐盖在墙上还稍微探出一点，烟囱从中间穿出去。' });
      assert.throws(() => verifyFlatRoof(initial, engine.snapshot()), /gable peak/, 'the regression oracle must reject the reported failure');
    }
    const before = engine.snapshot(), requestId = `structural-${scenario}`;
    if (replay) {
      const saved = JSON.parse(await readFile(resolve(output, `${scenario}.json`), 'utf8')) as { batches: SceneBatch[] };
      for (const [index, batch] of saved.batches.entries()) engine.executeBatch(batch, `${requestId}-${index + 1}`, requestId);
      const after = engine.snapshot();
      verifyFlatRoof(before, after);
      engine.undo(); assert.deepEqual(voxelMap(engine.snapshot()), voxelMap(before), 'one undo restores the entire remodeling turn');
      engine.redo(); assert.deepEqual(voxelMap(engine.snapshot()), voxelMap(after), 'redo restores the validated result');
      console.log(JSON.stringify({ scenario, replayed: true, passed: true }));
      continue;
    }
    const batches: SceneBatch[] = []; let diagnostics: PlanTrace | undefined;
    const began = Date.now();
    const result = await provider!.plan({ requestId, snapshot: before, messages: history,
      text: scenario === 'roof-removed' ? '给他把屋顶改成平的。' : '屋顶下面怎么有这么大空隙？把它改成正常贴着墙的平屋顶。',
    }, new AbortController().signal, {
      onCommentary: text => console.log(JSON.stringify({ scenario, commentary: text })),
      onDiagnostics: trace => { diagnostics = trace; },
      commitBatch: async batch => {
        batches.push(batch);
        return engine.executeBatch(batch, `${requestId}-${batches.length}`, requestId).snapshot;
      },
    });
    const after = engine.snapshot();
    const views = modelViews(after, { revision: after.revision, groupIds: ['home'], partIds: null, region: null });
    await writeFile(resolve(output, `${scenario}.png`), Buffer.from(views.image.split(',')[1], 'base64'));
    await writeFile(resolve(output, `${scenario}.json`), JSON.stringify({ result, batches, diagnostics, elapsedMs: Date.now() - began }, null, 2));
    verifyFlatRoof(before, after);
    engine.undo(); assert.deepEqual(voxelMap(engine.snapshot()), voxelMap(before), 'one undo restores the entire remodeling turn');
    engine.redo(); assert.deepEqual(voxelMap(engine.snapshot()), voxelMap(after), 'redo restores the validated result');
    console.log(JSON.stringify({ scenario, passed: true, batches: batches.length, diagnostics, elapsedMs: Date.now() - began }));
  }
}

await run();
