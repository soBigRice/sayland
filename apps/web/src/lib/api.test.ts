import test from 'node:test';
import assert from 'node:assert/strict';
import { acknowledge, chat, jsonRequest, readTurnDiagnostics, synthesize } from './api.ts';
import type { ChatRequest, ScenePlan } from '../../../../packages/protocol/src/index.ts';

const requestId = 'fixture-turn-receipt';
const revision = 12;
const digest = 'a'.repeat(64);
const receipt = { requestId, status: 'committed', revision, reply: '小树已经种好啦！' };
const statePath = `/api/turns/${requestId}`;
const asJson = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('HTTP boundaries display nested API messages and retain flat message compatibility', async (t) => {
  t.mock.method(globalThis, 'fetch', async (path: string) => asJson(path === '/flat'
    ? { message: '旧格式的提示' }
    : { error: { code: 'FIXTURE_DENIED', message: '这次操作需要先确认作品。' } }, 409));
  await assert.rejects(jsonRequest('/nested'), { message: '这次操作需要先确认作品。' });
  await assert.rejects(jsonRequest('/flat'), { message: '旧格式的提示' });
  await assert.rejects(chat({} as ChatRequest, new AbortController().signal, { onStatus() {}, async onPlan() {}, onReply() {} }), { message: '这次操作需要先确认作品。' });
  await assert.rejects(synthesize('你好', new AbortController().signal), { message: '这次操作需要先确认作品。' });
});

test('ACK success needs no recovery calls', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => asJson(receipt));
  assert.deepEqual(await acknowledge(requestId, revision, digest, new AbortController().signal), { reply: receipt.reply });
  assert.equal(fetch.mock.callCount(), 1);
});

test('lost ACK response recovers the committed reply using the same turn and session', async (t) => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const signal = new AbortController().signal;
  t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    if (calls.length === 1) throw new TypeError('connection reset after server committed');
    return asJson(receipt);
  });
  assert.deepEqual(await acknowledge(requestId, revision, digest, signal), { reply: receipt.reply });
  assert.deepEqual(calls.map(call => [call.path, call.init.method]), [[`${statePath}/ack`, 'POST'], [statePath, 'GET']]);
  assert.ok(calls.every(call => call.init.signal === signal));
  assert.equal(new Headers(calls[0].init.headers).get('X-Sayland-Session'), new Headers(calls[1].init.headers).get('X-Sayland-Session'));
});

test('a truncated ACK response is recovered by status rather than replaying a scene', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? new Response('{"requestId":') : asJson(receipt));
  assert.deepEqual(await acknowledge(requestId, revision, digest, new AbortController().signal), { reply: receipt.reply });
  assert.equal(calls, 2);
});

test('awaiting_ack permits one identical ACK retry, including a final query if its response is lost', async (t) => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    if (init.method === 'POST') throw new TypeError('lost acknowledgement');
    return asJson(calls.length === 2 ? { requestId, status: 'awaiting_ack' } : receipt);
  });
  assert.deepEqual(await acknowledge(requestId, revision, digest, new AbortController().signal), { reply: receipt.reply });
  assert.deepEqual(calls.map(call => [call.path, call.init.method]), [
    [`${statePath}/ack`, 'POST'], [statePath, 'GET'], [`${statePath}/ack`, 'POST'], [statePath, 'GET'],
  ]);
  assert.equal(calls[0].init.body, calls[2].init.body);
  assert.deepEqual(JSON.parse(calls[2].init.body as string), { revision, digest });
});

test('persistent pending status exhausts the bounded recovery without reporting success', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async (_path: string, init: RequestInit) => {
    if (init.method === 'POST') throw new TypeError('connection lost');
    return asJson({ requestId, status: 'awaiting_ack' });
  });
  await assert.rejects(acknowledge(requestId, revision, digest, new AbortController().signal), /确认信息暂时没有收齐/);
  assert.equal(fetch.mock.callCount(), 4);
});

test('cancelled, expired, and other pending turns never become successful receipts', async (t) => {
  for (const status of ['cancelled', 'failed', 'generating', 'replied']) {
    await t.test(status, async (subtest) => {
      const fetch = subtest.mock.method(globalThis, 'fetch', async (_path: string, init: RequestInit) => {
        if (init.method === 'POST') throw new TypeError('connection lost');
        return asJson({ ...receipt, status });
      });
      await assert.rejects(acknowledge(requestId, revision, digest, new AbortController().signal));
      assert.equal(fetch.mock.callCount(), 2);
    });
  }
});

