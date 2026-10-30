import { expect, test } from 'bun:test';
import { acknowledge, applyTracked, isUnread, markRemoved, mergeDiscovered, prune, rows, settleAdded } from './watchlist.js';

const URL = 'https://github.com/other/repo/issues/1';
const NOW = new Date('2026-10-30T12:00:00.000Z');
const thread = (overrides = {}) => ({
  id: '42', url: URL, repo: 'other/repo', owner: 'other', number: 1, title: 'Issue', type: 'Issue', authored: false,
  unread: false, updatedAt: '2026-10-27T00:00:00Z', subscribed: true, state: 'OPEN', closedAt: null, mergedAt: null, ...overrides,
});
const entry = (overrides = {}) => ({
  url: URL, owner: 'other', repo: 'other/repo', type: 'Issue', number: 1, authored: false, threadId: '42', title: 'Issue',
  updatedAt: '2026-10-27T00:00:00Z', state: 'OPEN', closedAt: null, subscribed: true, notificationUnread: false,
  notificationUpdatedAt: '2026-10-27T00:00:00Z', seenUpdatedAt: '2026-10-27T00:00:00Z', removedAt: null, ...overrides,
});
const unknown = { title: null, updatedAt: null, state: null, closedAt: null, subscribed: null };

test('a new entry is not unread unless its notification is unread', () => {
  const entries = {};
  expect(mergeDiscovered(entries, [thread()])).toEqual([URL]);
  expect(entries[URL]).toEqual(entry());
  expect(isUnread(entries[URL])).toBe(false);

  const unread = {};
  mergeDiscovered(unread, [thread({ unread: true })]);
  expect(unread[URL].seenUpdatedAt).toBeNull();
  expect(unread[URL].notificationUnread).toBe(true);
  expect(isUnread(unread[URL])).toBe(true);

  const authored = {};
  mergeDiscovered(authored, [thread({ id: null, authored: true })]);
  expect(authored[URL]).toEqual(entry({ threadId: null, authored: true, notificationUpdatedAt: null }));
  expect(isUnread(authored[URL])).toBe(false);
});

test('settleAdded marks tracked activity on new read entries as seen, but not unread notifications', () => {
  const entries = { [URL]: entry({ updatedAt: '2026-10-28T00:00:00Z' }), b: entry({ url: 'b', seenUpdatedAt: null, notificationUnread: true }) };
  settleAdded(entries, [URL, 'b', 'missing']);
  expect(entries[URL].seenUpdatedAt).toBe('2026-10-28T00:00:00Z');
  expect(entries.b.seenUpdatedAt).toBeNull();
});

test('an existing entry keeps seen state and refreshes notification fields', () => {
  const entries = { [URL]: entry({ threadId: null, authored: true }) };
  expect(mergeDiscovered(entries, [thread({ unread: true, updatedAt: '2026-10-28T00:00:00Z', title: 'Renamed' })])).toEqual([]);
  expect(entries[URL]).toEqual(entry({
    authored: true, title: 'Renamed', updatedAt: '2026-10-28T00:00:00Z', notificationUnread: true, notificationUpdatedAt: '2026-10-28T00:00:00Z',
  }));
  expect(isUnread(entries[URL])).toBe(true);
  mergeDiscovered(entries, [thread({ id: null, authored: false, title: null, updatedAt: null, state: null })]);
  expect(entries[URL].threadId).toBe('42');
  expect(entries[URL].authored).toBe(true);
  expect(entries[URL].title).toBe('Renamed');
  expect(entries[URL].state).toBe('OPEN');
});

test('an entry stays after acknowledge while open, and updatedAt advancing makes it unread again', () => {
  const entries = { [URL]: entry({ updatedAt: '2026-10-28T00:00:00Z', notificationUnread: true, notificationUpdatedAt: '2026-10-29T00:00:00Z' }) };
  expect(isUnread(entries[URL])).toBe(true);
  expect(acknowledge(entries, URL, NOW)).toBe(true);
  expect(entries[URL].seenUpdatedAt).toBe('2026-10-29T00:00:00Z');
  expect(isUnread(entries[URL])).toBe(false);
  expect(rows(entries).map(({ url }) => url)).toEqual([URL]);
  prune(entries, NOW);
  expect(Object.keys(entries)).toEqual([URL]);

  applyTracked(entries, new Map([[URL, { title: 'Issue', updatedAt: '2026-10-30T00:00:00Z', state: 'OPEN', closedAt: null, subscribed: true }]]));
  expect(isUnread(entries[URL])).toBe(true);
  expect(acknowledge(entries, 'missing', NOW)).toBe(false);
});

