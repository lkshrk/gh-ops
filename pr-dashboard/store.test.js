import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDashboardStore } from './store.js';

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pr-dashboard-store-'));
  const file = path.join(dir, 'state', 'dashboard.json');
  const errors = [];
  const logger = { error(message, fields) { errors.push({ message, fields }); } };
  return { dir, file, logger, errors };
}

test('dashboard store starts with empty done and watchlist state', () => {
  const { logger } = fixture();
  const store = createDashboardStore({ logger });

  assert.deepEqual(store.doneAll(), {});
  assert.deepEqual(store.watchlistAll(), {});
});

test('dashboard store persists done and watchlist entries when reopened', () => {
  const { dir, file, logger } = fixture();
  const store = createDashboardStore({ file, logger });
  store.setDone('https://github.com/acme/app/pull/1', { feedbackAt: null });
  store.setWatch('https://github.com/acme/app', { checkedAt: '2026-10-30T00:00:00Z' });

  const reopened = createDashboardStore({ file, logger });
  assert.deepEqual(reopened.doneAll(), { 'https://github.com/acme/app/pull/1': { feedbackAt: null } });
  assert.deepEqual(reopened.watchlistAll(), { 'https://github.com/acme/app': { checkedAt: '2026-10-30T00:00:00Z' } });
  rmSync(dir, { recursive: true });
});

test('dashboard store replaces watchlist without changing done entries', () => {
  const { dir, file, logger } = fixture();
  const store = createDashboardStore({ file, logger });
  store.setDone('done', { feedbackAt: null });
  store.setWatch('old', { watched: true });
  store.replaceWatch({ next: { watched: true } });

  assert.deepEqual(store.watchlistAll(), { next: { watched: true } });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    done: { done: { feedbackAt: null } },
    watchlist: { next: { watched: true } },
  });
  assert.equal(existsSync(`${file}.tmp`), false);
  rmSync(dir, { recursive: true });
});

test('dashboard store deletes and retains entries in their own sections', () => {
  const { dir, file, logger } = fixture();
  const store = createDashboardStore({ file, logger });
  store.setDone('keep', { feedbackAt: null });
  store.setDone('drop', { feedbackAt: null });
  store.setWatch('drop', { watched: true });
  store.retainDone((url) => url === 'keep');
  store.deleteWatch('drop');
  store.deleteDone('missing');

  assert.deepEqual(store.doneAll(), { keep: { feedbackAt: null } });
  assert.deepEqual(store.watchlistAll(), {});
  rmSync(dir, { recursive: true });
});

test('dashboard store starts empty for missing and malformed state files', () => {
  const missing = fixture();
  const emptyStore = createDashboardStore({ file: missing.file, logger: missing.logger });
  assert.deepEqual(emptyStore.doneAll(), {});
  assert.deepEqual(emptyStore.watchlistAll(), {});
  assert.deepEqual(missing.errors, []);
  rmSync(missing.dir, { recursive: true });

  const malformed = fixture();
  mkdirSync(path.dirname(malformed.file), { recursive: true });
  writeFileSync(malformed.file, '{not json');
  const malformedStore = createDashboardStore({ file: malformed.file, logger: malformed.logger });
  assert.deepEqual(malformedStore.doneAll(), {});
  assert.deepEqual(malformedStore.watchlistAll(), {});
  assert.equal(malformed.errors.length, 1);
  assert.equal(malformed.errors[0].message, 'could not read done flags, starting empty');
  rmSync(malformed.dir, { recursive: true });
});

test('dashboard store reads legacy flat done-only state and writes the current schema', () => {
  const { dir, file, logger } = fixture();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ legacy: { feedbackAt: null } }));

  const store = createDashboardStore({ file, logger });
  assert.deepEqual(store.doneAll(), { legacy: { feedbackAt: null } });
  assert.deepEqual(store.watchlistAll(), {});
  store.setWatch('https://github.com/acme/app', { watched: true });

  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    done: { legacy: { feedbackAt: null } },
    watchlist: { 'https://github.com/acme/app': { watched: true } },
  });
  rmSync(dir, { recursive: true });
});
