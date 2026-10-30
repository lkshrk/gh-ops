import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const tabs = ['contributions', 'subscriptions', 'workflows', 'renovate'];
function fixture() {
  return {
    owners: ['me'], repoCount: 1, generatedAt: new Date().toISOString(), ownerErrors: [],
    contributions: { attention: [], open: [], closed: [] },
    subscriptions: { items: [], unread: 0, hidden: 0, canUnsubscribe: true, warnings: [], truncated: false, error: null },
    workflows: { failing: [], recent: [], failStreak: 3 },
    renovate: { repos: [], untracked: [], onboarding: [], stats: { windowDays: 7 } },
  };
}

// Only browser boundaries are doubled; all navigation/render/mutation code runs unchanged.
function client({ hash = '', stored = null, hiddenOwners = [], storageThrows = false, request, pollResponse } = {}) {
  const elements = new Map();
  const events = {};
  const windowEvents = {};
  const store = new Map([['dashboardTab', stored], ['hiddenOwners', JSON.stringify(hiddenOwners)]]);
  const calls = [];
  const historyEntries = [hash];
  let historyIndex = 0;
  const document = {
    activeElement: null,
    addEventListener: (name, handler) => { events[name] = handler; },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, {
        id, hidden: false, innerHTML: '', textContent: '', dataset: {}, attributes: {},
        setAttribute(key, value) { this.attributes[key] = String(value); },
        focus() { document.activeElement = this; },
        contains(element) { return this === element; },
        closest(selector) { return selector === '[role="tab"]' && this.id.startsWith('tab-') ? this : null; },
      });
      return elements.get(id);
    },
    querySelector: (selector) => document.getElementById(selector),
    querySelectorAll: () => [],
  };
  for (const tab of tabs) document.getElementById(`tab-${tab}`).dataset.tab = tab;
  const context = {
    document, setInterval() {},
    addEventListener: (name, handler) => { windowEvents[name] = handler; },
    location: { hash, reload() { context.reloads++; } }, reloads: 0,
    history: {
      pushState(_state, _unused, hash) {
        historyEntries.splice(++historyIndex, Infinity, hash);
        context.location.hash = hash;
      },
      replaceState(_state, _unused, hash) {
        historyEntries[historyIndex] = hash;
        context.location.hash = hash;
      },
      back() {
        if (historyIndex === 0) return;
        context.location.hash = historyEntries[--historyIndex];
        windowEvents.hashchange();
      },
      forward() {
        if (historyIndex === historyEntries.length - 1) return;
        context.location.hash = historyEntries[++historyIndex];
        windowEvents.hashchange();
      },
    },
    localStorage: {
      getItem(key) { if (storageThrows) throw Error('storage blocked'); return store.get(key) ?? null; },
      setItem(key, value) { if (storageThrows) throw Error('storage blocked'); store.set(key, value); },
    },
    sessionStorage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
    fetch: (url, options) => {
      calls.push({ url, options });
      return url === 'data.json' ? (pollResponse ? Promise.resolve(pollResponse) : new Promise(() => {})) : request(url, options);
    },
  };
  runInNewContext(readFileSync(new URL('./public/app.js', import.meta.url), 'utf8'), context);
  return { context, document, events, windowEvents, store, calls,
    show: (snapshot) => context.load(Promise.resolve({ ok: true, json: async () => snapshot })) };
}

test('contribution badges follow PR state regardless of review decision or comments', () => {
  const { context } = client();

  for (const [state, label] of [['OPEN', 'Open'], ['MERGED', 'Merged'], ['CLOSED', 'Closed']]) {
    for (const reviewDecision of [null, 'APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']) {
      const html = context.contributionRow({
        state, reviewDecision, reasons: [], ci: 'none',
        comments: { nodes: [{ body: 'Approved' }] },
      });
      assert.match(html, new RegExp(`>${label}</span>`));
      assert.doesNotMatch(html, />Approved</);
    }
  }
});

