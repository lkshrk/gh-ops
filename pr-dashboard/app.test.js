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
