import test from 'node:test';
import assert from 'node:assert/strict';
import { VoxelEngine } from '../../../packages/scene/src/index.ts';
import type { AiOperation, ChatRequest } from '../../../packages/protocol/src/index.ts';
import type { ApiConfig } from '../src/config.ts';
import type { ModelMessage } from '../src/deepseek-stream.ts';
import { createProviders } from '../src/providers.ts';
import { changedObjectViews } from '../src/visual-feedback.ts';

const config: ApiConfig = { port: 4311, allowedOrigins: [],
  deepseek: { apiKey: 'fixture', baseUrl: 'https://fixture.invalid', model: 'deepseek-flash' },
  mimo: { apiKey: '', baseUrl: '', asrModel: '', ttsModel: '', voice: '' } };
const object = (id: string, x: number): AiOperation[] => [
  { op: 'define_group', group: { id, name: id } },
  { op: 'define_part', part: { id: `${id}-body`, name: '主体', role: 'other', groupId: id, origin: { x, y: 0, z: 0 } } },
  { op: 'fill_shape', partId: `${id}-body`, shape: { kind: 'box', offset: { x: 0, y: 0, z: 0 }, size: { x: 4, y: 3, z: 2 } }, color: '#BB8844' },
];
const apply = (operations: AiOperation[], id = 'apply') => ({ id, type: 'function', function: {
  name: 'apply_scene', arguments: JSON.stringify({ operations, reply: '这一部分已搭好。' }),
} });
const response = (calls: ReturnType<typeof apply>[]) => Response.json({ choices: [{ finish_reason: calls.length ? 'tool_calls' : 'stop',
  message: { content: calls.length ? null : '完成。', tool_calls: calls, reasoning_content: 'fixture' } }] });
const images = (messages: ModelMessage[]) => messages.filter(message => Array.isArray(message.content)
  && message.content.some(part => part.type === 'image_url'));
const metadata = (message: ModelMessage) => {
  assert.ok(Array.isArray(message.content));
  const text = message.content.find(part => part.type === 'text');
  assert.ok(text && text.type === 'text');
  return JSON.parse(text.text.slice(text.text.indexOf('\n{') + 1)) as { revision: number; voxelCount: number; scope: { groupIds: string[] | null; partIds: string[] | null } };
};

test('committed generation is shown automatically on the existing next model call, without get_views', async () => {
  const engine = new VoxelEngine();
  engine.executeBatch({ protocolVersion: 1, baseRevision: 0, operations: object('untouched', 30) }, 'setup');
  const input: ChatRequest = { requestId: 'automatic-view-fixture', text: '搭一条小船', messages: [], snapshot: engine.snapshot() };
  let calls = 0, commits = 0;
  const provider = createProviders(config, async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { messages: ModelMessage[] };
    if (++calls === 1) return response([apply(object('boat', 0))]);
    assert.equal(commits, 1);
    const attached = images(request.messages);
    assert.equal(attached.length, 1, 'the model must receive the actual new object even if it never asks to see it');
    assert.deepEqual(metadata(attached[0]).scope.groupIds, ['boat']);
    assert.equal(metadata(attached[0]).voxelCount, 24);
    assert.equal(metadata(attached[0]).revision, engine.snapshot().revision);
    return response([]);
  });
  await provider.plan(input, new AbortController().signal, {
    commitBatch: async batch => engine.executeBatch(batch, `commit-${++commits}`, input.requestId).snapshot,
  });
  assert.equal(calls, 2, 'automatic feedback must not add a dedicated paid review call');
});

test('multiple commits in one response produce only latest-revision views of every affected object', async () => {
  const engine = new VoxelEngine(); let calls = 0, commits = 0;
  const provider = createProviders(config, async (_url, init) => {
    if (++calls === 1) return response([apply(object('boat', 0), 'boat'), apply(object('duck', 10), 'duck')]);
    const attached = images((JSON.parse(String(init?.body)) as { messages: ModelMessage[] }).messages);
    assert.equal(attached.length, 2);
    assert.deepEqual(attached.map(message => metadata(message).scope.groupIds), [['boat'], ['duck']]);
    assert.ok(attached.every(message => metadata(message).revision === 2));
    return response([]);
  });
  await provider.plan({ requestId: 'multi-view-fixture', text: '搭船和鸭子', messages: [], snapshot: engine.snapshot() }, new AbortController().signal, {
    commitBatch: async batch => engine.executeBatch(batch, `commit-${++commits}`, 'multi-view-fixture').snapshot,
  });
});

