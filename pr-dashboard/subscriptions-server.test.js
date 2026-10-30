import { expect, test } from 'bun:test';
import { buildSnapshot } from './dashboard.js';
import { createGitHubClient } from './github.js';
import { createDashboardStore } from './store.js';
import * as subscriptions from './subscriptions-server.js';
import { acknowledge, markRemoved } from './watchlist.js';

const row = { id: '42', url: 'https://github.com/other/repo/issues/1', repo: 'other/repo', owner: 'other', number: 1, type: 'Issue', title: 'Issue', authored: false, unread: true, updatedAt: '2026-10-27T00:00:00Z', subscribed: true, state: 'OPEN', closedAt: null, mergedAt: null };
const visible = ({ id, url, repo, owner, number, title, type, state, authored, unread, subscribed, updatedAt, closedAt }) => ({
  id, url, repo, owner, number, title, type, state, authored: Boolean(authored), unread, subscribed, updatedAt, closedAt, mergedAt: null,
});
const result = (threads = [row]) => ({ threads, warnings: [], truncated: false });
const request = (body = { url: row.url }, headers = {}, method = 'POST') => new Request('http://dashboard/subscriptions/unsubscribe', {
  method, headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
  ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
});
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

function harness(createClient, watchStore = createDashboardStore({ logger: { error() {} } })) {
  let snapshot;
  const rebuild = () => {
    snapshot = buildSnapshot({ viewer: 'me', repos: [], openPullRequests: [], closedPullRequests: [], subscriptions: controller.snapshot() });
  };
  const controller = subscriptions.createSubscriptionsController({ createClient, rebuild, respond: () => Response.json(snapshot), watchStore });
  rebuild();
  return { controller, rebuild, snapshot: () => snapshot, store: watchStore };
}

test('missing notifications credentials produce an empty unavailable section without blocking a snapshot', async () => {
  const h = harness();
  await h.controller.refresh({ stateClient: {}, excludeOwners: ['me'] });
  h.rebuild();
  expect(h.snapshot().viewer).toBe('me');
  expect(h.snapshot().contributions).toEqual({ attention: [], open: [], closed: [] });
  expect(h.snapshot().subscriptions).toEqual({ items: [], unread: 0, hidden: 0, warnings: [], truncated: false, error: null, canUnsubscribe: false });
  expect((await h.controller.unsubscribe(request())).status).toBe(503);
});

test('discovery failures stay in subscriptions, retain previous rows, and recover independently', async () => {
  let fail = false;
  let mutations = 0;
  const stateClient = { viewer: true };
  const h = harness(() => ({ fetchSubscriptions: async (options) => {
    expect(options.stateClient).toBe(stateClient);
    expect(options.excludeOwners).toEqual(['me']);
    if (fail) throw new Error('notifications denied');
    return { ...result(), warnings: ['partial discovery'], truncated: true };
  }, unsubscribe: async () => { mutations++; } }));
  const refresh = async () => { await h.controller.refresh({ stateClient, excludeOwners: ['me'] }); h.rebuild(); };
  await refresh();
  expect(h.snapshot().subscriptions.canUnsubscribe).toBe(true);
  fail = true;
  await refresh();
  expect(h.snapshot().subscriptions.error).toBe('notifications denied');
  expect(h.snapshot().subscriptions.items).toEqual([visible(row)]);
  expect((await h.controller.unsubscribe(request())).status).toBe(503);
  expect(mutations).toBe(0);
  expect(h.snapshot().subscriptions.canUnsubscribe).toBe(false);
  expect(h.snapshot().subscriptions.warnings).toEqual(['partial discovery']);
  expect(h.snapshot().subscriptions.truncated).toBe(true);
  expect(h.snapshot().repoCount).toBe(0);
  expect(h.snapshot().contributions.open).toEqual([]);
  fail = false;
  await refresh();
  expect(h.snapshot().subscriptions.error).toBeNull();
  expect(h.snapshot().subscriptions.canUnsubscribe).toBe(true);
  expect((await h.controller.unsubscribe(request())).status).toBe(200);
  expect(mutations).toBe(1);
});