test('explicit HTTP rejection does not retry either an ACK or an expired status query', async (t) => {
  await t.test('ACK rejects the digest', async (subtest) => {
    const fetch = subtest.mock.method(globalThis, 'fetch', async () => asJson({ error: '作品已发生变化' }, 409));
    await assert.rejects(acknowledge(requestId, revision, digest, new AbortController().signal), /作品已发生变化/);
    assert.equal(fetch.mock.callCount(), 1);
  });
  await t.test('status has expired', async (subtest) => {
    const fetch = subtest.mock.method(globalThis, 'fetch', async (_path: string, init: RequestInit) => {
      if (init.method === 'POST') throw new TypeError('connection lost');
      return asJson({ error: '这次操作已经过期' }, 404);
    });
    await assert.rejects(acknowledge(requestId, revision, digest, new AbortController().signal), /已经过期/);
    assert.equal(fetch.mock.callCount(), 2);
  });
});

test('recovery rejects replies belonging to another request or revision', async (t) => {
  for (const wrongReceipt of [{ ...receipt, requestId: 'another-turn' }, { ...receipt, revision: revision + 1 }, { ...receipt, reply: '' }]) {
    await t.test(JSON.stringify(wrongReceipt), async (subtest) => {
      const fetch = subtest.mock.method(globalThis, 'fetch', async (_path: string, init: RequestInit) => {
        if (init.method === 'POST') throw new TypeError('connection lost');
        return asJson(wrongReceipt);
      });
      await assert.rejects(acknowledge(requestId, revision, digest, new AbortController().signal));
      assert.equal(fetch.mock.callCount(), 2);
    });
  }
});

test('the original deadline also aborts a recovery query and forbids subsequent retries', async (t) => {
  const controller = new AbortController();
  const timeout = new DOMException('receipt deadline reached', 'TimeoutError');
  const fetch = t.mock.method(globalThis, 'fetch', async (_path: string, init: RequestInit) => {
    assert.equal(init.signal, controller.signal);
    if (init.method === 'POST') throw new TypeError('connection lost');
    controller.abort(timeout);
    throw controller.signal.reason;
  });
  await assert.rejects(acknowledge(requestId, revision, digest, controller.signal), error => error === timeout);
  assert.equal(fetch.mock.callCount(), 2);
});

test('an already aborted receipt never starts a network request', async (t) => {
  const controller = new AbortController(); controller.abort();
  const fetch = t.mock.method(globalThis, 'fetch', async () => asJson(receipt));
  await assert.rejects(acknowledge(requestId, revision, digest, controller.signal), { name: 'AbortError' });
  assert.equal(fetch.mock.callCount(), 0);
});


test('debug diagnostics read the exact turn with the existing page session and abort signal', async (t) => {
  const controller = new AbortController();
  const calls: Array<{ path: string; init: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    return asJson(receipt);
  });
  assert.deepEqual(await readTurnDiagnostics(requestId, controller.signal), receipt);
  await acknowledge(requestId, revision, digest, controller.signal);
  assert.equal(calls[0].path, statePath);
  assert.equal(calls[0].init.method ?? 'GET', 'GET');
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.signal, controller.signal);
  assert.equal(new Headers(calls[0].init.headers).get('X-Sayland-Session'), new Headers(calls[1].init.headers).get('X-Sayland-Session'));
  controller.abort();
  await assert.rejects(readTurnDiagnostics(requestId, controller.signal), { name: 'AbortError' });
  assert.equal(calls.length, 2);
});

test('debug diagnostics reject another turn instead of displaying it under the selected request', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => asJson({ ...receipt, requestId: 'other-turn' }));
  await assert.rejects(readTurnDiagnostics(requestId, new AbortController().signal), /另一次搭建/);
});

