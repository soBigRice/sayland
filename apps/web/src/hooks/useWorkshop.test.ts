import test from 'node:test';
import assert from 'node:assert/strict';
import { VoxelEngine } from '../../../../packages/scene/src/index.ts';
import { snapshotDigest, type ChatRequest, type ScenePlan } from '../../../../packages/protocol/src/index.ts';
import type { DebugTurn } from '../components/DebugPanel.tsx';
import type { ChatMessage } from '../components/SceneShell.tsx';
import { acknowledge, type ChatHandlers } from '../lib/api.ts';
import { appliedTurnEvidence, appendTurnProgress, boundedChatMessages, conversationContext, projectSchema, restoreChatMessages, retryPromptForMessage, runWorkshopTurn } from './useWorkshop.ts';

const failed = (id: string, text: string): ChatMessage[] => [
  { id, role: 'user', text }, { id: `${id}-answer`, role: 'assistant', text: '这次计划没有完成。', status: 'error' },
];

test('after a JSON reload, each old error retries its own preceding user request rather than the last prompt', () => {
  const persisted = JSON.parse(JSON.stringify([
    ...failed('first-turn', '在小岛上加一条小河'), ...failed('second-turn', '把屋顶改成蓝色'),
    { id: 'latest-turn', role: 'user', text: '最新一句并不是重试内容' },
    { id: 'latest-turn-answer', role: 'assistant', text: '你好。' },
  ])) as ChatMessage[];
  const restored = restoreChatMessages(persisted, new Set());
  assert.equal(retryPromptForMessage(restored, 'first-turn-answer'), '在小岛上加一条小河');
  assert.equal(retryPromptForMessage(restored, 'second-turn-answer'), '把屋顶改成蓝色');
  assert.equal(retryPromptForMessage(restored, 'latest-turn-answer'), null);
  assert.equal(persisted.some(message => 'retryable' in message), false);
});

test('the saved engine request record prevents replay of an applied turn in a new page session regardless of reply wording', () => {
  const engine = new VoxelEngine();
  engine.executeBatch({ protocolVersion: 1, baseRevision: 0, operations: [{ op: 'put', cell: { x: 0, y: 0, z: 0 }, color: '#AA6633' }] }, 'applied-turn');
  const savedEngine = JSON.parse(JSON.stringify(engine.serialize()));
  const restoredEngine = VoxelEngine.restore(savedEngine), before = restoredEngine.snapshot();
  const appliedIds = new Set(restoredEngine.serialize().requests.map(([id]) => id));
  const messages = restoreChatMessages([...failed('applied-turn', '再添一个方块'), ...failed('failed-turn', '把它改成蓝色')], appliedIds);
  assert.equal(retryPromptForMessage(messages, 'applied-turn-answer'), null);
  assert.equal(messages[1].retryable, false);
  assert.equal(retryPromptForMessage(messages, 'failed-turn-answer'), '把它改成蓝色');
  assert.deepEqual(restoredEngine.snapshot(), before);
});

test('a full bounded request cache cannot prove an absent old turn was never applied', () => {
  const messages = restoreChatMessages(failed('possibly-evicted', '保留这句，允许用户重新编辑'), new Set(Array.from({ length: 64 }, (_, index) => `cached-${index}`)));
  assert.equal(retryPromptForMessage(messages, 'possibly-evicted-answer'), null);
  assert.equal(messages[1].retryable, false);
  assert.equal(messages[0].text, '保留这句，允许用户重新编辑');
});

test('interrupted, orphaned and mismatched message pairs do not offer an unverified retry', () => {
  const messages: ChatMessage[] = [
    { id: 'orphan-answer', role: 'assistant', text: '错误', status: 'error' },
    { id: 'pending-turn', role: 'user', text: '正在搭的东西' },
    { id: 'pending-turn-answer', role: 'assistant', text: '搭建中', status: 'pending' },
    { id: 'wrong-pair-answer', role: 'assistant', text: '错误', status: 'error' },
  ];
  const restored = restoreChatMessages(messages, new Set());
  for (const id of ['orphan-answer', 'pending-turn-answer', 'wrong-pair-answer']) assert.equal(retryPromptForMessage(restored, id), null);
  assert.equal(restored[2].status, 'error');
});

