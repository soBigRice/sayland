import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { VoxelEngine } from '../../../packages/scene/src/index.ts';
import { snapshotDigest, type ChatRequest, type SceneBatch, type ScenePlan } from '../../../packages/protocol/src/index.ts';
import { createProviders, type Providers } from '../src/providers.ts';
import { createApp } from '../src/app.ts';
import { ApiError } from '../src/errors.ts';
import { MODEL_REASONING_EFFORT, MODEL_THINKING_MODE } from '../src/deepseek-stream.ts';
import type { ApiConfig } from '../src/config.ts';

const config: ApiConfig = { port: 4311, allowedOrigins: [], deepseek: { apiKey: 'fixture', baseUrl: 'https://fixture.invalid', model: 'deepseek-flash' },
  mimo: { apiKey: 'fixture', baseUrl: 'https://fixture.invalid', asrModel: 'fixture', ttsModel: 'fixture', voice: 'fixture' } };
const headers = { host: '127.0.0.1:4311', 'x-sayland-session': 'fixture-interaction-session' };
const input: ChatRequest = { requestId: 'fixture-interaction', text: '搭一个蓝方块', snapshot: new VoxelEngine().snapshot(), messages: [] };
const operations: SceneBatch['operations'] = [
  { op: 'define_group', group: { id: 'box', name: '方块' } },
  { op: 'define_part', part: { id: 'body', name: '主体', role: 'other', groupId: 'box', origin: { x: 500, y: 200, z: -400 } } },
  { op: 'patch_cells', partId: 'body', cells: [{ cell: { x: 0, y: 0, z: 0 }, color: '#4488FF' }] },
];
const batchReply = '这一块搭好了。', finalReply = '蓝色方块完成啦。', commentary = '我先搭一块蓝色的主体。', reasoning = 'PRIVATE_REASONING_NOT_FOR_UI';
const tool = (content = commentary, finish_reason = 'tool_calls', ops = operations) => ({ choices: [{ finish_reason, message: {
  content, reasoning_content: reasoning, tool_calls: [{ id: 'model-tool', type: 'function', function: { name: 'apply_scene', arguments: JSON.stringify({ operations: ops, reply: batchReply }) } }],
} }] });
const final = (content = finalReply) => ({ choices: [{ finish_reason: 'stop', message: { content, reasoning_content: reasoning } }] });
const intent = (kind: 'edit' | 'chat' | 'clarify') => ({ choices: [{ finish_reason: 'tool_calls', message: { content: null,
  tool_calls: [{ id: 'intent-tool', type: 'function', function: { name: 'classify_intent', arguments: JSON.stringify({ kind, reply: kind === 'edit' ? '' : '分类器的替代回答' }) } }],
} }] });
function events(body: string): Array<{ event: string; data: Record<string, unknown> }> {
  return body.trim().split('\n\n').filter(Boolean).map(part => ({ event: part.split('\n')[0].slice(7), data: JSON.parse(part.split('\n')[1].slice(6)) }));
}
async function waitPlan(app: ReturnType<typeof createApp>): Promise<ScenePlan> {
  for (let i = 0; i < 100; i++) {
    const state = (await app.inject({ method: 'GET', url: `/api/turns/${input.requestId}`, headers })).json();
    if (state.plan) return state.plan;
    assert.ok(!['failed', 'cancelled', 'replied'].includes(state.status), JSON.stringify(state)); await setImmediate();
  }
  throw new Error('Expected a pending batch');
}