test('closed unread rows with unknown subscription stay visible and cannot be unsubscribed', async () => {
  const unknown = { ...row, subscribed: null, state: 'CLOSED', closedAt: '2020-01-01T00:00:00Z' };
  let mutations = 0;
  const h = harness(() => ({ fetchSubscriptions: async () => result([unknown]), unsubscribe: async () => { mutations++; } }));
  await h.controller.refresh({}); h.rebuild();
  expect(h.snapshot().subscriptions.items).toEqual([visible(unknown)]);
  expect(h.snapshot().subscriptions.unread).toBe(1);
  expect((await h.controller.unsubscribe(request())).status).toBe(404);
  expect(mutations).toBe(0);
});

test('authored rows without a notification thread are shown but cannot be unsubscribed', async () => {
  const authored = { ...row, id: null, authored: true, unread: false };
  let mutations = 0;
  const h = harness(() => ({ fetchSubscriptions: async () => result([authored]), unsubscribe: async () => { mutations++; } }));
  await h.controller.refresh({}); h.rebuild();
  expect(h.snapshot().subscriptions.items).toEqual([visible(authored)]);
  expect((await h.controller.unsubscribe(request())).status).toBe(404);
  expect(mutations).toBe(0);
});

test('request guards and current visible URL membership reject unsafe mutations', async () => {
  let mutations = 0;
  const hidden = { ...row, id: '43', url: `${row.url}0`, unread: false, state: 'CLOSED', closedAt: '2020-01-01T00:00:00Z' };
  const h = harness(() => ({ fetchSubscriptions: async () => result([row, hidden]), unsubscribe: async () => { mutations++; } }));
  await h.controller.refresh({}); h.rebuild();
  for (const [req, status] of [
    [request({}, {}, 'GET'), 405],
    [request(undefined, { 'content-type': 'text/plain' }), 415],
    [request(undefined, { 'sec-fetch-site': 'cross-site' }), 403],
    [request(undefined, { 'sec-fetch-site': 'same-site' }), 403],
    [request('{'), 400], [request({ url: 42 }), 400],
    [request({ url: 'https://github.com/unknown/repo/issues/1', id: '42' }), 404],
    [request({ url: hidden.url }), 404],
  ]) expect((await h.controller.unsubscribe(req)).status).toBe(status);
  expect(mutations).toBe(0);
  expect(h.snapshot().subscriptions.items.map(({ url }) => url)).toEqual([row.url]);
  expect(h.snapshot().subscriptions.hidden).toBe(0);
});

test('failed DELETE retains the row; success removes it immediately and returns the full snapshot', async () => {
  let fail = true;
  const ids = [];
  const h = harness(() => ({ fetchSubscriptions: async () => result(), unsubscribe: async (id) => {
    ids.push(id);
    if (fail) throw new Error('DELETE denied');
  } }));
  await h.controller.refresh({}); h.rebuild();
  expect((await h.controller.unsubscribe(request())).status).toBe(502);
  expect(h.snapshot().subscriptions.items).toEqual([visible(row)]);
  fail = false;
  const response = await h.controller.unsubscribe(request({ url: row.url, id: '999' }));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.viewer).toBe('me');
  expect(body.workflows).toBeDefined();
  expect(body.subscriptions.items).toEqual([]);
  expect(body.subscriptions.unread).toBe(0);
  expect(ids).toEqual(['42', '42']);
});

test('late refresh cannot restore a deleted row or its client cache; a later resubscription remains discoverable', async () => {
  const pending = deferred();
  const started = deferred();
  let delay = false;
  let subscribed = true;
  let subscriptionReads = 0;
  const h = harness(() => createGitHubClient({ token: 'test', fetchImpl: async (url, init) => {
    if (init.method === 'DELETE') { subscribed = false; return new Response(null, { status: 204 }); }
    if (url.includes('/threads/')) {
      subscriptionReads++;
      if (init.headers['If-None-Match'] === 'stale') return new Response(null, { status: 304 });
      if (delay) { delay = false; started.resolve(); await pending.promise; return Response.json({ subscribed: true }, { headers: { ETag: 'stale' } }); }
      return Response.json({ subscribed });
    }
    return Response.json([{ id: '42', reason: 'manual', unread: true, repository: { full_name: 'other/repo' }, subject: { type: 'Issue', title: 'Issue', url: 'https://api.github.com/repos/other/repo/issues/1' } }]);
  } }));
  const options = { stateClient: { graphql: async () => ({ repo0: { subject: { state: 'OPEN' } } }) } };
  await h.controller.refresh(options); h.rebuild();
  delay = true;
  const stale = h.controller.refresh(options);
  await started.promise;
  expect((await h.controller.unsubscribe(request())).status).toBe(200);
  pending.resolve();
  await stale; h.rebuild();
  expect(h.snapshot().subscriptions.items).toEqual([]);
  await h.controller.refresh(options); h.rebuild();
  expect(h.snapshot().subscriptions.items).toEqual([]);
  expect(subscriptionReads).toBe(3);
  subscribed = true;
  await h.controller.refresh(options); h.rebuild();
  expect(h.snapshot().subscriptions.items.map(({ id }) => id)).toEqual(['42']);
});