test('only a known unapplied current-page failure is eligible; missing IDs and applied errors are rejected', () => {
  const messages = failed('current-turn', '  原句需要保留  ');
  assert.equal(retryPromptForMessage(messages, 'current-turn-answer'), null);
  messages[1].retryable = true;
  assert.equal(retryPromptForMessage(messages, 'current-turn-answer'), '原句需要保留');
  messages[1].retryable = false;
  assert.equal(retryPromptForMessage(messages, 'current-turn-answer'), null);
  assert.equal(retryPromptForMessage(messages, 'missing-answer'), null);
});

function plan(id: string, number: number): ScenePlan {
  return { requestId: id, batchId: `${id}-b${number}`, reply: `第${number}批完成`, batch: { protocolVersion: 1, baseRevision: number - 1, operations: number === 1 ? [
    { op: 'define_group', group: { id: 'object', name: '新物件' } },
    { op: 'define_part', part: { id: 'body', name: '主体', role: 'detail', groupId: 'object', origin: { x: 0, y: 0, z: 0 } } },
    { op: 'fill_shape', partId: 'body', shape: { kind: 'box', offset: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } }, color: '#AA6633' },
  ] : [{ op: 'patch_cells', partId: 'body', cells: [{ cell: { x: number - 1, y: 0, z: 0 }, color: '#AA6633' }] }] } };
}
function turnFixture(id = 'multi-turn') {
  const engine = new VoxelEngine(), controller = new AbortController(); let current = true;
  const answers: Array<{ text: string; status?: string; retryable: boolean }> = [], states: Partial<DebugTurn>[] = [], visible: number[] = [], notices: string[] = [];
  const progress: Array<{ id: string; text: string }> = [];
  const completions: number[] = [];
  let messages: ChatMessage[] = [{ id, role: 'user', text: '分几步搭一个自由物件' }, { id: `${id}-answer`, role: 'assistant', text: '正在想办法', status: 'pending' }];
  const callbacks: Parameters<typeof runWorkshopTurn>[3] = {
    isCurrent: () => current,
    onStatus(text) { notices.push(text); }, onPlan() {},
    onProgress(message) { progress.push(message); messages = appendTurnProgress(messages, `${id}-answer`, message); },
    onCommit() { visible.push(engine.snapshot().voxels.length); },
    onSceneComplete() { completions.push(engine.snapshot().revision); },
    onAnswer(text, status, retryable) { answers.push({ text, status, retryable }); messages = messages.map(message => message.id === `${id}-answer` ? { ...message, text, status, retryable } : message); },
    onTurn(patch) { states.push(patch); }, onError(text) { notices.push(text); },
  };
  const input: ChatRequest = { requestId: id, text: '分几步搭一个自由物件', snapshot: engine.snapshot(), messages: [] };
  return { engine, controller, callbacks, input, answers, states, visible, notices, progress, completions, getMessages: () => messages, setCurrent(value: boolean) { current = value; } };
}
const fixtureAck: typeof acknowledge = async (_requestId, _revision, _digest, _signal, batchId) => ({ reply: `批次 ${batchId} 已确认` });

test('two batches display immediately, wait for a final reply, and share one persisted undo step', async () => {
  const fixture = turnFixture(), { input, engine, controller, callbacks, visible, answers } = fixture;
  let acknowledgements = 0, captured!: ChatHandlers;
  const outcome = await runWorkshopTurn(input, engine, controller.signal, callbacks, {
    async chat(_input, _signal, handlers) {
      captured = handlers;
      await handlers.onPlan(plan(input.requestId, 1));
      assert.deepEqual(visible, [1]); assert.equal(answers.at(-1)?.status, 'pending');
      await handlers.onPlan(plan(input.requestId, 2));
      assert.deepEqual(visible, [1, 2]); assert.equal(answers.at(-1)?.status, 'pending');
      assert.equal(engine.serialize().past.length, 1);
      handlers.onReply('整个物件完成啦。');
      assert.equal(answers.at(-1)?.status, 'pending');
      assert.deepEqual(fixture.completions, [], 'no recentering during batches or before done');
    },
    async acknowledge(id, revision, digest, signal, batchId) {
      acknowledgements++;
      assert.equal(id, input.requestId); assert.equal(revision, acknowledgements);
      assert.equal(batchId, `${input.requestId}-b${acknowledgements}`);
      assert.equal(digest, await snapshotDigest(engine.snapshot()));
      return fixtureAck(id, revision, digest, signal, batchId);
    },
  });
  assert.deepEqual(outcome, { completed: true, reply: '整个物件完成啦。', appliedBatches: 2 });
  assert.deepEqual(fixture.completions, [2], 'one recenter event for the entire successful turn');
  assert.equal(answers.at(-1)?.status, undefined);
  const answerCount = answers.length;
  captured.onReply('已结束回合的迟到回复'); await captured.onPlan(plan(input.requestId, 3));
  assert.equal(answers.length, answerCount); assert.equal(engine.snapshot().voxels.length, 2);
  assert.deepEqual(fixture.completions, [2]);
  const restored = VoxelEngine.restore(JSON.parse(JSON.stringify(engine.serialize())));
  assert.equal(restored.snapshot().voxels.length, 2);
  assert.equal(restored.undo().snapshot.voxels.length, 0); assert.equal(restored.canUndo, false);
  assert.equal(restored.redo().snapshot.voxels.length, 2);
});

