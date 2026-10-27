import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('contribution badges follow PR state regardless of review decision or comments', () => {
  const source = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
  const context = {
    document: { addEventListener() {} },
    setInterval() {},
    fetch: () => new Promise(() => {}),
  };
  runInNewContext(source, context);

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

test('an expired session reloads once, then waits instead of looping', async () => {
  const source = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
  let reloads = 0;
  const store = new Map();
  const element = () => ({ hidden: true, textContent: '' });
  const context = {
    document: { addEventListener() {}, getElementById: element },
    setInterval() {},
    fetch: async () => ({ type: 'opaqueredirect', ok: false, status: 0 }),
    location: { reload: () => { reloads += 1; } },
    sessionStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
    },
  };
  runInNewContext(source, context);

  // The top-level poll and two explicit polls hit the same expired session.
  await context.poll();
  await context.poll();
  assert.equal(reloads, 1);
});

test('a normal snapshot renders without reloading', async () => {
  const source = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
  let reloads = 0;
  const snapshot = {
    owners: ['me'], repoCount: 1, generatedAt: new Date().toISOString(), ownerErrors: [],
    contributions: { attention: [], open: [], closed: [] },
    workflows: { failing: [], recent: [], failStreak: 3 },
    renovate: { repos: [], untracked: [], onboarding: [], stats: { windowDays: 7 } },
  };
  const context = {
    document: { addEventListener() {}, getElementById: () => ({ hidden: true, textContent: '' }), querySelector: () => ({}) },
    setInterval() {},
    fetch: async () => ({ type: 'basic', ok: true, json: async () => snapshot }),
    location: { reload: () => { reloads += 1; } },
    sessionStorage: { getItem: () => null, setItem() {} },
  };
  runInNewContext(source, context);

  await context.poll();
  assert.equal(reloads, 0);
});

test('contributions needing attention get a Done button, handled ones an Undo button', () => {
  const source = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
  const context = { document: { addEventListener() {} }, setInterval() {}, fetch: () => new Promise(() => {}) };
  runInNewContext(source, context);
  const base = { state: 'OPEN', url: 'https://github.com/up/stream/pull/1', ci: 'failure', reasons: ['ci-failing'] };

  assert.match(context.contributionRow({ ...base, done: false }), /data-done="true"[^>]*>Done</);
  const handled = context.contributionRow({ ...base, done: true });
  assert.match(handled, /data-done="false"[^>]*>Undo</);
  assert.match(handled, /chip muted">CI failing</);
  assert.doesNotMatch(context.contributionRow({ ...base, reasons: [], done: false }), /done-toggle/);
});
