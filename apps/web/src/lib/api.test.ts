import test from 'node:test';
import assert from 'node:assert/strict';
import { acknowledge, chat, jsonRequest, readTurnDiagnostics, synthesize } from './api.ts';
import type { ChatRequest } from '../../../../packages/protocol/src/index.ts';

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