test('batch ACK sends its ID and rejects a receipt with another batch or digest', async (t) => {
  const batchId = `${requestId}-b1`;
  const batchReceipt = { ...receipt, batchId, digest };
  await t.test('matching receipt', async (subtest) => {
    const fetch = subtest.mock.method(globalThis, 'fetch', async (_path: string, init: RequestInit) => {
      assert.deepEqual(JSON.parse(init.body as string), { revision, digest, batchId });
      return asJson(batchReceipt);
    });
    assert.deepEqual(await acknowledge(requestId, revision, digest, new AbortController().signal, batchId), { reply: receipt.reply });
    assert.equal(fetch.mock.callCount(), 1);
  });
  for (const wrong of [{ ...batchReceipt, batchId: 'other-batch' }, { ...batchReceipt, digest: 'b'.repeat(64) }, { ...batchReceipt, digest: undefined }]) {
    await t.test('wrong identity or digest', async (subtest) => {
      subtest.mock.method(globalThis, 'fetch', async () => asJson(wrong));
      await assert.rejects(acknowledge(requestId, revision, digest, new AbortController().signal, batchId), /确认信息没有对上/);
    });
  }
});

test('a lost batch ACK is recovered from its exact receipt even after generation continues or stops', async (t) => {
  const batchId = `${requestId}-b1`, batchReceipt = { ...receipt, batchId, digest };
  for (const status of ['generating', 'awaiting_ack', 'replied', 'cancelled', 'failed']) {
    await t.test(status, async (subtest) => {
      const fetch = subtest.mock.method(globalThis, 'fetch', async (_path: string, init: RequestInit) => {
        if (init.method === 'POST') throw new TypeError('batch committed before connection reset');
        return asJson({ requestId, status, plan: { batchId: `${requestId}-b2` }, receipts: [{ ...batchReceipt, batchId: 'older-batch' }, batchReceipt] });
      });
      assert.deepEqual(await acknowledge(requestId, revision, digest, new AbortController().signal, batchId), { reply: receipt.reply });
      assert.equal(fetch.mock.callCount(), 2);
    });
  }
});

test('receipt recovery cannot confuse a different batch, revision, digest or request with a committed batch', async (t) => {
  const batchId = `${requestId}-b1`, batchReceipt = { ...receipt, batchId, digest };
  for (const wrong of [{ ...batchReceipt, requestId: 'wrong-turn' }, { ...batchReceipt, batchId: 'wrong-batch' }, { ...batchReceipt, revision: revision + 1 }, { ...batchReceipt, digest: 'b'.repeat(64) }]) {
    await t.test('mismatched receipt', async (subtest) => {
      const fetch = subtest.mock.method(globalThis, 'fetch', async (_path: string, init: RequestInit) => {
        if (init.method === 'POST') throw new TypeError('connection reset');
        return asJson({ requestId, status: 'generating', receipts: [wrong] });
      });
      await assert.rejects(acknowledge(requestId, revision, digest, new AbortController().signal, batchId));
      assert.equal(fetch.mock.callCount(), 2);
    });
  }
});

test('a pending batch ACK can retry only that exact pending batch', async (t) => {
  const batchId = `${requestId}-b1`;
  for (const matches of [true, false]) {
    await t.test(String(matches), async (subtest) => {
      let calls = 0;
      subtest.mock.method(globalThis, 'fetch', async (_path: string, init: RequestInit) => {
        calls++;
        if (calls === 1) throw new TypeError('lost ACK');
        if (init.method === 'GET') return asJson({ requestId, status: 'awaiting_ack', plan: { requestId, batchId: matches ? batchId : 'next-batch' }, receipts: [] });
        return asJson({ ...receipt, batchId, digest });
      });
      const pending = acknowledge(requestId, revision, digest, new AbortController().signal, batchId);
      if (matches) { assert.deepEqual(await pending, { reply: receipt.reply }); assert.equal(calls, 3); }
      else { await assert.rejects(pending); assert.equal(calls, 2); }
    });
  }
});

const frame = (event: string, value: unknown) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
const streamPlan = (batchId: string): ScenePlan => ({ requestId, batchId, batch: { protocolVersion: 1, baseRevision: 0, operations: [] }, reply: '一批完成' });
test('SSE awaits each batch then requires the final reply and done, cancelling the reader after done', async (t) => {
  const order: string[] = []; let cancelled = false;
  const bytes = new TextEncoder().encode(frame('plan', streamPlan('b1')) + frame('plan', streamPlan('b2'))
    + frame('reply', { requestId, reply: '整轮完成' }) + frame('done', { requestId }) + frame('reply', { requestId, reply: '迟到的错误回复' }));
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); }, cancel() { cancelled = true; } })));
  await chat({ requestId } as ChatRequest, new AbortController().signal, {
    onStatus() {}, async onPlan(plan) { order.push(plan.batchId!); await Promise.resolve(); order.push(`ack-${plan.batchId}`); }, onReply(reply) { order.push(reply); },
  });
  assert.deepEqual(order, ['b1', 'ack-b1', 'b2', 'ack-b2', '整轮完成']);
  assert.equal(cancelled, true);
});

