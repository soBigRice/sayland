import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectHistory, projectPath, readProjectRoute, type ProjectRoute } from './projectRoute.ts';

test('scene links preserve existing IDs and distinguish the home address from invalid routes', () => {
  const id = 'd628da35-040b-4209-b210-b8406f6190af';
  assert.equal(projectPath(null), '/');
  assert.equal(projectPath(id), `/projects/${id}`);
  assert.deepEqual(readProjectRoute(projectPath(id)), { kind: 'project', id });
  assert.deepEqual(readProjectRoute(`${projectPath(id)}/`), { kind: 'project', id });
  assert.deepEqual(readProjectRoute('/'), { kind: 'home' });
  for (const path of ['/projects', '/projects/short', '/projects/%ZZ', '/projects/abcdefgh%2Fijklmnop', '/unrelated/abcdefgh']) {
    assert.deepEqual(readProjectRoute(path), { kind: 'invalid' }, path);
  }
});

function historyFixture(initial = '/') {
  const entries = [{ path: initial, state: {} as Record<string, unknown> }];
  let cursor = 0;
  const listeners = new Set<() => void>();
  const browser = {
    location: { get pathname() { return entries[cursor].path.split('?')[0]; }, search: '?debug=1' },
    history: {
      get state() { return entries[cursor].state; },
      replaceState(state: Record<string, unknown>, _: string, path?: string) { entries[cursor] = { state, path: path ?? entries[cursor].path }; },
      pushState(state: Record<string, unknown>, _: string, path: string) { entries.splice(cursor + 1); entries.push({ state, path }); cursor++; },
      go(delta: number) {
        queueMicrotask(() => {
          if (cursor + delta < 0 || cursor + delta >= entries.length) return;
          cursor += delta;
          for (const listener of listeners) listener();
        });
      },
    },
    addEventListener(_: string, listener: () => void) { listeners.add(listener); },
    removeEventListener(_: string, listener: () => void) { listeners.delete(listener); },
  };
  return { browser: browser as unknown as Parameters<typeof createProjectHistory>[1], entries, get path() { return browser.location.pathname; }, go: browser.history.go, listeners };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('entering different scenes adds distinct addresses without duplicate entries', () => {
  const fixture = historyFixture();
  const history = createProjectHistory(async () => true, fixture.browser);
  history.push('project-one'); history.push('project-one'); history.push(null); history.push('project-two');
  assert.deepEqual(fixture.entries.map(entry => entry.path), ['/', '/projects/project-one?debug=1', '/?debug=1', '/projects/project-two?debug=1']);
  history.dispose();
  assert.equal(fixture.listeners.size, 0);
});

test('Back waits on saving at the original address; cancellation keeps the forward history intact', async () => {
  const fixture = historyFixture();
  let finish!: (ok: boolean) => void;
  const requested: ProjectRoute[] = [];
  const history = createProjectHistory(route => {
    requested.push(route);
    assert.equal(fixture.path, '/projects/project-one');
    return new Promise<boolean>(resolve => { finish = resolve; });
  }, fixture.browser);
  history.push('project-one'); fixture.go(-1); await settle();
  assert.deepEqual(requested, [{ kind: 'home' }]);
  assert.equal(fixture.path, '/projects/project-one');
  finish(false); await settle();
  assert.equal(fixture.path, '/projects/project-one');
  fixture.go(-1); await settle(); finish(true); await settle();
  assert.equal(fixture.path, '/');
  assert.equal(fixture.entries.length, 2);
  history.dispose();
});

test('Back and Forward load the addressed scene, including after recreating the history controller', async () => {
  const fixture = historyFixture();
  const visited: ProjectRoute[] = [];
  const navigate = async (route: ProjectRoute) => { visited.push(route); return true; };
  let history = createProjectHistory(navigate, fixture.browser);
  history.push('project-one'); history.push(null); history.push('project-two');
  history.dispose(); history = createProjectHistory(navigate, fixture.browser);
  fixture.go(-2); await settle();
  assert.equal(fixture.path, '/projects/project-one');
  fixture.go(2); await settle();
  assert.equal(fixture.path, '/projects/project-two');
  assert.deepEqual(visited, [{ kind: 'project', id: 'project-one' }, { kind: 'project', id: 'project-two' }]);
  history.dispose();
});

test('failed opening stays on the current entry and disposing cancels a pending transition', async () => {
  const fixture = historyFixture('/projects/project-one');
  let finish!: (ok: boolean) => void;
  const history = createProjectHistory(() => new Promise<boolean>(resolve => { finish = resolve; }), fixture.browser);
  history.push(null); fixture.go(-1); await settle(); finish(false); await settle();
  assert.equal(fixture.path, '/');
  fixture.go(-1); await settle(); history.dispose(); finish(true); await settle();
  assert.equal(fixture.path, '/');
});