test('successive unsubscribes use fresh clients and can remove different current rows', async () => {
  const other = { ...row, id: '43', url: `${row.url}0` };
  const ids = [];
  const h = harness(() => ({ fetchSubscriptions: async () => result([row, other]), unsubscribe: async (id) => { ids.push(id); } }));
  await h.controller.refresh({}); h.rebuild();
  expect((await h.controller.unsubscribe(request())).status).toBe(200);
  expect((await h.controller.unsubscribe(request({ url: other.url }))).status).toBe(200);
  expect(h.snapshot().subscriptions.items).toEqual([]);
  expect(ids).toEqual(['42', '43']);
});

const tracker = (subjects = {}) => {
  const calls = [];
  return { calls, fetchTrackedSubjects: async (entries) => {
    calls.push(entries.map(({ url }) => url));
    return { subjects: new Map(entries.map(({ url }) => [url, subjects[url] ?? { title: 'Issue', updatedAt: row.updatedAt, state: 'OPEN', closedAt: null, subscribed: true }])), warnings: ['tracked warning'] };
  } };
};
const update = (store, change) => { const entries = { ...store.watchlistAll() }; const result = change(entries); store.replaceWatch(entries); return result; };

test('a previously discovered open entry stays when a later discovery no longer returns it', async () => {
  let threads = [row];
  const stateClient = tracker();
  const h = harness(() => ({ fetchSubscriptions: async () => result(threads) }));
  await h.controller.refresh({ stateClient }); h.rebuild();
  expect(h.snapshot().subscriptions.items).toEqual([visible(row)]);
  threads = [];
  await h.controller.refresh({ stateClient }); h.rebuild();
  expect(h.snapshot().subscriptions.items).toEqual([visible(row)]);
  expect(h.snapshot().subscriptions.warnings).toEqual(['tracked warning']);
  expect(stateClient.calls).toEqual([[row.url], [row.url]]);
  expect(Object.keys(h.store.watchlistAll())).toEqual([row.url]);
});

test('acknowledge, remove and closed deletion during an in-flight refresh are not undone', async () => {
  const removed = { ...row, id: '43', url: `${row.url}0` };
  const closed = { ...row, id: '44', url: `${row.url}1`, state: 'CLOSED', closedAt: row.updatedAt };
  const threads = [row, removed, closed];
  let pending = null;
  const stateClient = tracker({ [closed.url]: { title: 'Issue', updatedAt: row.updatedAt, state: 'CLOSED', closedAt: row.updatedAt, subscribed: true } });
  const h = harness(() => ({ fetchSubscriptions: async () => { if (pending) await pending.promise; return result(threads); } }));
  await h.controller.refresh({ stateClient }); h.rebuild();
  expect(h.snapshot().subscriptions.items.map(({ url, unread }) => [url, unread])).toEqual([[row.url, true], [removed.url, true], [closed.url, true]]);

  pending = deferred();
  const inflight = h.controller.refresh({ stateClient });
  expect(update(h.store, (entries) => acknowledge(entries, row.url))).toBe(true);
  expect(update(h.store, (entries) => markRemoved(entries, removed.url, new Date('2026-10-28T00:00:00Z')))).toBe(true);
  expect(update(h.store, (entries) => acknowledge(entries, closed.url))).toBe(true);
  pending.resolve();
  await inflight; h.rebuild();

  expect(h.snapshot().subscriptions.items).toEqual([visible({ ...row, unread: false })]);
  expect(h.snapshot().subscriptions.unread).toBe(0);
  expect(h.store.watchlistAll()[row.url].seenUpdatedAt).toBe(row.updatedAt);
  expect(h.store.watchlistAll()[removed.url].removedAt).toBe('2026-10-28T00:00:00.000Z');
  expect(closed.url in h.store.watchlistAll()).toBe(false);
  expect(stateClient.calls[1]).toEqual([row.url]);
});

