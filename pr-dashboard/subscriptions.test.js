import { expect, test, spyOn } from 'bun:test';
import { createGitHubClient } from './github.js';
import * as dashboard from './dashboard.js';

const API = 'https://api.github.com';
const notification = (id, type = 'Issue', overrides = {}) => ({
  id: String(id), reason: 'manual', unread: true, updated_at: '2026-10-26T00:00:00Z',
  repository: { full_name: 'other/project', owner: { login: 'other' } },
  subject: { type, title: `Subject ${id}`, url: `${API}/repos/other/project/${type === 'PullRequest' ? 'pulls' : type === 'Discussion' ? 'discussions' : 'issues'}/${id}` },
  ...overrides,
});
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const client = (fetchImpl) => createGitHubClient({ token: 'test-notifications', fetchImpl });
const stateClient = (subjects = {}) => createGitHubClient({ token: 'test-viewer', fetchImpl: async (url, init) => {
  expect(url).toBe(`${API}/graphql`);
  expect(init.headers.Authorization).toBe('bearer test-viewer');
  const { query } = JSON.parse(init.body);
  const data = {};
  for (const match of query.matchAll(/(repo\d+): repository/g)) {
    data[match[1]] = { subject: subjects[match[1]] || { state: 'OPEN', closedAt: null, mergedAt: null } };
  }
  return json({ data });
} });

test('follows short Link pages; filters manual external supported subjects and deduplicates', async () => {
  const requested = [];
  const c = client(async (url) => {
    requested.push(url);
    if (url.includes('/subscription')) return json({ subscribed: true, ignored: false });
    if (url.includes('page=2')) return json([
      notification(2, 'PullRequest'), notification(3, 'Discussion'), notification(4, 'Commit'),
      notification(5, 'Issue', { reason: 'mention' }),
      notification(6, 'Issue', { repository: { full_name: 'ME/project', owner: { login: 'ME' } } }),
      notification(1),
    ]);
    return json([notification(1)], 200, { Link: `<${API}/notifications?all=true&per_page=100&page=2>; rel="next"` });
  });
  const result = await c.fetchSubscriptions({ excludeOwners: ['me'], stateClient: stateClient({ repo2: { closed: true, closedAt: '2026-10-25T00:00:00Z' } }) });
  expect(result.threads.map((t) => t.id)).toEqual(['1', '2', '3']);
  expect(result.threads[0]).toEqual({ id: '1', url: 'https://github.com/other/project/issues/1', repo: 'other/project', owner: 'other', number: 1, title: 'Subject 1', type: 'Issue', unread: true, updatedAt: '2026-10-26T00:00:00Z', subscribed: true, state: 'OPEN', closedAt: null, mergedAt: null });
  expect(result.threads[2].state).toBe('CLOSED');
  expect(result.warnings).toEqual([]);
  expect(result.truncated).toBe(false);
  expect(requested.filter((url) => url.includes('/subscription'))).toHaveLength(3);
  expect(new URL(requested[0]).searchParams.get('all')).toBe('true');
});

test('subscription 404 and false/ignored disappear; 403 and 5xx remain unknown with warnings', async () => {
  const c = client(async (url) => {
    if (!url.includes('/subscription')) return json([1, 2, 3, 4, 5].map((id) => notification(id)));
    const id = url.match(/threads\/(\d+)/)[1];
    return id === '1' ? json({}, 404) : id === '2' ? json({}, 403) : id === '3' ? json({}, 503)
      : json({ subscribed: id === '5', ignored: id === '5' });
  });
  const result = await c.fetchSubscriptions({ stateClient: stateClient() });
  expect(result.threads.map((t) => [t.id, t.subscribed])).toEqual([['2', null], ['3', null]]);
  expect(result.warnings).toHaveLength(2);
});

test('caps discovery at ten pages and thirty candidate subjects with explicit truncation', async () => {
  let pages = 0;
  const paged = client(async () => {
    pages++;
    return json([], 200, { Link: `<${API}/notifications?all=true&page=${pages + 1}>; rel="next"` });
  });
  expect((await paged.fetchSubscriptions({ stateClient: stateClient() })).truncated).toBe(true);
  expect(pages).toBe(10);
  let checks = 0;
  const capped = client(async (url) => {
    if (!url.includes('/subscription')) return json(Array.from({ length: 31 }, (_, i) => notification(i + 1)));
    checks++;
    return json({ subscribed: true });
  });
  const result = await capped.fetchSubscriptions({ stateClient: stateClient() });
  expect(result.threads).toHaveLength(30);
  expect(checks).toBe(30);
  expect(result.truncated).toBe(true);
  expect(result.warnings.join(' ')).toMatch(/truncat|limit/i);
});