test('complete ordinary tool commentary precedes a batch, receipt reply waits for ACK, and only final reply approves speech', async t => {
  const modelParameters: Array<{ thinking: unknown; reasoning_effort: unknown }> = [];
  let calls = 0;
  const live = createProviders(config, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); modelParameters.push({ thinking: body.thinking, reasoning_effort: body.reasoning_effort });
    return Response.json(++calls === 1 ? tool(`  ${commentary}  `) : final());
  });
  const app = createApp(config, { providers: { ...live, synthesize: async () => Buffer.from('fixture-audio') } }); t.after(() => app.close());
  const health = (await app.inject({ method: 'GET', url: '/api/health', headers })).json();
  assert.equal(health.thinking, MODEL_THINKING_MODE); assert.equal(health.reasoningEffort, MODEL_REASONING_EFFORT);
  const response = app.inject({ method: 'POST', url: '/api/chat', headers, payload: input }).then(value => value);
  const plan = await waitPlan(app);
  for (const text of [commentary, batchReply, finalReply]) assert.equal((await app.inject({ method: 'POST', url: '/api/speech/synthesize', headers, payload: { text } })).statusCode, 409);
  const snapshot = VoxelEngine.fromSnapshot(input.snapshot).executeBatch(plan.batch, plan.batchId!, input.requestId).snapshot;
  const receipt = await app.inject({ method: 'POST', url: `/api/turns/${input.requestId}/ack`, headers,
    payload: { batchId: plan.batchId, revision: snapshot.revision, digest: await snapshotDigest(snapshot) } });
  assert.equal(receipt.statusCode, 200); assert.equal(receipt.json().reply, batchReply);
  const finished = await response; const items = events(finished.body);
  assert.deepEqual(items.filter(item => item.event === 'commentary').map(item => item.data), [
    { requestId: input.requestId, messageId: `${input.requestId}-m1`, text: commentary },
  ]);
  assert.deepEqual(items.filter(item => ['commentary', 'plan', 'reply', 'done'].includes(item.event)).map(item => item.event), ['commentary', 'plan', 'reply', 'done']);
  assert.ok(!finished.body.includes(reasoning)); assert.equal(items.find(item => item.event === 'reply')!.data.reply, finalReply);
  for (const body of modelParameters) { assert.deepEqual(body.thinking, { type: health.thinking }); assert.equal(body.reasoning_effort, health.reasoningEffort); }
  for (const text of [commentary, batchReply]) assert.equal((await app.inject({ method: 'POST', url: '/api/speech/synthesize', headers, payload: { text } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/api/speech/synthesize', headers, payload: { text: finalReply } })).statusCode, 200);
});

test('cancel prevents a provider from sending late commentary or a final reply', async t => {
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const providers: Providers = {
    plan: async (_input, signal, options) => {
      options!.onCommentary!(commentary); started();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      options!.onCommentary!('迟到的文字不能出现'); return { reply: finalReply };
    }, transcribe: async () => '', synthesize: async () => Buffer.from('fixture'),
  };
  const app = createApp(config, { providers }); t.after(() => app.close());
  const response = app.inject({ method: 'POST', url: '/api/chat', headers, payload: input }).then(value => value);
  await ready; await app.inject({ method: 'POST', url: `/api/turns/${input.requestId}/cancel`, headers });
  const finished = await response;
  assert.equal(events(finished.body).filter(item => item.event === 'commentary').length, 1);
  assert.ok(!finished.body.includes('迟到的文字')); assert.ok(!finished.body.includes('event: reply'));
  assert.equal((await app.inject({ method: 'GET', url: `/api/turns/${input.requestId}`, headers })).json().status, 'cancelled');
});

test('ordinary intent commentary survives failed planning without exposing a batch completion or reasoning', async t => {
  const providers = createProviders(config, async () => Response.json(tool(commentary, 'tool_calls', [
    { op: 'paint_part', partId: 'missing', region: null, color: '#4488FF' },
  ])));
  const app = createApp(config, { providers }); t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/chat', headers, payload: input }); const items = events(response.body);
  assert.equal(items.filter(item => item.event === 'commentary').length, 3);
  assert.equal(new Set(items.filter(item => item.event === 'commentary').map(item => item.data.messageId)).size, 3);
  assert.equal(items.at(-1)!.event, 'error'); assert.ok(!items.some(item => ['plan', 'reply', 'done'].includes(item.event)));
  assert.ok(!response.body.includes(batchReply)); assert.ok(!response.body.includes(reasoning));
});

for (const kind of ['chat', 'clarify'] as const) test(`intent ${kind} preserves the main thinking answer and never emits rejected pure text as commentary`, async () => {
  let calls = 0; const commentaryItems: string[] = [];
  const mainReply = kind === 'chat' ? '我喜欢蓝色，也喜欢你挑的黄色。' : '你想改左边还是右边那座房子？';
  const providers = createProviders(config, async () => Response.json(++calls === 1 ? final(mainReply) : intent(kind)));
  const result = await providers.plan({ ...input, text: kind === 'chat' ? '你喜欢什么颜色？' : '把那座房子改成红色' }, new AbortController().signal, { onCommentary: text => commentaryItems.push(text) });
  assert.deepEqual(result, { reply: mainReply }); assert.equal(calls, 2); assert.deepEqual(commentaryItems, []);
});

test('an explicit edit still cannot complete with pure text after intent classification', async () => {
  let calls = 0; const commentaryItems: string[] = [];
  const providers = createProviders(config, async () => Response.json(++calls === 2 ? intent('edit') : final('我这就帮你搭。')));
  await assert.rejects(providers.plan(input, new AbortController().signal, { onCommentary: text => commentaryItems.push(text) }), error => error instanceof ApiError && error.code === 'PLAN_INCOMPLETE_PLAN');
  assert.equal(calls, 3); assert.deepEqual(commentaryItems, []);
});

test('truncated, unfinished, and cancelled model responses never emit ordinary content fragments', async () => {
  for (const mode of ['truncated', 'unfinished', 'cancelled'] as const) {
    const controller = new AbortController(); const commentaryItems: string[] = [];
    const providers = createProviders(config, async () => {
      if (mode === 'cancelled') { controller.abort(); return Response.json(tool()); }
      if (mode === 'truncated') return Response.json(tool(commentary, 'length'));
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: commentary, reasoning_content: reasoning }, finish_reason: 'stop' }] })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    });
    await assert.rejects(providers.plan(input, controller.signal, { onCommentary: text => commentaryItems.push(text) }));
    assert.deepEqual(commentaryItems, []);
  }
});

test('overlong commentary is omitted whole without truncating text or rejecting valid tools', async () => {
  for (const length of [600, 601]) {
    const commentaryItems: string[] = []; const text = '蓝'.repeat(length);
    const providers = createProviders(config, async () => Response.json(tool(text)));
    const result = await providers.plan(input, new AbortController().signal, { onCommentary: value => commentaryItems.push(value) });
    assert.ok(result.batch); assert.deepEqual(commentaryItems, length === 600 ? [text] : []);
    assert.equal(VoxelEngine.fromSnapshot(input.snapshot).executeBatch(result.batch, input.requestId).snapshot.voxels.length, 1);
  }
});