test('an invalid batch ID fails before a local commit and remains eligible for retry', async () => {
  const fixture = turnFixture(), { input, engine, controller, callbacks, answers } = fixture;
  const outcome = await runWorkshopTurn(input, engine, controller.signal, callbacks, {
    async chat(_input, _signal, handlers) { await handlers.onPlan({ ...plan(input.requestId, 1), batchId: '' }); },
    acknowledge: fixtureAck,
  });
  assert.equal(outcome.completed, false); assert.deepEqual(fixture.completions, []); assert.equal(engine.snapshot().voxels.length, 0);
  assert.equal(answers.at(-1)?.retryable, true); assert.match(answers.at(-1)!.text, /编号无效/);
});

test('later failure keeps committed batches without claiming completion or offering a whole-request retry', async () => {
  const fixture = turnFixture(), { input, engine, controller, callbacks, answers, states } = fixture;
  const outcome = await runWorkshopTurn(input, engine, controller.signal, callbacks, {
    async chat(_input, _signal, handlers) {
      await handlers.onPlan(plan(input.requestId, 1)); await handlers.onPlan(plan(input.requestId, 2));
      throw new Error('后续部分生成失败');
    }, acknowledge: fixtureAck,
  });
  assert.equal(outcome.completed, false); assert.deepEqual(fixture.completions, []); assert.equal(outcome.appliedBatches, 2);
  assert.equal(answers.at(-1)?.status, 'error'); assert.equal(answers.at(-1)?.retryable, false);
  assert.match(answers.at(-1)!.text, /后续部分生成失败.*保留.*一次撤销/);
  assert.equal(states.at(-1)?.status, 'partial-failed');
  assert.equal(engine.snapshot().voxels.length, 2); assert.equal(engine.undo().snapshot.voxels.length, 0);
});

test('stopping after one batch retains it, rejects queued work and never returns a speakable completion', async () => {
  const fixture = turnFixture(), { input, engine, controller, callbacks, answers, states } = fixture;
  const outcome = await runWorkshopTurn(input, engine, controller.signal, callbacks, {
    async chat(_input, signal, handlers) {
      await handlers.onPlan(plan(input.requestId, 1)); controller.abort();
      handlers.onStatus('迟到状态'); handlers.onReply('迟到成功'); await handlers.onPlan(plan(input.requestId, 2));
      throw signal.reason;
    }, acknowledge: fixtureAck,
  });
  assert.deepEqual(outcome, { completed: false, reply: '', appliedBatches: 1 });
  assert.deepEqual(fixture.completions, []);
  assert.match(answers.at(-1)!.text, /已停下来.*保留/); assert.equal(states.at(-1)?.status, 'partial-cancelled');
  assert.equal(engine.snapshot().voxels.length, 1); assert.equal(engine.undo().snapshot.voxels.length, 0);
});

test('cancelled ACK and old stream callbacks cannot edit or update the next active turn', async () => {
  const fixture = turnFixture(), { input, engine, controller, callbacks, answers, states, notices } = fixture;
  let handlers!: ChatHandlers, finishAck!: (value: { reply: string }) => void, ackStarted!: () => void;
  const started = new Promise<void>(resolve => { ackStarted = resolve; });
  const receipt = new Promise<{ reply: string }>(resolve => { finishAck = resolve; });
  const pending = runWorkshopTurn(input, engine, controller.signal, callbacks, {
    async chat(_input, _signal, value) { handlers = value; await handlers.onPlan(plan(input.requestId, 1)); handlers.onReply('旧回合迟到回复'); },
    async acknowledge() { ackStarted(); return receipt; },
  });
  await started;
  controller.abort(); fixture.setCurrent(false);
  engine.executeBatch({ protocolVersion: 1, baseRevision: engine.snapshot().revision, operations: [{ op: 'put', cell: { x: 10, y: 0, z: 0 }, color: '#55AA77' }] }, 'next-turn-b1', 'next-turn');
  const counts = [answers.length, states.length, notices.length];
  handlers.onStatus('不能覆盖新回合'); handlers.onReply('不能提前朗读'); await handlers.onPlan(plan(input.requestId, 2));
  finishAck({ reply: '旧批次确认成功' });
  const outcome = await pending;
  assert.equal(outcome.completed, false); assert.deepEqual(fixture.completions, []);
  assert.deepEqual([answers.length, states.length, notices.length], counts);
  assert.deepEqual(engine.snapshot().voxels.map(voxel => voxel.cell.x).sort((a, b) => a - b), [0, 10]);
});