test('Renovate rows label and link the last commit with its timestamp, and explain unknown history', async () => {
  const ui = client();
  await ui.show(fixture());
  const { context } = ui;
  const entry = { owner: 'me', name: 'app', hasConfig: true, open: [],
    lastMerged: { title: 'Wrong merge date', url: 'https://github.com/me/app/pull/1', mergedAt: new Date().toISOString() },
    lastCommit: { title: 'Update <dep>', url: 'https://github.com/me/app/commit/abc', committedDate: '2026-10-01T00:00:00Z' } };
  const html = context.renovateRow(entry);
  assert.match(html, /last Renovate commit/);
  assert.match(html, /href="https:\/\/github.com\/me\/app\/commit\/abc"/);
  assert.match(html, /title="Last Renovate commit: 2026-10-01T00:00:00Z"/);
  assert.match(html, /Update &#60;dep&#62;/);
  assert.doesNotMatch(html, /Wrong merge date/);
  const unknown = context.renovateRow({ ...entry, lastCommit: null });
  assert.match(unknown, /unknown/);
  assert.match(unknown, /no known Renovate commit in the last 100 default-branch commits/);
  assert.doesNotMatch(unknown, /never|Wrong merge date/);
});

test('an expired session reloads once, then waits instead of looping', async () => {
  const { context } = client({ pollResponse: { type: 'opaqueredirect', ok: false, status: 0 } });

  // The top-level poll and two explicit polls hit the same expired session.
  await context.poll();
  await context.poll();
  assert.equal(context.reloads, 1);
});

test('a normal snapshot renders without reloading', async () => {
  const { context } = client({ pollResponse: { type: 'basic', ok: true, json: async () => fixture() } });

  await context.poll();
  assert.equal(context.reloads, 0);
});

test('contributions needing attention get a Done button, handled ones an Undo button', () => {
  const { context } = client();
  const base = { state: 'OPEN', url: 'https://github.com/up/stream/pull/1', ci: 'failure', reasons: ['ci-failing'] };

  assert.match(context.contributionRow({ ...base, done: false }), /data-done="true"[^>]*>Done</);
  const handled = context.contributionRow({ ...base, done: true });
  assert.match(handled, /data-done="false"[^>]*>Undo</);
  assert.match(handled, /chip muted">CI failing</);
  assert.doesNotMatch(context.contributionRow({ ...base, reasons: [], done: false }), /done-toggle/);
});

test('hash overrides storage, invalid selections fall back, and blocked storage is safe', () => {
  for (const [options, selected] of [
    [{ hash: '#subscriptions', stored: 'renovate' }, 'subscriptions'],
    [{ stored: 'renovate' }, 'renovate'],
    [{ hash: '#invalid', stored: 'renovate' }, 'contributions'],
    [{ stored: 'invalid' }, 'contributions'],
    [{ hash: '#workflows', storageThrows: true }, 'workflows'],
    [{ storageThrows: true }, 'contributions'],
  ]) {
    const { document } = client(options);
    for (const tab of tabs) {
      assert.equal(document.getElementById(tab).hidden, tab !== selected);
      assert.equal(document.getElementById(`tab-${tab}`).attributes['aria-selected'], String(tab === selected));
      assert.equal(document.getElementById(`tab-${tab}`).tabIndex, tab === selected ? 0 : -1);
    }
  }
});

test('keyboard navigation wraps, focuses tabs, persists and handles browser history without rerendering', async () => {
  const ui = client();
  await ui.show(fixture());
  const panel = ui.document.querySelector('#renovate .panel-body');
  panel.innerHTML = 'expanded details sentinel';
  function key(tab, key) {
    let prevented = false;
    ui.events.keydown({ target: ui.document.getElementById(`tab-${tab}`), key, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }
  key('contributions', 'ArrowLeft');
  assert.equal(ui.context.location.hash, '#renovate');
  assert.equal(ui.store.get('dashboardTab'), 'renovate');
  assert.equal(ui.document.activeElement.id, 'tab-renovate');
  key('renovate', 'ArrowRight');
  key('contributions', 'End');
  key('renovate', 'Home');
  for (const hash of ['#subscriptions', '#workflows', '#invalid']) {
    ui.context.location.hash = hash;
    ui.windowEvents.hashchange();
    assert.equal(ui.document.getElementById(hash === '#invalid' ? 'contributions' : hash.slice(1)).hidden, false);
  }
  assert.equal(panel.innerHTML, 'expanded details sentinel');
  await ui.show(fixture());
  assert.equal(ui.document.getElementById('contributions').hidden, false);
});

test('old hidden owners cannot hide workflows, Renovate rows or counts, and polls keep selection', async () => {
  const ui = client({ hash: '#subscriptions', hiddenOwners: ['me', 'org'] });
  const snapshot = fixture();
  snapshot.owners = ['me', 'org'];
  snapshot.subscriptions.items = [{ title: 'subscription', id: '1', subscribed: true, unread: true }];
  snapshot.subscriptions.unread = 1;
  snapshot.contributions.closed = [{ title: 'closed', state: 'CLOSED', reasons: [] }];
  for (const owner of snapshot.owners) {
    const repo = { owner, name: `${owner}-repo`, repo: `${owner}/${owner}-repo` };
    const workflow = { ...repo, workflow: `${owner}-CI`, latestRun: {}, runs: [], streak: 3 };
    snapshot.workflows.failing.push(workflow);
    snapshot.workflows.recent.push({ ...workflow, workflow: `${owner}-recent` });
    snapshot.renovate.repos.push({ ...repo, open: [], recentlyMerged: { automerged: 1, manual: 0 } });
    snapshot.renovate.untracked.push({ ...repo, name: `${owner}-untracked` });
    snapshot.renovate.onboarding.push({ ...repo, pullRequest: { title: `${owner}-onboarding` } });
  }
  for (let refresh = 0; refresh < 2; refresh++) {
    await ui.show(snapshot);
    for (const [tab, count] of Object.entries({ contributions: 1, subscriptions: 1, workflows: 4, renovate: 6 })) {
      assert.equal(ui.document.getElementById(`count-${tab}`).textContent, count);
    }
    const workflows = ui.document.querySelector('#workflows .panel-body').innerHTML;
    const renovate = ui.document.querySelector('#renovate .panel-body').innerHTML;
    for (const owner of snapshot.owners) {
      for (const suffix of ['CI', 'recent']) assert.ok(workflows.includes(`${owner}-${suffix}`));
      for (const suffix of ['repo', 'untracked', 'onboarding']) assert.ok(renovate.includes(`${owner}-${suffix}`));
    }
    for (const html of [workflows, renovate]) {
      assert.match(html, /owner-dot o0/);
      assert.match(html, /owner-dot o1/);
    }
    const kpis = ui.document.getElementById('kpis').innerHTML;
    assert.equal((kpis.match(/class="kpi /g) || []).length, 4);
    assert.match(kpis, /class="bad">2<\/span>/);
    assert.match(kpis, /2 more failed recently/);
    assert.match(kpis, /class="good">2<\/span>/);
    assert.equal(ui.document.getElementById('subscriptions').hidden, false);
  }
});

test('subscriptions escape text and show type/state/unread, warnings and unavailable states', async () => {
  const ui = client();
  const snapshot = fixture();
  snapshot.subscriptions = { ...snapshot.subscriptions, canUnsubscribe: false, error: '<error>', warnings: ['<lookup>'], truncated: true, hidden: 2,
    items: [
      { url: 'https://github.com/up/repo/issues/1', repo: '<repo>', title: '<title>', type: 'Issue', state: 'OPEN', unread: true, id: '1', subscribed: true, updatedAt: new Date().toISOString() },
      { title: 'PR', type: 'PullRequest', state: 'MERGED', id: '1', subscribed: true },
      { title: 'Discussion', type: 'Discussion', state: null, subscribed: null },
    ] };
  await ui.show(snapshot);
  const html = ui.document.querySelector('#subscriptions .panel-body').innerHTML;
  for (const value of ['&#60;title&#62;', '&#60;repo&#62;', '&#60;error&#62;', '&#60;lookup&#62;', 'Issue', 'Pull request', 'Discussion', 'State: Open', 'State: Merged', 'Unknown state', 'Unread', 'Unknown', 'truncated']) assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /<title>|<error>|<lookup>/);
  assert.equal((html.match(/class="remove"/g) || []).length, 3);
  assert.equal((html.match(/aria-label="Remove from watchlist"/g) || []).length, 3);
  snapshot.subscriptions = { ...snapshot.subscriptions, error: null, items: [] };
  await ui.show(snapshot);
  assert.match(ui.document.querySelector('#subscriptions .panel-body').innerHTML, /unavailable/i);
});

test('authored subscriptions are labelled and offer unsubscribing only with a notification thread', async () => {
  const ui = client();
  const snapshot = fixture();
  snapshot.subscriptions.items = [
    { title: 'with thread', url: 'https://github.com/up/repo/issues/1', type: 'Issue', state: 'OPEN', authored: true, id: '1', subscribed: true },
    { title: 'search only', url: 'https://github.com/up/repo/discussions/2', type: 'Discussion', state: 'OPEN', authored: true, id: null, subscribed: true },
  ];
  await ui.show(snapshot);
  const html = ui.document.querySelector('#subscriptions .panel-body').innerHTML;
  assert.equal((html.match(/Opened by you/g) || []).length, 2);
  assert.equal((html.match(/class="remove"/g) || []).length, 2);
  assert.equal((html.match(/aria-label="Remove from watchlist and unsubscribe" title="Remove from watchlist and unsubscribe"/g) || []).length, 1);
  assert.equal((html.match(/aria-label="Remove from watchlist" title="Remove from watchlist"/g) || []).length, 1);
  assert.match(html, /data-url="https:\/\/github.com\/up\/repo\/issues\/1"/);
  assert.match(html, /<svg[^>]*aria-hidden="true"/);
});

test('remove posts once, disables immediately, renders success and preserves selection', async () => {
  let resolve;
  const ui = client({ hash: '#subscriptions', request: () => new Promise((done) => { resolve = done; }) });
  const snapshot = fixture();
  const button = { disabled: false, dataset: { url: 'https://github.com/up/repo/issues/1' } };
  const pending = ui.context.removeWatched(button);
  assert.equal(button.disabled, true);
  await ui.context.removeWatched(button);
  assert.equal(ui.calls.filter((call) => call.url !== 'data.json').length, 1);
  const call = ui.calls.at(-1);
  assert.equal(call.url, 'subscriptions/remove');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.redirect, 'manual');
  assert.equal(call.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(call.options.body), { url: button.dataset.url });
  resolve({ ok: true, json: async () => snapshot });
  await pending;
  assert.equal(ui.document.getElementById('count-subscriptions').textContent, 0);
  assert.equal(ui.document.getElementById('subscriptions').hidden, false);
});

test('discovery error retains stale rows and drops the unsubscribe wording until recovery', async () => {
  const ui = client();
  const snapshot = fixture();
  snapshot.subscriptions.items = [{ title: 'retained thread', id: '1', subscribed: true }];
  for (const error of [null, 'notifications denied', null]) {
    snapshot.subscriptions.error = error;
    snapshot.subscriptions.canUnsubscribe = !error;
    await ui.show(snapshot);
    const html = ui.document.querySelector('#subscriptions .panel-body').innerHTML;
    assert.match(html, /retained thread/);
    assert.ok(html.includes('class="remove"'));
    assert.equal(html.includes('and unsubscribe'), !error);
    if (error) {
      assert.match(html, /notifications denied.*Showing previously fetched subscriptions/);
      assert.doesNotMatch(html, /not configured/);
    }
  }
});

for (const actions of [['removeWatched', 'removeWatched'], ['setDone', 'removeWatched'], ['removeWatched', 'setDone']]) {
  test(`mutations serialize through response application: ${actions.join(' then ')}`, async () => {
    const initial = fixture();
    initial.subscriptions.items = [1, 2].map((number) => ({
      title: `thread ${number}`, url: `https://github.com/up/repo/issues/${number}`, id: '1', subscribed: true,
    }));
    initial.contributions.attention = [{ title: 'PR', url: 'https://github.com/up/repo/pull/3', state: 'OPEN', reasons: ['ci-failing'] }];
    let current = structuredClone(initial);
    let release;
    const delayedBody = new Promise((resolve) => { release = resolve; });
    let requests = 0;
    const ui = client({ request: async (url, options) => {
      requests++;
      if (requests === 2) {
        // The first response must be rendered before the next request even starts.
        assert.equal(ui.document.getElementById('count-subscriptions').textContent, current.subscriptions.items.length);
        assert.equal(ui.document.querySelector('#contributions .panel-body').innerHTML.includes('>Undo<'), current.contributions.open.length > 0);
      }
      const body = JSON.parse(options.body);
      if (url === 'subscriptions/remove') current.subscriptions.items = current.subscriptions.items.filter((item) => item.url !== body.url);
      else {
        current.contributions.open = current.contributions.attention.map((pr) => ({ ...pr, done: true }));
        current.contributions.attention = [];
      }
      const snapshot = structuredClone(current);
      return { ok: true, json: () => requests === 1 ? delayedBody.then(() => snapshot) : Promise.resolve(snapshot) };
    } });
    await ui.show(initial);
    const pending = actions.map((action, index) => ui.context[action]({ disabled: false, dataset: {
      url: action === 'removeWatched' ? initial.subscriptions.items[index].url : initial.contributions.attention[0].url, done: 'true',
    } }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 1, 'later mutation must wait even while the first body is parsing');
    release();
    await Promise.all(pending);
    assert.equal(requests, 2);
    const html = ui.document.querySelector('#subscriptions .panel-body').innerHTML;
    for (const [index, action] of actions.entries()) if (action === 'removeWatched') assert.ok(!html.includes(`thread ${index + 1}`));
    assert.equal(ui.document.getElementById('count-subscriptions').textContent, actions.includes('setDone') ? 1 : 0);
    if (actions.includes('setDone')) assert.match(ui.document.querySelector('#contributions .panel-body').innerHTML, />Undo</);
  });
}

test('a failed mutation does not block a queued action', async () => {
  let requests = 0;
  const ui = client({ request: async () => {
    if (++requests === 1) throw new Error('offline');
    return { ok: true, json: async () => fixture() };
  } });
  await ui.show(fixture());
  await Promise.all([
    ui.context.setDone({ dataset: { url: 'https://github.com/up/repo/pull/1', done: 'true' } }),
    ui.context.removeWatched({ dataset: { url: 'https://github.com/up/repo/issues/2' } }),
  ]);
  assert.equal(requests, 2);
  assert.equal(ui.document.getElementById('banner').hidden, true);
});

test('remove errors preserve rows and auth redirect reloads without retrying mutation', async () => {
  for (const response of [{ ok: false, json: async () => ({ error: 'denied' }) }, { type: 'opaqueredirect' }]) {
    const ui = client({ request: async () => response });
    await ui.show(fixture());
    const panel = ui.document.querySelector('#subscriptions .panel-body');
    panel.innerHTML = 'existing row';
    const button = { disabled: false, dataset: { url: 'https://github.com/up/repo/issues/1' } };
    await ui.context.removeWatched(button);
    assert.equal(panel.innerHTML, 'existing row');
    assert.equal(button.disabled, false);
    assert.equal(ui.document.getElementById('banner').hidden, false);
    assert.match(ui.document.getElementById('banner').textContent, /Could not remove/);
    assert.equal(ui.calls.filter((call) => call.url !== 'data.json').length, 1);
    assert.equal(ui.context.reloads, response.type ? 1 : 0);
  }
});

test('a poll cannot re-enable a pending removal or allow a second mutation', async () => {
  let resolve;
  const ui = client({ request: () => new Promise((done) => { resolve = done; }) });
  const snapshot = fixture();
  snapshot.subscriptions.items = [{ title: 'thread', url: 'https://github.com/up/repo/issues/1', id: '1', subscribed: true }];
  await ui.show(snapshot);
  const button = { disabled: false, dataset: { url: snapshot.subscriptions.items[0].url } };
  const pending = ui.context.removeWatched(button);
  await ui.show(snapshot);
  assert.match(ui.document.querySelector('#subscriptions .panel-body').innerHTML, /class="remove"[^>]* disabled/);
  await ui.context.removeWatched({ ...button, disabled: false });
  assert.equal(ui.calls.filter((call) => call.url !== 'data.json').length, 1);
  resolve({ ok: false, json: async () => ({ error: 'denied' }) });
  await pending;
});

test('history navigation moves focused tabs or hidden panel focus to the selected tab', () => {
  const ui = client({ hash: '#renovate' });
  ui.document.getElementById('tab-renovate').focus();
  ui.context.location.hash = '#subscriptions';
  ui.windowEvents.hashchange();
  assert.equal(ui.document.activeElement.id, 'tab-subscriptions');
  ui.document.getElementById('subscriptions').focus();
  ui.context.location.hash = '#workflows';
  ui.windowEvents.hashchange();
  assert.equal(ui.document.activeElement.id, 'tab-workflows');
});

test('Back and Forward restore a hashless initial storage-selected tab without an extra entry', () => {
  const ui = client({ stored: 'renovate' });
  assert.equal(ui.document.getElementById('renovate').hidden, false);
  ui.events.click({ target: ui.document.getElementById('tab-subscriptions') });
  assert.equal(ui.document.getElementById('subscriptions').hidden, false);
  ui.context.history.back();
  assert.equal(ui.document.getElementById('renovate').hidden, false);
  assert.equal(ui.store.get('dashboardTab'), 'renovate');
  ui.context.history.back();
  assert.equal(ui.document.getElementById('renovate').hidden, false);
  ui.context.history.forward();
  assert.equal(ui.document.getElementById('subscriptions').hidden, false);
  assert.equal(ui.store.get('dashboardTab'), 'subscriptions');
});

test('a delayed pre-removal poll cannot restore a removed row or overwrite the successful snapshot', async () => {
  // Cover a response arriving late and a body still parsing when the mutation succeeds.
  for (const delayBody of [false, true]) {
    const fresh = fixture();
    fresh.repoCount = 2;
    const ui = client({ request: async () => ({ ok: true, json: async () => fresh }) });
    const old = fixture();
    old.subscriptions.items = [{ title: 'removed thread', url: 'https://github.com/up/repo/issues/1', id: '1', subscribed: true }];
    await ui.show(old);
    let release;
    const delayed = new Promise((resolve) => { release = resolve; });
    ui.context.fetch = () => delayBody ? Promise.resolve({ ok: true, json: () => delayed }) : delayed;
    const polling = ui.context.poll();
    await Promise.resolve();
    ui.context.fetch = async () => ({ ok: true, json: async () => fresh });
    await ui.context.removeWatched({ disabled: false, dataset: { url: old.subscriptions.items[0].url } });
    assert.equal(ui.document.getElementById('count-subscriptions').textContent, 0);
    release(delayBody ? old : { ok: true, json: async () => old });
    await polling;
    assert.equal(ui.document.getElementById('count-subscriptions').textContent, 0);
    assert.doesNotMatch(ui.document.querySelector('#subscriptions .panel-body').innerHTML, /removed thread/);
    assert.match(ui.document.getElementById('freshness').textContent, /^2 repos/);
    // Subsequent polls must still update normally.
    ui.context.fetch = async () => ({ ok: true, json: async () => ({ ...fresh, repoCount: 3 }) });
    await ui.context.poll();
    assert.match(ui.document.getElementById('freshness').textContent, /^3 repos/);
  }
});

const openItem = { title: 'open thread', url: 'https://github.com/up/repo/issues/1', repo: 'up/repo', number: 1, type: 'Issue', state: 'OPEN', unread: true, id: '1', subscribed: true, updatedAt: '2026-10-27T00:00:00Z' };
const closedItem = { ...openItem, title: 'closed thread', url: 'https://github.com/up/repo/issues/2', number: 2, state: 'CLOSED' };

function titleEvent(item, extra = {}) {
  const link = { getAttribute: (name) => (name === 'href' ? item.url : null) };
  let prevented = 0;
  return { event: { target: { closest: (selector) => (selector === '#subscriptions a.title' ? link : null) }, button: 0, preventDefault() { prevented++; }, ...extra }, prevented: () => prevented };
}

test('a title click acknowledges with keepalive, never blocks navigation and reads an open row optimistically', async () => {
  let resolve;
  const ui = client({ request: () => new Promise((done) => { resolve = done; }) });
  const snapshot = fixture();
  snapshot.subscriptions.items = [openItem, closedItem];
  snapshot.subscriptions.unread = 2;
  await ui.show(snapshot);
  const click = titleEvent(openItem);
  ui.events.click(click.event);
  assert.equal(click.prevented(), 0);
  const call = ui.calls.at(-1);
  assert.equal(call.url, 'subscriptions/acknowledge');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.keepalive, true);
  assert.equal(call.options.redirect, 'manual');
  assert.equal(call.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(call.options.body), { url: openItem.url });
  const html = ui.document.querySelector('#subscriptions .panel-body').innerHTML;
  assert.match(html, /open thread/);
  assert.equal((html.match(/chip warn">Unread</g) || []).length, 1);
  assert.match(ui.document.getElementById('kpis').innerHTML, /1 unread/);
  const server = fixture();
  server.subscriptions.items = [{ ...openItem, unread: false }, { ...closedItem, unread: false }];
  resolve({ ok: true, json: async () => server });
  await new Promise((done) => setImmediate(done));
  assert.equal((ui.document.querySelector('#subscriptions .panel-body').innerHTML.match(/Unread</g) || []).length, 0);
});

test('a title click on a closed row removes it optimistically, and middle-click also acknowledges', async () => {
  const ui = client({ request: () => new Promise(() => {}) });
  const snapshot = fixture();
  snapshot.subscriptions.items = [openItem, closedItem];
  snapshot.subscriptions.unread = 2;
  await ui.show(snapshot);
  const click = titleEvent(closedItem);
  ui.events.click(click.event);
  assert.equal(click.prevented(), 0);
  assert.doesNotMatch(ui.document.querySelector('#subscriptions .panel-body').innerHTML, /closed thread/);
  assert.equal(ui.document.getElementById('count-subscriptions').textContent, 1);
  const middle = titleEvent(openItem, { button: 1 });
  ui.events.auxclick(middle.event);
  assert.equal(middle.prevented(), 0);
  assert.equal(ui.calls.filter((call) => call.url === 'subscriptions/acknowledge').length, 2);
  ui.events.auxclick(titleEvent(openItem, { button: 2 }).event);
  assert.equal(ui.calls.filter((call) => call.url === 'subscriptions/acknowledge').length, 2);
});

test('a failed acknowledgement stays silent', async () => {
  const ui = client({ request: async () => ({ ok: false, json: async () => ({ error: 'denied' }) }) });
  const snapshot = fixture();
  snapshot.subscriptions.items = [openItem];
  await ui.show(snapshot);
  ui.events.click(titleEvent(openItem).event);
  await new Promise((done) => setImmediate(done));
  assert.equal(ui.document.getElementById('banner').hidden, true);
});

test('subscription rows use the standard row markup with a state chip and no transition copy', async () => {
  const ui = client();
  const snapshot = fixture();
  snapshot.subscriptions.items = [openItem, closedItem];
  await ui.show(snapshot);
  const html = ui.document.querySelector('#subscriptions .panel-body').innerHTML;
  assert.equal((html.match(/<ul class="rows">/g) || []).length, 1);
  assert.equal((html.match(/<li class="row">/g) || []).length, 2);
  for (const part of ['row-main', 'class="title" href="https://github.com/up/repo/issues/1"', 'class="meta"', 'class="age"', 'chip good">State: Open<', 'chip muted">State: Closed<']) assert.ok(html.includes(part), part);
  assert.doesNotMatch(html, /→|target=/);
});