test('discovery error keeps stored rows and skips the merge', async () => {
  const store = createDashboardStore({ logger: { error() {} } });
  const stateClient = tracker();
  const seeded = harness(() => ({ fetchSubscriptions: async () => result([row]) }), store);
  await seeded.controller.refresh({ stateClient });
  const h = harness(() => ({ fetchSubscriptions: async () => { throw new Error('notifications denied'); } }), store);
  h.rebuild();
  expect(h.snapshot().subscriptions.items).toEqual([visible(row)]);
  await h.controller.refresh({ stateClient }); h.rebuild();
  expect(h.snapshot().subscriptions.error).toBe('notifications denied');
  expect(h.snapshot().subscriptions.items).toEqual([visible(row)]);
  expect(stateClient.calls).toHaveLength(1);
});

for (const notifications of ['absent', 'failing']) {
  test(`actual server refresh updates owners and contributions with ${notifications} notifications credentials`, async () => {
    // Isolated module mocks avoid sharing the server's singleton state with other tests.
    const script = `
      import { mock } from 'bun:test';
      process.env.GITHUB_TOKENS = '{"me":"viewer-fixture"}';
      process.env.NOTIFICATIONS_TOKEN = ${JSON.stringify(notifications === 'absent' ? '' : 'notifications-fixture')};
      process.env.STATE_FILE = '';
      process.env.LOG_LEVEL = 'error';
      globalThis.fetch = () => { throw new Error('Network forbidden in server test'); };
      let route, tick, iteration = 1;
      Bun.serve = (options) => { route = options.fetch; };
      globalThis.setInterval = (callback) => { tick = callback; };
      const viewerClient = {
        fetchViewer: async () => 'me', rateLimit: () => null,
        fetchOwnerRepos: async () => [{ nameWithOwner: 'me/repo-' + iteration, url: 'https://github.com/me/repo' }],
        fetchContributions: async () => ({ openPullRequests: [{
          repository: { nameWithOwner: 'other/repo' }, number: 1, title: 'Revision ' + iteration,
          url: 'https://github.com/other/repo/pull/1', state: 'OPEN', updatedAt: '2026-10-27T12:00:00Z'
        }], closedPullRequests: [] }),
      };
      mock.module(${JSON.stringify(`${import.meta.dir}/github.js`)}, () => ({
        parseOwnerTokens: JSON.parse,
        createGitHubClient: ({ token }) => token === 'viewer-fixture' ? viewerClient : {
          fetchSubscriptions: async ({ stateClient }) => {
            if (stateClient !== viewerClient) throw new Error('Wrong viewer client');
            throw new Error('notifications denied');
          },
        },
      }));
      await import(${JSON.stringify(`${import.meta.dir}/server.js`)});
      let response;
      for (let attempts = 0; attempts < 100; attempts++) {
        response = await route(new Request('http://dashboard/data.json'));
        if (response.status === 200) break;
        await Bun.sleep(1);
      }
      if (response.status !== 200) throw new Error('Server never produced snapshot');
      iteration = 2;
      await tick();
      console.log(JSON.stringify(await (await route(new Request('http://dashboard/data.json'))).json()));
    `;
    const child = Bun.spawn([process.execPath, '--eval', script], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
    const snapshot = JSON.parse(stdout.trim());
    expect(snapshot.error).toBeNull();
    expect(snapshot.repoCount).toBe(1);
    expect(snapshot.renovate.untracked[0].repo).toBe('me/repo-2');
    expect(snapshot.contributions.open[0].title).toBe('Revision 2');
    expect(snapshot.subscriptions.error).toBe(notifications === 'absent' ? null : 'notifications denied');
    expect(snapshot.subscriptions.canUnsubscribe).toBe(false);
  });
}