test('neither new nor legacy receipts turn an incomplete stream into a speakable final reply', async () => {
  for (const legacy of [false, true]) {
    const fixture = turnFixture(), { input, engine, controller, callbacks, answers } = fixture;
    const outcome = await runWorkshopTurn(input, engine, controller.signal, callbacks, {
      async chat(_input, _signal, handlers) {
        const batch = plan(input.requestId, 1); if (legacy) delete batch.batchId;
        await handlers.onPlan(batch); handlers.onReply('流中的完成文字');
        throw new Error('缺少 done，流连接中断');
      }, acknowledge: fixtureAck,
    });
    assert.equal(outcome.completed, false); assert.deepEqual(fixture.completions, []); assert.equal(outcome.reply, '');
    assert.equal(engine.snapshot().voxels.length, 1);
    assert.equal(answers.at(-1)?.status, 'error');
    assert.equal(fixture.progress.length, 1, 'the acknowledged batch reply remains visible despite an incomplete final response');
  }
});

test('legacy single-batch receipt remains compatible when the stream finishes normally', async () => {
  const fixture = turnFixture();
  const result = await runWorkshopTurn(fixture.input, fixture.engine, fixture.controller.signal, fixture.callbacks, {
    async chat(_input, _signal, handlers) { const batch = plan(fixture.input.requestId, 1); delete batch.batchId; await handlers.onPlan(batch); },
    acknowledge: fixtureAck,
  });
  assert.equal(result.completed, true); assert.equal(result.reply, fixture.progress[0].text);
  assert.equal(fixture.answers.at(-1)?.status, undefined);
});

test('two receipt replies and ordinary commentary survive generic statuses; final text appears only after done', async () => {
  const fixture = turnFixture();
  const result = await runWorkshopTurn(fixture.input, fixture.engine, fixture.controller.signal, fixture.callbacks, {
    async chat(_input, _signal, handlers) {
      handlers.onCommentary?.({ messageId: 'ordinary-1', text: '我先搭主体，再添蓝色细节。' });
      await handlers.onPlan(plan(fixture.input.requestId, 1));
      handlers.onStatus('正在想下一步…');
      assert.deepEqual(fixture.getMessages().filter(message => message.kind === 'progress').map(message => message.text), [
        '我先搭主体，再添蓝色细节。', `批次 ${fixture.input.requestId}-b1 已确认`,
      ]);
      assert.equal(fixture.getMessages().at(-1)?.text, '正在想下一步…');
      await handlers.onPlan(plan(fixture.input.requestId, 2));
      handlers.onStatus('正在整理回应…'); handlers.onReply('红蓝两部分都完成了。');
      assert.equal(fixture.getMessages().at(-1)?.status, 'pending');
      assert.equal(fixture.getMessages().some(message => message.text === '红蓝两部分都完成了。'), false);
    }, acknowledge: fixtureAck,
  });
  assert.equal(result.completed, true);
  assert.deepEqual(fixture.getMessages().map(message => message.text), [
    fixture.input.text, '我先搭主体，再添蓝色细节。', `批次 ${fixture.input.requestId}-b1 已确认`,
    `批次 ${fixture.input.requestId}-b2 已确认`, '红蓝两部分都完成了。',
  ]);
  assert.equal(fixture.getMessages().at(-1)?.kind, undefined);
});

test('replayed commentary and batch receipts produce only one bubble per identity', async () => {
  const fixture = turnFixture(); let acknowledgements = 0;
  await runWorkshopTurn(fixture.input, fixture.engine, fixture.controller.signal, fixture.callbacks, {
    async chat(_input, _signal, handlers) {
      const commentary = { messageId: 'same-message', text: '让我把这部分接起来。' };
      handlers.onCommentary?.(commentary); handlers.onCommentary?.(commentary);
      const batch = plan(fixture.input.requestId, 1);
      await handlers.onPlan(batch); await handlers.onPlan(batch); handlers.onReply('接好了。');
    }, async acknowledge(...args) { acknowledgements++; return fixtureAck(...args); },
  });
  assert.equal(acknowledgements, 1); assert.equal(fixture.progress.length, 2);
  assert.equal(fixture.getMessages().filter(message => message.kind === 'progress').length, 2);
});

