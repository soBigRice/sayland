import test from 'node:test';
import assert from 'node:assert/strict';
import { VoxelEngine } from '../../../packages/scene/src/index.ts';
import { createApp } from '../src/app.ts';
import type { ApiConfig } from '../src/config.ts';
import type { PlannerPhase, Providers } from '../src/providers.ts';

const config: ApiConfig = { port: 4311, allowedOrigins: [], deepseek: { apiKey: 'fixture', baseUrl: 'https://fixture.invalid', model: 'fixture' },
  mimo: { apiKey: 'fixture', baseUrl: 'https://fixture.invalid', asrModel: 'fixture', ttsModel: 'fixture', voice: 'fixture' } };
const headers = { host: '127.0.0.1:4311', 'x-sayland-session': 'fixture-activity-session' };
const input = { requestId: 'fixture-activity', text: '看看小岛', snapshot: new VoxelEngine().snapshot(), messages: [] };
const phases: PlannerPhase[] = ['inspect', 'read-region', 'get-views', 'tool-input', 'validate', 'repair', 'answering'];

test('rapid real phase changes reach SSE in order while repeated token progress is coalesced', async t => {
  const providers: Providers = {
    async plan(_input, _signal, options) {
      for (const phase of phases) { options!.onProgress!(phase); options!.onProgress!(phase); }
      return { reply: '看好啦。' };
    }, transcribe: async () => '', synthesize: async () => Buffer.from('fixture'),
  };
  const app = createApp(config, { providers, now: () => 10_000 }); t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/chat', headers, payload: input });
  assert.equal(response.statusCode, 200);
  const statuses = response.body.split('\n\n').filter(block => block.startsWith('event: status\n'))
    .map(block => JSON.parse(block.split('\n')[1].slice(6)));
  assert.deepEqual(statuses.map(item => item.phase), ['thinking', ...phases]);
  assert.ok(statuses.every(item => item.requestId === input.requestId && typeof item.message === 'string' && item.message.length > 0));
  assert.equal(new Set(statuses.map(item => item.message)).size, statuses.length);
});

test('cancellation prevents late provider activity from appearing in the stream', async t => {
  let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
  const providers: Providers = {
    async plan(_input, signal, options) {
      options!.onProgress!('inspect'); ready();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      options!.onProgress!('get-views');
      return { reply: '迟到的回复' };
    }, transcribe: async () => '', synthesize: async () => Buffer.from('fixture'),
  };
  const app = createApp(config, { providers }); t.after(() => app.close());
  const response = app.inject({ method: 'POST', url: '/api/chat', headers, payload: input }).then(value => value);
  await started;
  await app.inject({ method: 'POST', url: `/api/turns/${input.requestId}/cancel`, headers });
  const finished = await response;
  assert.ok(finished.body.includes('"phase":"inspect"'));
  assert.ok(!finished.body.includes('"phase":"get-views"'));
  assert.ok(!finished.body.includes('迟到的回复'));
});
