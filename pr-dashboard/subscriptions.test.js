import { expect, test, spyOn } from 'bun:test';
import { createGitHubClient } from './github.js';
import { createLogger } from './log.js';
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
    return json([notification(1)], 200, { Link: `<${API}/notifications?all=true&participating=true&per_page=100&page=2>; rel="next"` });
  });
  const result = await c.fetchSubscriptions({ excludeOwners: ['me'], stateClient: stateClient({ repo2: { closed: true, closedAt: '2026-10-25T00:00:00Z' } }) });
  expect(result.threads.map((t) => t.id)).toEqual(['1', '2', '3']);
  expect(result.threads[0]).toEqual({ id: '1', url: 'https://github.com/other/project/issues/1', repo: 'other/project', owner: 'other', number: 1, title: 'Subject 1', type: 'Issue', authored: false, unread: true, updatedAt: '2026-10-26T00:00:00Z', subscribed: true, state: 'OPEN', closedAt: null, mergedAt: null });
  expect(result.threads[2].state).toBe('CLOSED');
  expect(result.warnings).toEqual([]);
  expect(result.truncated).toBe(false);
  expect(requested.filter((url) => url.includes('/subscription'))).toHaveLength(3);
  expect(new URL(requested[0]).searchParams.get('all')).toBe('true');
  expect(new URL(requested[0]).searchParams.get('participating')).toBe('true');
  expect(new URL(requested[0]).searchParams.get('per_page')).toBe('100');
});