test('SSE final reply without done is incomplete and cancellation blocks later queued batches', async (t) => {
  await t.test('missing done', async (subtest) => {
    subtest.mock.method(globalThis, 'fetch', async () => new Response(frame('reply', { requestId, reply: '还不能确认完成' })));
    await assert.rejects(chat({ requestId } as ChatRequest, new AbortController().signal, { onStatus() {}, async onPlan() {}, onReply() {} }), /连接中断/);
  });
  await t.test('stop after one batch', async (subtest) => {
    const controller = new AbortController(), batches: string[] = [];
    subtest.mock.method(globalThis, 'fetch', async () => new Response(frame('plan', streamPlan('b1')) + frame('plan', streamPlan('b2')) + frame('done', { requestId })));
    await assert.rejects(chat({ requestId } as ChatRequest, controller.signal, { onStatus() {}, async onPlan(plan) { batches.push(plan.batchId!); controller.abort(); }, onReply() {} }), { name: 'AbortError' });
    assert.deepEqual(batches, ['b1']);
  });
});

test('commentary survives byte-split CRLF and UTF-8 boundaries with explicit message identity', async (t) => {
  const messages: Array<{ messageId: string; text: string }> = [], statuses: string[] = [];
  const bytes = new TextEncoder().encode((frame('commentary', { requestId, messageId: 'ordinary-1', text: '先搭主体，再添细节。' })
    + frame('status', { requestId, message: '继续生成' }) + frame('reply', { requestId, reply: '完成了。' }) + frame('done', { requestId })).replace(/\n/g, '\r\n'));
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } })));
  await chat({ requestId } as ChatRequest, new AbortController().signal, { onStatus: value => statuses.push(value), onCommentary: value => messages.push(value), async onPlan() {}, onReply() {} });
  assert.deepEqual(messages, [{ messageId: 'ordinary-1', text: '先搭主体，再添细节。' }]); assert.deepEqual(statuses, ['继续生成']);
});

test('commentary is optional for old handlers and rejects foreign or malformed event identities', async (t) => {
  await t.test('old handler', async subtest => {
    subtest.mock.method(globalThis, 'fetch', async () => new Response(frame('commentary', { requestId, messageId: 'ok', text: '继续搭建。' }) + frame('done', { requestId })));
    await chat({ requestId } as ChatRequest, new AbortController().signal, { onStatus() {}, async onPlan() {}, onReply() {} });
  });
  for (const value of [
    { requestId: 'other-turn', messageId: 'id', text: '另一轮' }, { messageId: 'id', text: '缺少回合' },
    { requestId, text: '缺少消息编号' }, { requestId, messageId: 'id', text: '' }, { requestId, messageId: 'id', text: '长'.repeat(601) },
  ]) await t.test('invalid commentary', async subtest => {
    let called = false;
    subtest.mock.method(globalThis, 'fetch', async () => new Response(frame('commentary', value) + frame('done', { requestId })));
    await assert.rejects(chat({ requestId } as ChatRequest, new AbortController().signal, { onStatus() {}, onCommentary() { called = true; }, async onPlan() {}, onReply() {} }));
    assert.equal(called, false);
  });
});

test('cancelled streams do not dispatch queued commentary', async (t) => {
  const controller = new AbortController(), texts: string[] = [];
  t.mock.method(globalThis, 'fetch', async () => new Response(frame('status', { requestId, message: '等待' })
    + frame('commentary', { requestId, messageId: 'late', text: '不能迟到显示' }) + frame('done', { requestId })));
  await assert.rejects(chat({ requestId } as ChatRequest, controller.signal, { onStatus() { controller.abort(); }, onCommentary(value) { texts.push(value.text); }, async onPlan() {}, onReply() {} }), { name: 'AbortError' });
  assert.deepEqual(texts, []);
});