test('a repair replaces old images and shows the whole surviving object after partial deletion', async () => {
  const engine = new VoxelEngine(); let calls = 0, commits = 0;
  const provider = createProviders(config, async (_url, init) => {
    if (++calls === 1) return response([apply(object('boat', 0))]);
    const attached = images((JSON.parse(String(init?.body)) as { messages: ModelMessage[] }).messages);
    assert.equal(attached.length, 1);
    if (calls === 2) {
      assert.equal(metadata(attached[0]).revision, 1);
      return response([apply([{ op: 'remove_region', partId: 'boat-body', region: { min: { x: 0, y: 2, z: 0 }, max: { x: 3, y: 2, z: 1 } } }], 'repair')]);
    }
    assert.equal(metadata(attached[0]).revision, 2);
    assert.equal(metadata(attached[0]).voxelCount, 16);
    return response([]);
  });
  await provider.plan({ requestId: 'repair-view-fixture', text: '搭船', messages: [], snapshot: engine.snapshot() }, new AbortController().signal, {
    commitBatch: async batch => engine.executeBatch(batch, `commit-${++commits}`, 'repair-view-fixture').snapshot,
  });
});

test('whole-object deletion and models without vision do not receive fabricated images', async () => {
  for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
    const engine = new VoxelEngine();
    engine.executeBatch({ protocolVersion: 1, baseRevision: 0, operations: object('boat', 0) }, 'setup');
    let calls = 0;
    const provider = createProviders({ ...config, deepseek: { ...config.deepseek, model } }, async (_url, init) => {
      if (++calls === 1) return response([apply(model === 'deepseek-flash' ? [{ op: 'remove_group', groupId: 'boat' }]
        : [{ op: 'paint_group', groupId: 'boat', color: '#AABBCC' }])]);
      assert.equal(images((JSON.parse(String(init?.body)) as { messages: ModelMessage[] }).messages).length, 0);
      return response([]);
    });
    await provider.plan({ requestId: 'deleted-view-fixture', text: '修改船', messages: [], snapshot: engine.snapshot() }, new AbortController().signal, {
      commitBatch: async batch => engine.executeBatch(batch, 'change').snapshot,
    });
  }
});

test('deleting an entire appendage still frames the complete remaining group', () => {
  const engine = new VoxelEngine();
  const before = engine.executeBatch({ protocolVersion: 1, baseRevision: 0, operations: [
    ...object('boat', 0),
    { op: 'define_part', part: { id: 'oar', name: '桨', role: 'detail', groupId: 'boat', origin: { x: 5, y: 0, z: 0 } } },
    { op: 'patch_cells', partId: 'oar', cells: [{ cell: { x: 0, y: 0, z: 0 }, color: '#112233' }] },
  ] }, 'setup').snapshot;
  const after = engine.executeBatch({ protocolVersion: 1, baseRevision: before.revision, operations: [{ op: 'remove_part', partId: 'oar' }] }, 'delete').snapshot;
  assert.deepEqual(changedObjectViews(before, after), [{ revision: after.revision, groupIds: ['boat'], partIds: null, region: null }]);
});

test('legacy ungrouped geometry has its own view, while metadata-only changes add no images', () => {
  const engine = new VoxelEngine();
  const before = engine.executeBatch({ protocolVersion: 1, baseRevision: 0, operations: [
    { op: 'define_part', part: { id: 'legacy', name: '旧部件', role: 'other', origin: { x: 0, y: 0, z: 0 } } },
    { op: 'patch_cells', partId: 'legacy', cells: [{ cell: { x: 0, y: 0, z: 0 }, color: '#112233' }] },
  ] }, 'setup').snapshot;
  const renamed = engine.rename('新名称').snapshot;
  assert.deepEqual(changedObjectViews(before, renamed), []);
  const painted = engine.executeBatch({ protocolVersion: 1, baseRevision: renamed.revision, operations: [{ op: 'paint_part', partId: 'legacy', region: null, color: '#FFCC00' }] }, 'paint').snapshot;
  assert.deepEqual(changedObjectViews(renamed, painted), [{ revision: painted.revision, groupIds: null, partIds: ['legacy'], region: null }]);
});