test('rejects external/mismatched subject URLs and external pagination without following them', async () => {
  const requested = [];
  const c = client(async (url) => {
    requested.push(url);
    return json([
      notification(1, 'Issue', { subject: { type: 'Issue', title: 'bad', url: 'https://evil.example/issues/1' } }),
      notification(2, 'Issue', { subject: { type: 'Issue', title: 'bad', url: `${API}/repos/elsewhere/repo/issues/2` } }),
    ], 200, { Link: '<https://evil.example/notifications?page=2>; rel="next"' });
  });
  const result = await c.fetchSubscriptions({ stateClient: stateClient() });
  expect(requested).toHaveLength(1);
  expect(result.threads).toEqual([]);
  expect(result.warnings.length).toBeGreaterThan(0);
});

test('keeps inaccessible subject state unknown with a warning; never needs notification-token GraphQL', async () => {
  const c = client(async (url) => url.includes('/subscription') ? json({ subscribed: true }) : json([notification(1)]));
  const inaccessible = createGitHubClient({ token: 'viewer', fetchImpl: async () => json({ data: { repo0: null }, errors: [{ message: 'not accessible' }] }) });
  const result = await c.fetchSubscriptions({ stateClient: inaccessible });
  expect(result.threads[0].state).toBeNull();
  expect(result.warnings.length).toBeGreaterThan(0);
});

test('a viewer lookup failure preserves threads, and a missing viewer never falls back to notification GraphQL', async () => {
  const requests = [];
  const c = client(async (url) => {
    requests.push(url);
    return url.includes('/subscription') ? json({ subscribed: true }) : json([notification(1)]);
  });
  const failingViewer = createGitHubClient({ token: 'viewer', fetchImpl: async () => json({}, 403) });
  for (const viewer of [failingViewer, undefined]) {
    const result = await c.fetchSubscriptions({ stateClient: viewer });
    expect(result.threads[0]).toMatchObject({ subscribed: true, state: null, closedAt: null, mergedAt: null });
    expect(result.warnings.length).toBeGreaterThan(0);
  }
  expect(requests.every((url) => !url.endsWith('/graphql'))).toBe(true);
});

test('discovery failures propagate for the caller to isolate from other dashboard data', async () => {
  await expect(client(async () => json({}, 403)).fetchSubscriptions({ stateClient: stateClient() }))
    .rejects.toMatchObject({ status: 403, operation: 'notifications' });
});

test('enrichment batches subjects and requests the documented fields for each type', async () => {
  const queries = [];
  const viewer = createGitHubClient({ token: 'viewer', fetchImpl: async (url, init) => {
    const { query } = JSON.parse(init.body);
    queries.push(query);
    return json({ data: {
      repo0: { subject: { state: 'MERGED', closedAt: '2026-10-22T00:00:00Z', mergedAt: '2026-10-22T00:00:00Z' } },
      repo1: { subject: { closed: false, closedAt: null } },
    } });
  } });
  const c = client(async (url) => url.includes('/subscription') ? json({ subscribed: true }) : json([
    notification(1, 'PullRequest'), notification(2, 'Discussion'),
  ]));
  const result = await c.fetchSubscriptions({ stateClient: viewer });
  expect(queries).toHaveLength(1);
  expect(queries[0]).toContain('subject: pullRequest(number: 1) { state closedAt mergedAt }');
  expect(queries[0]).toContain('subject: discussion(number: 2) { closed closedAt }');
  expect(result.threads.map(({ state, mergedAt }) => ({ state, mergedAt }))).toEqual([
    { state: 'MERGED', mergedAt: '2026-10-22T00:00:00Z' }, { state: 'OPEN', mergedAt: null },
  ]);
});