test('failure or stop retains earlier bubbles, ignores late commentary and offers no speakable completion', async () => {
  for (const stop of [false, true]) {
    const fixture = turnFixture(); let captured!: ChatHandlers;
    const result = await runWorkshopTurn(fixture.input, fixture.engine, fixture.controller.signal, fixture.callbacks, {
      async chat(_input, signal, handlers) {
        captured = handlers;
        handlers.onCommentary?.({ messageId: 'first-message', text: '先把红色主体搭起来。' });
        await handlers.onPlan(plan(fixture.input.requestId, 1));
        if (stop) { fixture.controller.abort(); handlers.onCommentary?.({ messageId: 'cancelled-message', text: '不能显示的迟到文字' }); throw signal.reason; }
        throw new Error('下一批没有生成完成');
      }, acknowledge: fixtureAck,
    });
    captured.onCommentary?.({ messageId: 'finished-message', text: '不能串回合' });
    assert.equal(result.completed, false); assert.equal(result.reply, '');
    assert.equal(fixture.progress.length, 2); assert.equal(fixture.engine.snapshot().voxels.length, 1);
    assert.equal(fixture.getMessages().some(message => /不能显示|不能串/.test(message.text)), false);
  }
});

test('an unconfirmed local commit never displays its planned success as a receipt bubble', async () => {
  const fixture = turnFixture();
  const result = await runWorkshopTurn(fixture.input, fixture.engine, fixture.controller.signal, fixture.callbacks, {
    async chat(_input, _signal, handlers) { handlers.onCommentary?.({ messageId: 'proposal', text: '准备加上第一块。' }); await handlers.onPlan(plan(fixture.input.requestId, 1)); },
    async acknowledge() { throw new Error('确认请求未完成'); },
  });
  assert.equal(result.completed, false); assert.equal(result.reply, '');
  assert.deepEqual(fixture.progress.map(message => message.text), ['准备加上第一块。']);
  assert.equal(fixture.getMessages().some(message => message.text === '第1批完成'), false);
  assert.equal(fixture.states.at(-1)?.status, 'applied-unconfirmed');
});

test('version 1 projects restore intermediate bubbles, but model context uses only ordinary settled messages', () => {
  const messages: ChatMessage[] = [
    { id: 'user', role: 'user', text: '搭一个物件' },
    { id: 'opaque-id', role: 'assistant', text: '主体已搭好', kind: 'progress' },
    { id: 'user-answer', role: 'assistant', text: '仍在继续', status: 'pending' },
    { id: 'receipt-looking-name', role: 'assistant', text: '这是普通已结束聊天，不凭ID误判' },
  ];
  const persisted = projectSchema.parse(JSON.parse(JSON.stringify({ format: 'sayland-project', version: 1, engine: new VoxelEngine().serialize(), messages, speakerEnabled: false })));
  const restored = restoreChatMessages(persisted.messages, new Set());
  assert.equal(restored[1].text, '主体已搭好'); assert.equal(restored[1].kind, 'progress'); assert.equal(restored[1].status, undefined);
  assert.equal(restored[2].status, 'error');
  assert.deepEqual(conversationContext(restored), [{ role: 'user', content: '搭一个物件' }, { role: 'assistant', content: '这是普通已结束聊天，不凭ID误判' }]);
  assert.equal(projectSchema.parse({ ...persisted, messages: failed('old', '旧版存档没有kind') }).version, 1);
});

test('long progress histories stay within 100 messages without losing the current retry pair', () => {
  let messages: ChatMessage[] = Array.from({ length: 10 }, (_, index) => [
    { id: `old-${index}`, role: 'user' as const, text: '旧句子' }, { id: `old-${index}-answer`, role: 'assistant' as const, text: '旧回复' },
  ]).flat();
  messages = boundedChatMessages([...messages, ...failed('current', '原句必须保留')]);
  for (let index = 0; index < 100; index++) messages = appendTurnProgress(messages, 'current-answer', { id: `opaque-${index}`, text: '一条中途对话' });
  assert.equal(messages.filter(message => message.kind === 'progress').length, 88); assert.ok(messages.length <= 100);
  assert.equal(messages[0].role, 'user');
  const current = messages.findIndex(message => message.id === 'current');
  assert.ok(current >= 0); assert.equal(messages.at(-1)?.id, 'current-answer');
  const restored = restoreChatMessages(messages, new Set());
  assert.equal(retryPromptForMessage(restored, 'current-answer'), '原句必须保留');
  assert.ok(conversationContext(restored).length <= 10);
});