test('a closed unread entry is kept, and acknowledging it tombstones it', () => {
  const entries = { [URL]: entry({ state: 'CLOSED', closedAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z' }) };
  prune(entries, NOW);
  expect(rows(entries)).toEqual([{
    id: '42', url: URL, repo: 'other/repo', owner: 'other', number: 1, title: 'Issue', type: 'Issue', state: 'CLOSED', authored: false,
    unread: true, subscribed: true, updatedAt: '2026-10-28T00:00:00Z', closedAt: '2026-10-28T00:00:00Z', mergedAt: null,
  }]);
  expect(acknowledge(entries, URL, NOW)).toBe(true);
  expect(entries[URL].removedAt).toBe(NOW.toISOString());
  expect(rows(entries)).toEqual([]);
  mergeDiscovered(entries, [thread({ unread: true, state: 'CLOSED', updatedAt: '2026-10-28T00:00:00Z' })]);
  expect(rows(entries)).toEqual([]);
});

test('discovery never moves updatedAt backwards', () => {
  const entries = { [URL]: entry({ updatedAt: '2026-10-29T00:00:00Z', seenUpdatedAt: '2026-10-27T00:00:00Z' }) };
  mergeDiscovered(entries, [thread({ updatedAt: '2026-10-28T00:00:00Z' })]);
  expect(entries[URL].updatedAt).toBe('2026-10-29T00:00:00Z');
  expect(entries[URL].notificationUpdatedAt).toBe('2026-10-28T00:00:00Z');
  expect(isUnread(entries[URL])).toBe(true);
  mergeDiscovered(entries, [thread({ updatedAt: '2026-10-30T00:00:00Z' })]);
  expect(entries[URL].updatedAt).toBe('2026-10-30T00:00:00Z');
});

test('a closed seen entry is pruned and so is subscribed === false', () => {
  const entries = {
    closed: entry({ url: 'closed', state: 'CLOSED' }),
    merged: entry({ url: 'merged', state: 'MERGED' }),
    unsubscribed: entry({ url: 'unsubscribed', subscribed: false, updatedAt: '2026-10-29T00:00:00Z' }),
    unknownSubscription: entry({ url: 'unknownSubscription', subscribed: null }),
    open: entry({ url: 'open' }),
  };
  prune(entries, NOW);
  expect(Object.keys(entries).sort()).toEqual(['open', 'unknownSubscription']);
});

test('an unknown lookup keeps the entry with state: null and is never dropped', () => {
  const entries = { [URL]: entry({ state: 'CLOSED', closedAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z', seenUpdatedAt: '2026-10-28T00:00:00Z' }) };
  applyTracked(entries, new Map([[URL, unknown]]));
  expect(entries[URL]).toEqual(entry({ state: null, closedAt: null, subscribed: null, updatedAt: '2026-10-28T00:00:00Z', seenUpdatedAt: '2026-10-28T00:00:00Z' }));
  prune(entries, NOW);
  expect(rows(entries).map(({ state }) => state)).toEqual([null]);
});

test('applyTracked copies lookup fields and skips tombstones and missing results', () => {
  const removed = entry({ url: 'removed', removedAt: '2026-10-29T00:00:00Z' });
  const entries = { [URL]: entry(), removed, untouched: entry({ url: 'untouched' }) };
  const subject = { title: 'New', updatedAt: '2026-10-29T00:00:00Z', state: 'CLOSED', closedAt: '2026-10-29T00:00:00Z', subscribed: true };
  applyTracked(entries, new Map([[URL, subject], ['removed', subject]]));
  expect(entries[URL]).toEqual(entry(subject));
  expect(entries.removed).toEqual(removed);
  expect(entries.untouched).toEqual(entry({ url: 'untouched' }));
});

test('pull requests are ignored', () => {
  const entries = {};
  expect(mergeDiscovered(entries, [thread({ type: 'PullRequest' })])).toEqual([]);
  expect(entries).toEqual({});
});

test('a tombstone is not revived by authored search or older/authored notifications, but is by a newer manual notification', () => {
  const tombstone = entry({ removedAt: '2026-10-28T00:00:00Z', seenUpdatedAt: '2026-10-27T00:00:00Z' });
  const entries = { [URL]: tombstone };
  mergeDiscovered(entries, [
    thread({ id: null, authored: true, updatedAt: '2026-10-29T00:00:00Z' }),
    thread({ unread: true, updatedAt: '2026-10-27T12:00:00Z' }),
    thread({ authored: true, unread: true, updatedAt: '2026-10-29T00:00:00Z' }),
  ]);
  expect(entries[URL]).toEqual(tombstone);
  expect(rows(entries)).toEqual([]);

  mergeDiscovered(entries, [thread({ unread: true, updatedAt: '2026-10-29T00:00:00Z' })]);
  expect(entries[URL].removedAt).toBeNull();
  expect(entries[URL].seenUpdatedAt).toBe('2026-10-28T00:00:00Z');
  expect(isUnread(entries[URL])).toBe(true);
});

test('markRemoved tombstones an entry and tombstones older than 180 days are pruned', () => {
  const entries = { [URL]: entry(), old: entry({ url: 'old', removedAt: '2026-05-02T11:59:59.999Z' }), recent: entry({ url: 'recent', removedAt: '2026-05-03T12:00:00.000Z' }) };
  expect(markRemoved(entries, URL, NOW)).toBe(true);
  expect(markRemoved(entries, 'missing', NOW)).toBe(false);
  expect(entries[URL]).toEqual(entry({ removedAt: NOW.toISOString() }));
  prune(entries, NOW);
  expect(Object.keys(entries).sort()).toEqual([URL, 'recent']);
  expect(rows(entries)).toEqual([]);
});

test('rows order unread first, then updatedAt desc, with null last', () => {
  const entries = {
    readOld: entry({ url: 'readOld', updatedAt: '2026-10-01T00:00:00Z', seenUpdatedAt: '2026-10-01T00:00:00Z' }),
    readNull: entry({ url: 'readNull', updatedAt: null, seenUpdatedAt: null }),
    readNew: entry({ url: 'readNew', updatedAt: '2026-10-20T00:00:00Z', seenUpdatedAt: '2026-10-20T00:00:00Z' }),
    unreadOld: entry({ url: 'unreadOld', updatedAt: '2026-10-02T00:00:00Z', seenUpdatedAt: null }),
    unreadNew: entry({ url: 'unreadNew', updatedAt: '2026-10-25T00:00:00Z', seenUpdatedAt: '2026-10-01T00:00:00Z' }),
    unreadNull: entry({ url: 'unreadNull', updatedAt: null, seenUpdatedAt: null, notificationUnread: true, notificationUpdatedAt: '2026-10-26T00:00:00Z' }),
    removed: entry({ url: 'removed', removedAt: '2026-10-29T00:00:00Z', seenUpdatedAt: null }),
  };
  expect(rows(entries).map(({ url, unread }) => [url, unread])).toEqual([
    ['unreadNew', true], ['unreadOld', true], ['unreadNull', true], ['readNew', false], ['readOld', false], ['readNull', false],
  ]);
});

test('seenUpdatedAt never decreases', () => {
  const later = '2026-10-29T00:00:00Z';
  const entries = { [URL]: entry({ seenUpdatedAt: later }) };
  acknowledge(entries, URL, NOW);
  expect(entries[URL].seenUpdatedAt).toBe(later);
  mergeDiscovered(entries, [thread({ updatedAt: '2026-10-20T00:00:00Z' })]);
  settleAdded(entries, [URL]);
  expect(entries[URL].seenUpdatedAt).toBe(later);
  applyTracked(entries, new Map([[URL, { ...unknown, updatedAt: '2026-10-01T00:00:00Z' }]]));
  expect(entries[URL].seenUpdatedAt).toBe(later);

  const revived = { [URL]: entry({ removedAt: '2026-10-28T00:00:00Z', seenUpdatedAt: later }) };
  mergeDiscovered(revived, [thread({ unread: true, updatedAt: '2026-10-30T00:00:00Z' })]);
  expect(revived[URL].removedAt).toBeNull();
  expect(revived[URL].seenUpdatedAt).toBe(later);
});
