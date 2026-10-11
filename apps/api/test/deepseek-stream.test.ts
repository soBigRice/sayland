import test from 'node:test';
import assert from 'node:assert/strict';
import { completeModel, CompletionBudgetError } from '../src/deepseek-stream.ts';
import { ApiError } from '../src/errors.ts';
import { VoxelEngine } from '../../../packages/scene/src/index.ts';
import type { SceneBatch } from '../../../packages/protocol/src/index.ts';
function event(value: unknown) { return `data: ${JSON.stringify(value)}\r\n\r\n`; }
function stream(text: string, bytes = 7) {
  const encoded = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < encoded.length; i += bytes) controller.enqueue(encoded.slice(i, i + bytes)); controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
test('stream decodes split UTF8, reasoning and tool arguments; only phases are emitted', async () => {
  const phases: string[] = [];
  const text = event({ choices: [{ delta: { reasoning_content: '内部思考，不应泄露' }, finish_reason: null }] })
    + event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-real', type: 'function', function: { name: 'apply_scene', arguments: '{"operations":' } }] }, finish_reason: null }] })
    + event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '[],"reply":"你好"}' } }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\r\n\r\n';
  const result = await completeModel(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); assert.equal(body.stream, true); assert.equal(body.reasoning_effort, 'high'); return stream(text, 1);
  }, 'https://fixture.invalid', 'fixture', { max_tokens: 32768 }, new AbortController().signal, phase => phases.push(phase));
  assert.equal(result.reasoning_content, '内部思考，不应泄露');
  assert.deepEqual(result.tool_calls, [{ id: 'call-real', type: 'function', function: { name: 'apply_scene', arguments: '{"operations":[],"reply":"你好"}' } }]);
  assert.deepEqual([...new Set(phases)], ['thinking', 'tool-input']);
});
test('missing DONE, duplicate tool IDs and incomplete call identifiers reject without returning partial tools', async () => {
  const broken = event({ choices: [{ delta: { content: '未完成' }, finish_reason: 'stop' }] });
  await assert.rejects(completeModel(async () => stream(broken), 'https://fixture.invalid', 'fixture', {}, new AbortController().signal), error => error instanceof ApiError && error.code === 'INVALID_PLAN');
  for (const calls of [[{ index: 0, function: { name: 'apply_scene', arguments: '{}' } }],
    [0, 1].map(index => ({ index, id: 'same-id', type: 'function', function: { name: 'apply_scene', arguments: '{}' } }))]) {
    const text = event({ choices: [{ delta: { tool_calls: calls }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n';
    await assert.rejects(completeModel(async () => stream(text), 'https://fixture.invalid', 'fixture', {}, new AbortController().signal), error => error instanceof ApiError && error.code === 'INVALID_PLAN');
  }
});
test('token truncation is a typed recoverable failure; network and HTTP are not budget failures', async () => {
  const text = event({ choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }) + 'data: [DONE]\n\n';
  await assert.rejects(completeModel(async () => stream(text), 'https://fixture.invalid', 'fixture', {}, new AbortController().signal), error => error instanceof CompletionBudgetError && error.kind === 'tokens');
  await assert.rejects(completeModel(async () => new Response('private body', { status: 401 }), 'https://fixture.invalid', 'fixture', {}, new AbortController().signal), error => error instanceof ApiError && error.code === 'PROVIDER_ACCESS' && !error.publicMessage.includes('private'));
});
test('JSON compatibility responses require an explicit complete finish reason just like SSE', async () => {
  const message = { tool_calls: [{ id: 'call-json', type: 'function', function: { name: 'apply_scene', arguments: '{}' } }] };
  for (const finish_reason of [undefined, null, 'length']) {
    await assert.rejects(completeModel(async () => Response.json({ choices: [{ message, finish_reason }] }), 'https://fixture.invalid', 'fixture', {}, new AbortController().signal),
      error => finish_reason === 'length' ? error instanceof CompletionBudgetError : error instanceof ApiError && error.code === 'INVALID_PLAN');
  }
});


function detailedToolCall() {
  const operations: SceneBatch['operations'] = [
    { op: 'define_group', group: { id: 'floating-art', name: '空中的彩色图案' } },
    { op: 'define_part', part: { id: 'art-cells', name: '彩色方块', role: 'detail', groupId: 'floating-art', origin: { x: 500, y: 200, z: -400 } } },
    { op: 'patch_cells', partId: 'art-cells', cells: Array.from({ length: 400 }, (_, i) => ({
      cell: { x: i % 20, y: 0, z: Math.floor(i / 20) }, color: i % 2 ? '#FF8844' : '#4488FF',
    })) },
  ];
  return { id: 'large-valid-tool', type: 'function' as const, function: { name: 'apply_scene', arguments: JSON.stringify({ operations, reply: '空中的彩色图案搭好了。' }) } };
}
test('normal token-sized SSE frames do not spend the generated-content budget on repeated protocol fields', async () => {
  const tool = detailedToolCall();
  const frame = (delta: unknown, finish_reason: string | null = null) => event({
    id: 'chatcmpl-fixture-stream-budget', object: 'chat.completion.chunk', created: 1_791_696_000,
    model: 'deepseek-flash', system_fingerprint: 'fixture-fingerprint', usage: null,
    choices: [{ index: 0, delta, finish_reason }],
  });
  const text = frame({ tool_calls: [{ index: 0, ...tool, function: { name: tool.function.name, arguments: '' } }] })
    + Array.from(tool.function.arguments, character => frame({ tool_calls: [{ index: 0, function: { arguments: character } }] })).join('')
    + frame({}, 'tool_calls') + 'data: [DONE]\n\n';
  assert.ok(Buffer.byteLength(text) > 4_194_304);
  assert.ok(Buffer.byteLength(tool.function.arguments) < 32_768);
  const result = await completeModel(async () => stream(text, 4096), 'https://fixture.invalid', 'fixture', { max_tokens: 32768 }, new AbortController().signal);
  assert.deepEqual(result.tool_calls, [tool]);
  const args = JSON.parse(result.tool_calls![0].function.arguments) as { operations: SceneBatch['operations'] };
  const engine = new VoxelEngine();
  assert.equal(engine.executeBatch({ protocolVersion: 1, baseRevision: 0, operations: args.operations }, 'fragmented').snapshot.voxels.length, 400);
});
for (const format of ['sse', 'json'] as const) test(`valid tool arguments above 12000 characters parse and execute unchanged through ${format}`, async () => {
  const tool = detailedToolCall();
  assert.ok(tool.function.arguments.length > 12_000);
  const engine = new VoxelEngine();
  const response = format === 'json'
    ? Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [tool] } }] })
    : stream(event({ choices: [{ delta: { tool_calls: [{ index: 0, ...tool }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n', 1024);
  const result = await completeModel(async () => response, 'https://fixture.invalid', 'fixture', { max_tokens: 32768 }, new AbortController().signal);
  assert.deepEqual(result.tool_calls, [tool]);
  const args = JSON.parse(result.tool_calls![0].function.arguments) as { operations: SceneBatch['operations'] };
  const after = engine.executeBatch({ protocolVersion: 1, baseRevision: engine.snapshot().revision, operations: args.operations }, `large-${format}`).snapshot;
  assert.equal(after.revision, 1); assert.equal(after.groups!.length, 1); assert.equal(after.parts.length, 1); assert.equal(after.voxels.length, 400);
  assert.ok(after.voxels.every(voxel => voxel.cell.y === 200 && voxel.cell.x >= 500 && voxel.cell.x < 520 && voxel.cell.z >= -400 && voxel.cell.z < -380));
  assert.equal(after.voxels.filter(voxel => voxel.color === '#FF8844').length, 200);
});
for (const format of ['sse', 'json'] as const) test(`the 4 MiB decoded-content byte limit still rejects ${format} before any partial tool is executable`, async () => {
  const tool = detailedToolCall();
  // Multi-byte text proves the bound measures received bytes, not JavaScript character count.
  const reasoning = '水'.repeat(Math.ceil(4_194_304 / 3));
  const text = format === 'json'
    ? JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [tool], reasoning_content: reasoning } }] })
    : event({ choices: [{ delta: { tool_calls: [{ index: 0, ...tool }] }, finish_reason: null }] })
      + event({ choices: [{ delta: { reasoning_content: reasoning }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n';
  assert.ok(text.length < 4_194_304); assert.ok(Buffer.byteLength(text) > 4_194_304);
  const response = format === 'json' ? new Response(text, { headers: { 'content-type': 'application/json' } }) : stream(text, 65_536);
  const engine = new VoxelEngine(); let executed = false;
  await assert.rejects(completeModel(async () => response, 'https://fixture.invalid', 'fixture', { max_tokens: 32768 }, new AbortController().signal).then(result => {
    const args = JSON.parse(result.tool_calls![0].function.arguments) as { operations: SceneBatch['operations'] };
    engine.executeBatch({ protocolVersion: 1, baseRevision: engine.snapshot().revision, operations: args.operations }, 'must-not-execute'); executed = true;
  }), error => error instanceof CompletionBudgetError && error.kind === 'content' && error.limit === 4_194_304 && error.observed! > error.limit);
  assert.equal(executed, false); assert.equal(engine.snapshot().revision, 0); assert.equal(engine.snapshot().voxels.length, 0);
});

for (const format of ['sse', 'json'] as const) test(`an unterminated ${format} record is bounded and releases its reader`, async () => {
  let cancelled = false, pulls = 0;
  const chunk = new TextEncoder().encode(' '.repeat(65_536));
  const source = new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(completeModel(async () => new Response(source, { headers: { 'content-type': format === 'json' ? 'application/json' : 'text/event-stream' } }),
    'https://fixture.invalid', 'fixture', { max_tokens: 32768 }, new AbortController().signal),
  error => error instanceof CompletionBudgetError && error.kind === 'frame' && error.limit === 8 * 1024 * 1024 && error.observed! > error.limit);
  assert.equal(cancelled, true); assert.equal(source.locked, false); assert.ok(pulls <= 130);
});

test('unbounded SSE keepalives stop at the transport guard even when they contain no model output', async () => {
  let cancelled = false, pulls = 0;
  const chunk = new TextEncoder().encode(`:${' '.repeat(65_533)}\n\n`);
  const source = new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(completeModel(async () => new Response(source, { headers: { 'content-type': 'text/event-stream' } }),
    'https://fixture.invalid', 'fixture', { max_tokens: 32768 }, new AbortController().signal),
  error => error instanceof CompletionBudgetError && error.kind === 'transport' && error.limit === 64 * 1024 * 1024 && error.observed! > error.limit);
  assert.equal(cancelled, true); assert.equal(source.locked, false); assert.ok(pulls <= 1026);
});

test('cancelling a response releases the stream without exposing partially accumulated tools', async () => {
  const controller = new AbortController(); let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    pull(stream) {
      stream.enqueue(new TextEncoder().encode(event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'partial', type: 'function', function: { name: 'apply_scene', arguments: '{' } }] }, finish_reason: null }] })));
      controller.abort();
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(completeModel(async () => new Response(source, { headers: { 'content-type': 'text/event-stream' } }),
    'https://fixture.invalid', 'fixture', { max_tokens: 32768 }, controller.signal), error => error instanceof ApiError && error.code === 'CANCELLED');
  assert.equal(cancelled, true); assert.equal(source.locked, false);
});