test('obeys poll interval, reuses 304 body and Link, and uses Last-Modified without assuming ETags', async () => {
  let now = 100000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const polls = [];
    const c = client(async (url, init) => {
      if (url.includes('/subscription')) return json({ subscribed: true });
      polls.push({ url, headers: init.headers });
      if (polls.length > 2) return new Response(null, { status: 304, headers: { 'X-Poll-Interval': '120' } });
      return json([notification(url.includes('page=2') ? 2 : 1)], 200, {
        'Last-Modified': 'Mon, 26 Oct 2026 00:00:00 GMT', 'X-Poll-Interval': '60',
        ...(url.includes('page=2') ? {} : { Link: `<${API}/notifications?all=true&page=2>; rel="next"` }),
      });
    });
    await c.fetchSubscriptions({ stateClient: stateClient() });
    now += 59000;
    expect((await c.fetchSubscriptions({ stateClient: stateClient() })).threads).toHaveLength(2);
    expect(polls).toHaveLength(2);
    now += 1000;
    expect((await c.fetchSubscriptions({ stateClient: stateClient() })).threads).toHaveLength(2);
    expect(polls).toHaveLength(4);
    expect(polls[2].headers['If-Modified-Since']).toBe('Mon, 26 Oct 2026 00:00:00 GMT');
    expect(polls[2].headers['If-None-Match']).toBeUndefined();
    now += 61000;
    await c.fetchSubscriptions({ stateClient: stateClient() });
    expect(polls).toHaveLength(4);
  } finally { clock.mockRestore(); }
});

test('unsubscribe validates IDs, accepts empty 204, invalidates subscription cache and propagates failure', async () => {
  const requests = [];
  let deleted = false;
  const c = client(async (url, init) => {
    requests.push({ url, init });
    if (init.method === 'DELETE') {
      if (url.includes('/2/')) return json({}, 403);
      deleted = true;
      return new Response(null, { status: 204 });
    }
    if (url.includes('/subscription')) return deleted ? json({}, 404) : json({ subscribed: true }, 200, { ETag: '"subscription"' });
    return json([notification(1)]);
  });
  await c.fetchSubscriptions({ stateClient: stateClient() });
  await expect(c.unsubscribe('../1')).rejects.toThrow();
  await c.unsubscribe('1');
  expect((await c.fetchSubscriptions({ stateClient: stateClient() })).threads).toEqual([]);
  const checks = requests.filter(({ url, init }) => url.endsWith('/subscription') && init.method !== 'DELETE');
  expect(checks.at(-1).init.headers['If-None-Match']).toBeUndefined();
  await expect(c.unsubscribe('2')).rejects.toMatchObject({ status: 403 });
  expect(requests.filter(({ init }) => init.method === 'DELETE').map(({ url }) => url)).toEqual([
    `${API}/notifications/threads/1/subscription`, `${API}/notifications/threads/2/subscription`,
  ]);
});

test('summary hides only closures strictly older than seven days and counts visible unread', () => {
  const now = new Date('2026-10-27T12:00:00.000Z');
  const rows = [
    { id: 'boundary', state: 'CLOSED', closedAt: '2026-10-20T12:00:00.000Z', unread: true },
    { id: 'old', state: 'CLOSED', closedAt: '2026-10-20T11:59:59.999Z', unread: true },
    { id: 'merged', state: 'MERGED', mergedAt: '2026-10-20T11:59:59.999Z', unread: true },
    { id: 'recent-merge', state: 'MERGED', closedAt: '2026-10-27T00:00:00Z', unread: false },
    { id: 'reopened', state: 'OPEN', closedAt: '2020-01-01T00:00:00Z', unread: true },
    { id: 'unknown-date', state: 'CLOSED', closedAt: null, unread: true },
    { id: 'unknown-state', state: null, closedAt: '2020-01-01T00:00:00Z', unread: false },
    { id: 'invalid-date', state: 'CLOSED', closedAt: 'invalid', unread: false },
  ];
  expect(dashboard.summarizeSubscriptions).toBeFunction();
  const result = dashboard.summarizeSubscriptions(rows, { now });
  expect(result.items.map((r) => r.id)).toEqual(['boundary', 'recent-merge', 'reopened', 'unknown-date', 'unknown-state', 'invalid-date']);
  expect(result.unread).toBe(3);
  expect(result.hidden).toBe(2);
  expect(rows).toHaveLength(8);
});