test('participation-filtered discovery reaches late manual candidates within the page budget', async () => {
  let pages = 0;
  const c = client(async (url) => {
    if (url.includes('/subscription')) return json({ subscribed: true });
    pages++;
    const params = new URL(url).searchParams;
    const page = Number(params.get('page') || 1);
    // Model the observed 364/8 versus 1536/31 feeds, including clamped short pages.
    const total = params.get('participating') === 'true' ? 364 : 1536;
    const last = Math.ceil(total / 50);
    const rows = Array.from({ length: Math.min(50, total - (page - 1) * 50) }, (_, i) =>
      notification((page - 1) * 50 + i + 1, 'Issue', { reason: 'mention' }));
    if (page === last) rows[rows.length - 1] = notification(9000);
    params.set('page', String(page + 1));
    return json(rows, 200, page < last ? { Link: `<${API}/notifications?${params}>; rel="next"` } : {});
  });
  const result = await c.fetchSubscriptions({ stateClient: stateClient() });
  expect(result.threads.map(({ id }) => id)).toEqual(['9000']);
  expect(result.truncated).toBe(false);
  expect(pages).toBe(8);
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

test('subscription lookup failures keep threads with unknown subscription next to confirmed old closures', async () => {
  const c = client(async (url) => {
    if (!url.includes('/subscription')) return json([notification(1), notification(2, 'PullRequest'), notification(3)]);
    const id = url.match(/threads\/(\d+)/)[1];
    return id === '1' ? json({}, 403) : id === '2' ? json({}, 503) : json({ subscribed: true });
  });
  const result = await c.fetchSubscriptions({ stateClient: stateClient({
    repo0: { state: 'CLOSED', closedAt: '2020-01-01T00:00:00Z' },
    repo1: { state: 'MERGED', mergedAt: '2020-01-01T00:00:00Z' },
    repo2: { state: 'CLOSED', closedAt: '2020-01-01T00:00:00Z' },
  }) });
  expect(result.threads.map(({ subscribed }) => subscribed)).toEqual([null, null, true]);
  expect(result.warnings).toHaveLength(2);
  const summary = dashboard.summarizeSubscriptions(result.threads);
  expect(summary.items.map(({ id }) => id)).toEqual(['1', '2', '3']);
  expect(summary.unread).toBe(3);
  expect(summary.hidden).toBe(0);
});

test('caps discovery at ten pages and thirty candidate subjects with explicit truncation', async () => {
  let pages = 0;
  const paged = client(async () => {
    pages++;
    return json([], 200, { Link: `<${API}/notifications?all=true&participating=true&page=${pages + 1}>; rel="next"` });
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
  const logs = [];
  const logger = createLogger({ level: 'warn', write: (line) => logs.push(JSON.parse(line)) });
  const inaccessible = createGitHubClient({ token: 'viewer', logger, fetchImpl: async () => json({ data: { repo0: null }, errors: [{ message: 'not accessible' }] }) });
  const result = await c.fetchSubscriptions({ stateClient: inaccessible });
  expect(result.threads[0].state).toBeNull();
  expect(result.warnings.length).toBeGreaterThan(0);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({
    level: 'warn', msg: 'GitHub returned partial data', operation: 'subscription-subjects',
    graphqlErrors: [{ message: 'not accessible' }],
  });
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
        ...(url.includes('page=2') ? {} : { Link: `<${API}/notifications?all=true&participating=true&page=2>; rel="next"` }),
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

test('summary keeps every item in the given order and counts unread', () => {
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
  const result = dashboard.summarizeSubscriptions(rows);
  expect(result.items).toEqual(rows);
  expect(result.unread).toBe(5);
  expect(result.hidden).toBe(0);
  expect(rows).toHaveLength(8);
});

const authoredNode = (repo, number, viewerSubscription = 'SUBSCRIBED') => ({
  number, title: `Authored ${number}`, updatedAt: '2026-10-27T00:00:00Z', viewerSubscription, repository: { nameWithOwner: repo },
});
const authoredClient = (data, seen = []) => createGitHubClient({ token: 'test-viewer', fetchImpl: async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  if (!query.includes('search(')) return json({ data: await stateClient().graphql('subscription-subjects', query) });
  seen.push(variables);
  if (data instanceof Error) return json({ message: data.message }, 502);
  return json({ data });
} });

test('author-reason notifications for issues and discussions are tracked, authored pull requests are not', async () => {
  const c = client(async (url) => {
    if (url.includes('/subscription')) return json({ subscribed: true });
    return json([
      notification(1, 'Issue', { reason: 'author' }), notification(2, 'Discussion', { reason: 'author' }),
      notification(3, 'PullRequest', { reason: 'author' }), notification(4),
    ]);
  });
  const result = await c.fetchSubscriptions({ stateClient: stateClient() });
  expect(result.threads.map(({ id, authored }) => [id, authored])).toEqual([['1', true], ['2', true], ['4', false]]);
});

test('authored open issues and discussions are added once, skipping unsubscribed, ignored and own-owner subjects', async () => {
  const c = client(async (url) => {
    if (url.endsWith('/threads/7/subscription')) return json({ subscribed: false });
    if (url.includes('/subscription')) return json({ subscribed: true });
    return json([notification(5, 'Issue', { reason: 'author' }), notification(7, 'Issue', { reason: 'author' })]);
  });
  const seen = [];
  const viewerClient = authoredClient({
    issues: { issueCount: 5, nodes: [
      authoredNode('other/project', 5), authoredNode('other/project', 7), authoredNode('upstream/tool', 8),
      authoredNode('upstream/tool', 9, 'UNSUBSCRIBED'), authoredNode('ME/project', 10),
    ] },
    discussions: { discussionCount: 3, nodes: [
      authoredNode('upstream/tool', 11, null), authoredNode('upstream/tool', 12, 'IGNORED'), {},
    ] },
  }, seen);
  const result = await c.fetchSubscriptions({ excludeOwners: ['me'], stateClient: viewerClient, viewer: 'octo' });
  expect(seen).toEqual([{
    issues: 'is:issue archived:false author:octo is:open -user:me',
    discussions: 'author:octo is:open -user:me',
  }]);
  expect(result.threads.map(({ id, url }) => [id, url])).toEqual([
    ['5', 'https://github.com/other/project/issues/5'],
    [null, 'https://github.com/upstream/tool/issues/8'],
    [null, 'https://github.com/upstream/tool/discussions/11'],
  ]);
  expect(result.threads[1]).toEqual({
    id: null, url: 'https://github.com/upstream/tool/issues/8', repo: 'upstream/tool', owner: 'upstream', number: 8,
    title: 'Authored 8', type: 'Issue', authored: true, unread: false, updatedAt: '2026-10-27T00:00:00Z',
    subscribed: true, state: 'OPEN', closedAt: null, mergedAt: null,
  });
  expect(result.threads[2].subscribed).toBeNull();
  expect(result.warnings).toEqual([]);
  expect(result.truncated).toBe(false);
});

test('authored discovery reports truncation and degrades to a warning on failure', async () => {
  const feed = () => client(async (url) => url.includes('/subscription') ? json({ subscribed: true }) : json([notification(1)]));
  const many = { issues: { issueCount: 51, nodes: [] }, discussions: { discussionCount: 0, nodes: [] } };
  const truncated = await feed().fetchSubscriptions({ stateClient: authoredClient(many), viewer: 'octo' });
  expect(truncated.truncated).toBe(true);
  expect(truncated.warnings).toEqual(['Authored issue and discussion discovery truncated at 50 each.']);

  const failed = await feed().fetchSubscriptions({ stateClient: authoredClient(new Error('boom')), viewer: 'octo' });
  expect(failed.threads.map(({ id }) => id)).toEqual(['1']);
  expect(failed.warnings).toHaveLength(1);
  expect(failed.warnings[0]).toStartWith('Authored issues and discussions unavailable:');

  const missing = await feed().fetchSubscriptions({ viewer: 'octo' });
  expect(missing.warnings.at(-1)).toBe('Authored issues and discussions unavailable: Viewer state client unavailable');
});

const tracked = (repo, number, type = 'Issue') => ({ url: `https://github.com/${repo}/${type === 'Issue' ? 'issues' : 'discussions'}/${number}`, owner: repo.split('/')[0], repo, type, number });
const trackedClient = (resolve, queries = []) => createGitHubClient({ token: 'test-viewer', fetchImpl: async (_url, init) => {
  const { query } = JSON.parse(init.body);
  queries.push(query);
  const data = {};
  for (const m of query.matchAll(/(repo\d+): repository\(owner: ("[^"]*"), name: ("[^"]*")\) \{ subject: (issue|discussion)\(number: (\d+)\)/g)) {
    data[m[1]] = resolve(`${JSON.parse(m[2])}/${JSON.parse(m[3])}`, Number(m[5]), m[4]);
  }
  return json({ data });
} });
const unknownSubject = { title: null, updatedAt: null, state: null, closedAt: null, subscribed: null };

test('tracked subjects are looked up in batches with per-type fields', async () => {
  const queries = [];
  const entries = Array.from({ length: 7 }, (_, i) => tracked('up/stream', i + 1, i % 2 ? 'Discussion' : 'Issue'));
  const c = trackedClient(() => ({ subject: { title: 't', updatedAt: '2026-10-01T00:00:00Z', state: 'OPEN', closed: false, closedAt: null, viewerSubscription: 'SUBSCRIBED' } }), queries);
  const result = await c.fetchTrackedSubjects(entries);
  expect(queries).toHaveLength(2);
  expect(queries[0]).toContain('issue(number: 1) { title updatedAt state closedAt viewerSubscription }');
  expect(queries[0]).toContain('discussion(number: 2) { title updatedAt closed closedAt viewerSubscription }');
  expect(queries[0]).toContain('repo5:');
  expect(queries[0]).not.toContain('repo6:');
  expect(queries[1].match(/repository\(/g)).toHaveLength(1);
  expect(result.subjects.size).toBe(7);
  expect(result.warnings).toEqual([]);
});

test('tracked subjects normalise state and subscription for issues and discussions', async () => {
  const entries = [tracked('a/b', 1), tracked('a/b', 2), tracked('a/b', 3, 'Discussion'), tracked('a/b', 4, 'Discussion'), tracked('a/b', 5), tracked('a/b', 6)];
  const nodes = {
    1: { state: 'OPEN', viewerSubscription: 'SUBSCRIBED' },
    2: { state: 'CLOSED', closedAt: '2026-10-02T00:00:00Z', viewerSubscription: 'UNSUBSCRIBED' },
    3: { closed: false, viewerSubscription: 'IGNORED' },
    4: { closed: true, closedAt: '2026-10-03T00:00:00Z', viewerSubscription: 'SUBSCRIBED' },
    5: { state: 'OPEN', viewerSubscription: 'SOMETHING_ELSE' },
    6: { state: 'OPEN' },
  };
  const c = trackedClient((_repo, number) => ({ subject: { title: `T${number}`, updatedAt: '2026-10-01T00:00:00Z', closedAt: null, ...nodes[number] } }));
  const { subjects } = await c.fetchTrackedSubjects(entries);
  const view = (n, type) => subjects.get(tracked('a/b', n, type).url);
  expect([view(1).state, view(1).subscribed]).toEqual(['OPEN', true]);
  expect([view(2).state, view(2).subscribed, view(2).closedAt]).toEqual(['CLOSED', false, '2026-10-02T00:00:00Z']);
  expect([view(3, 'Discussion').state, view(3, 'Discussion').subscribed]).toEqual(['OPEN', false]);
  expect([view(4, 'Discussion').state, view(4, 'Discussion').subscribed]).toEqual(['CLOSED', true]);
  expect(view(5).subscribed).toBeNull();
  expect(view(6).subscribed).toBeNull();
  expect(view(1)).toMatchObject({ title: 'T1', updatedAt: '2026-10-01T00:00:00Z' });
});

test('tracked subjects that come back null stay in the map as unknown with a warning', async () => {
  const entries = [tracked('a/b', 1), tracked('gone/repo', 2)];
  const c = trackedClient((repo) => (repo === 'a/b' ? { subject: null } : null));
  const { subjects, warnings } = await c.fetchTrackedSubjects(entries);
  expect(subjects.get(entries[0].url)).toEqual(unknownSubject);
  expect(subjects.get(entries[1].url)).toEqual(unknownSubject);
  expect(warnings).toHaveLength(2);
  expect(warnings).toEqual(['Tracked subject a/b#1 unavailable.', 'Tracked subject gone/repo#2 unavailable.']);
});

test('invalid tracked entries are skipped with a warning and never queried', async () => {
  const queries = [];
  const good = tracked('a/b', 1);
  const entries = [
    good, tracked('a/b', 0), tracked('a/b', 1.5), tracked('a/b', 2, 'PullRequest'),
    { ...tracked('a/b', 3), owner: 'a"b' }, { ...tracked('x/y"z', 4), owner: 'x' },
  ];
  const labels = ['a/b#0', 'a/b#1.5', 'a/b#2', 'a/b#3', 'x/y"z#4'];
  const c = trackedClient(() => ({ subject: { title: 't', updatedAt: null, state: 'OPEN', closedAt: null } }), queries);
  const { subjects, warnings } = await c.fetchTrackedSubjects(entries);
  expect([...subjects.keys()]).toEqual([good.url]);
  expect(warnings).toHaveLength(5);
  labels.forEach((label, i) => expect(warnings[i]).toContain(label));
  expect(queries).toHaveLength(1);
  expect(queries[0]).not.toContain('PullRequest');
  expect(queries[0].match(/repository\(/g)).toHaveLength(1);
});

test('a failing tracked batch leaves its entries out and other batches continue', async () => {
  let calls = 0;
  const c = createGitHubClient({ token: 'test-viewer', fetchImpl: async (_url, init) => {
    calls += 1;
    if (calls === 1) return json({ message: 'boom' }, 400);
    const { query } = JSON.parse(init.body);
    const data = {};
    for (const m of query.matchAll(/(repo\d+): repository/g)) data[m[1]] = { subject: { title: 'ok', updatedAt: null, state: 'OPEN', closedAt: null } };
    return json({ data });
  } });
  const entries = Array.from({ length: 7 }, (_, i) => tracked('a/b', i + 1));
  const { subjects, warnings } = await c.fetchTrackedSubjects(entries);
  expect([...subjects.keys()]).toEqual([entries[6].url]);
  expect(subjects.get(entries[6].url).title).toBe('ok');
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('400');
});

test('empty tracked input makes no request', async () => {
  let calls = 0;
  const c = createGitHubClient({ token: 'test-viewer', fetchImpl: async () => { calls += 1; return json({ data: {} }); } });
  const result = await c.fetchTrackedSubjects([]);
  expect(result.subjects.size).toBe(0);
  expect(result.warnings).toEqual([]);
  expect(calls).toBe(0);
});

test('tracked entries whose owner differs from the repo owner are skipped, case-insensitively otherwise accepted', async () => {
  const mismatch = { ...tracked('a/b', 1), owner: 'other' };
  const sameCase = { ...tracked('A/b', 2), owner: 'a' };
  const queries = [];
  const c = trackedClient(() => ({ subject: { title: 't', updatedAt: null, state: 'OPEN', closedAt: null } }), queries);
  const { subjects, warnings } = await c.fetchTrackedSubjects([mismatch, sameCase]);
  expect([...subjects.keys()]).toEqual([sameCase.url]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('a/b#1');
  expect(queries[0].match(/repository\(/g)).toHaveLength(1);
});

test('a tracked alias that is null alongside GraphQL errors stays unknown without throwing', async () => {
  const entry = tracked('a/b', 1);
  const c = createGitHubClient({ token: 'test-viewer', fetchImpl: async () => json({ data: { repo0: null }, errors: [{ message: 'x' }] }) });
  const { subjects, warnings } = await c.fetchTrackedSubjects([entry]);
  expect(subjects.get(entry.url)).toEqual(unknownSubject);
  expect(warnings).toEqual(['Tracked subject a/b#1 unavailable.']);
});
