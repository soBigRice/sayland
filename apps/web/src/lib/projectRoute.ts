import { workspaceId } from '../../../../packages/protocol/src/workspace.ts';

export type ProjectRoute = { kind: 'home' } | { kind: 'project'; id: string } | { kind: 'invalid' };

export function readProjectRoute(pathname: string): ProjectRoute {
  if (pathname === '/') return { kind: 'home' };
  const match = /^\/projects\/([^/]+)\/?$/.exec(pathname);
  if (!match) return { kind: 'invalid' };
  try {
    const id = decodeURIComponent(match[1]);
    return workspaceId.safeParse(id).success ? { kind: 'project', id } : { kind: 'invalid' };
  } catch { return { kind: 'invalid' }; }
}

export const projectPath = (id: string | null) => id === null ? '/' : `/projects/${encodeURIComponent(id)}`;

type HistoryWindow = Pick<Window, 'history' | 'location' | 'addEventListener' | 'removeEventListener'>;

/** Two local routes. Restore the current entry before asking to save, so Cancel preserves Forward/Back. */
export function createProjectHistory(navigate: (route: ProjectRoute) => Promise<boolean>, browser: HistoryWindow = window) {
  const indexOf = () => {
    const value: unknown = browser.history.state?.saylandIndex;
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0;
  };
  let index = indexOf(), disposed = false, applying = false;
  let pending: { index: number; route: ProjectRoute } | null = null;
  let accepted: number | null = null;
  browser.history.replaceState({ ...browser.history.state, saylandIndex: index }, '');

  const pop = () => {
    const arrived = indexOf();
    if (accepted === arrived) { index = arrived; accepted = null; pending = null; return; }
    if (arrived !== index) {
      pending ??= { index: arrived, route: readProjectRoute(browser.location.pathname) };
      browser.history.go(index - arrived);
      return;
    }
    if (!pending || applying) return;
    const target = pending;
    applying = true;
    void navigate(target.route).then(ok => {
      if (disposed) return;
      if (ok) { accepted = target.index; browser.history.go(target.index - indexOf()); }
      else pending = null;
    }).finally(() => { applying = false; });
  };
  browser.addEventListener('popstate', pop);
  return {
    push(id: string | null) {
      const path = projectPath(id);
      if (browser.location.pathname === path || pending) return;
      browser.history.pushState({ saylandIndex: ++index }, '', `${path}${browser.location.search}`);
    },
    dispose() { disposed = true; browser.removeEventListener('popstate', pop); },
  };
}