test('lost batch ACK recovery queries receipts and never executes the geometry again', async (t) => {
  const fixture = turnFixture(), { input, engine, controller, callbacks, answers } = fixture;
  let post: { batchId: string; revision: number; digest: string } | undefined, calls = 0;
  t.mock.method(globalThis, 'fetch', async (_path: string, init: RequestInit) => {
    calls++;
    if (init.method === 'POST') { post = JSON.parse(String(init.body)); throw new TypeError('ACK 已提交但响应丢失'); }
    return Response.json({ requestId: input.requestId, status: 'generating', receipts: [{ requestId: input.requestId, ...post, status: 'committed', reply: '第一批已提交' }] });
  });
  const outcome = await runWorkshopTurn(input, engine, controller.signal, callbacks, {
    async chat(_input, _signal, handlers) {
      await handlers.onPlan(plan(input.requestId, 1));
      assert.equal(answers.at(-1)?.status, 'pending'); handlers.onReply('整轮已经完成');
    }, acknowledge,
  });
  assert.equal(outcome.completed, true); assert.equal(calls, 2);
  assert.equal(engine.snapshot().voxels.length, 1); assert.equal(engine.serialize().requests.length, 1);
});

test('a replayed stream batch is idempotent and does not count or acknowledge twice', async () => {
  const fixture = turnFixture(), { input, engine, controller, callbacks } = fixture; let calls = 0;
  const outcome = await runWorkshopTurn(input, engine, controller.signal, callbacks, {
    async chat(_input, _signal, handlers) { const batch = plan(input.requestId, 1); await handlers.onPlan(batch); await handlers.onPlan(batch); handlers.onReply('完成'); },
    async acknowledge(...args) { calls++; return fixtureAck(...args); },
  });
  assert.equal(outcome.appliedBatches, 1); assert.equal(calls, 1); assert.equal(engine.snapshot().voxels.length, 1);
});

test('partial batch commits remain non-retryable after JSON reload using historyGroup rather than batch ID prefixes', () => {
  const engine = new VoxelEngine(), requestId = 'partially-applied';
  engine.executeBatch(plan(requestId, 1).batch, 'opaque-batch-identifier', requestId);
  const restored = VoxelEngine.restore(JSON.parse(JSON.stringify(engine.serialize())));
  const evidence = appliedTurnEvidence(restored.serialize());
  assert.equal(evidence.ids.has(requestId), true);
  const messages = restoreChatMessages([...failed(requestId, '已经搭好了一部分'), ...failed('other-error', '尚未开始的另一句')], evidence);
  assert.equal(retryPromptForMessage(messages, `${requestId}-answer`), null);
  assert.equal(retryPromptForMessage(messages, 'other-error-answer'), '尚未开始的另一句');
  restored.undo();
  assert.equal(appliedTurnEvidence(restored.serialize()).ids.has(requestId), true);
});

test('64 batch records in one turn still make absent older turn evidence incomplete', () => {
  const engine = new VoxelEngine();
  for (let index = 0; index < 64; index++) engine.executeBatch({ protocolVersion: 1, baseRevision: engine.snapshot().revision, operations: [{ op: 'put', cell: { x: index, y: 0, z: 0 }, color: '#AA6633' }] }, `batch-${index}`, 'one-turn');
  const evidence = appliedTurnEvidence(engine.serialize());
  assert.equal(evidence.complete, false);
  const messages = restoreChatMessages(failed('evicted-old-turn', '不要把可能已提交的请求重做'), evidence);
  assert.equal(retryPromptForMessage(messages, 'evicted-old-turn-answer'), null);
});


test('a successful conversation without scene edits never requests camera framing', async () => {
  const fixture = turnFixture();
  const outcome = await runWorkshopTurn(fixture.input, fixture.engine, fixture.controller.signal, fixture.callbacks, {
    async chat(_input, _signal, handlers) { handlers.onReply('你好呀。'); }, acknowledge: fixtureAck,
  });
  assert.equal(outcome.completed, true); assert.equal(outcome.appliedBatches, 0);
  assert.deepEqual(fixture.completions, []);
});
