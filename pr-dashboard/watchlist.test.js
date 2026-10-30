import { expect, test } from 'bun:test';
import { acknowledge, applyTracked, isUnread, markRemoved, mergeDiscovered, prune, rows, settleAdded } from './watchlist.js';

const URL = 'https://github.com/other/repo/issues/1';
const NOW = new Date('2026-10-30T12:00:00.000Z');
const thread = (overrides = {}) => ({
  id: '42', url: URL, repo: 'other/repo', owner: 'other', number: 1, title: 'Issue', type: 'Issue', authored: false,
  unread: false, updatedAt: '2026-10-27T00:00:00Z', subscribed: true, state: 'OPEN', closedAt: null, ...overrides,
});
const entry = (overrides = {}) => ({
  url: URL, owner: 'other', repo: 'other/repo', type: 'Issue', number: 1, authored: false, threadId: '42', title: 'Issue',
  updatedAt: '2026-10-27T00:00:00Z', state: 'OPEN', closedAt: null, subscribed: true, notificationUnread: false,
  notificationUpdatedAt: '2026-10-27T00:00:00Z', seenUpdatedAt: '2026-10-27T00:00:00Z', removedAt: null, ...overrides,
});
const unknown = { title: null, updatedAt: null, state: null, closedAt: null, subscribed: null, activityAt: null };
const open = (overrides = {}) => ({ title: 'Issue', updatedAt: '2026-10-27T00:00:00Z', state: 'OPEN', closedAt: null, subscribed: true, activityAt: null, ...overrides });
const DAY = 86400000;

test('a new entry is not unread unless its notification is unread', () => {
  const entries = {};
  expect(mergeDiscovered(entries, [thread()], NOW)).toEqual([URL]);
  expect(entries[URL]).toEqual(entry({ unsettled: true }));
  expect(isUnread(entries[URL])).toBe(false);

  const unread = {};
  mergeDiscovered(unread, [thread({ unread: true })], NOW);
  expect(unread[URL].seenUpdatedAt).toBeNull();
  expect(unread[URL].notificationUnread).toBe(true);
  expect(isUnread(unread[URL])).toBe(true);

  const authored = {};
  mergeDiscovered(authored, [thread({ id: null, authored: true })], NOW);
  expect(authored[URL]).toEqual(entry({ threadId: null, authored: true, notificationUpdatedAt: null, unsettled: true }));
  expect(isUnread(authored[URL])).toBe(false);
});

test('settleAdded marks tracked activity on new read entries as seen, but not unread notifications', () => {
  const entries = {
    [URL]: entry({ updatedAt: '2026-10-28T00:00:00Z', activityAt: '2026-10-29T00:00:00Z', unsettled: true }),
    b: entry({ url: 'b', seenUpdatedAt: null, notificationUnread: true, unsettled: true }),
    settled: entry({ url: 'settled', updatedAt: '2026-10-28T00:00:00Z' }),
  };
  settleAdded(entries, [URL, 'b', 'settled', 'missing']);
  expect(entries[URL]).toEqual(entry({ updatedAt: '2026-10-28T00:00:00Z', activityAt: '2026-10-29T00:00:00Z', seenUpdatedAt: '2026-10-29T00:00:00Z' }));
  expect(entries.b.seenUpdatedAt).toBeNull();
  expect(entries.b).not.toHaveProperty('unsettled');
  expect(entries.settled.seenUpdatedAt).toBe('2026-10-27T00:00:00Z');
});

test('an existing entry keeps seen state and refreshes notification fields', () => {
  const entries = { [URL]: entry({ threadId: null, authored: true }) };
  expect(mergeDiscovered(entries, [thread({ unread: true, updatedAt: '2026-10-28T00:00:00Z', title: 'Renamed' })], NOW)).toEqual([]);
  expect(entries[URL]).toEqual(entry({
    authored: true, title: 'Renamed', updatedAt: '2026-10-28T00:00:00Z', notificationUnread: true, notificationUpdatedAt: '2026-10-28T00:00:00Z',
  }));
  expect(isUnread(entries[URL])).toBe(true);
  mergeDiscovered(entries, [thread({ id: null, authored: false, title: null, updatedAt: null, state: null })], NOW);
  expect(entries[URL].threadId).toBe('42');
  expect(entries[URL].authored).toBe(true);
  expect(entries[URL].title).toBe('Renamed');
  expect(entries[URL].state).toBe('OPEN');
});

test('an entry stays after acknowledge while open, and activity by others makes it unread again', () => {
  const entries = { [URL]: entry({ updatedAt: '2026-10-28T00:00:00Z', notificationUnread: true, notificationUpdatedAt: '2026-10-29T00:00:00Z' }) };
  expect(isUnread(entries[URL])).toBe(true);
  expect(acknowledge(entries, URL, NOW)).toBe(true);
  expect(entries[URL].seenUpdatedAt).toBe('2026-10-29T00:00:00Z');
  expect(isUnread(entries[URL])).toBe(false);
  expect(rows(entries).map(({ url }) => url)).toEqual([URL]);
  prune(entries, NOW);
  expect(Object.keys(entries)).toEqual([URL]);

  applyTracked(entries, new Map([[URL, open({ updatedAt: '2026-10-30T00:00:00Z' })]]), NOW);
  expect(isUnread(entries[URL])).toBe(false);
  applyTracked(entries, new Map([[URL, open({ updatedAt: '2026-10-30T00:00:00Z', activityAt: '2026-10-30T00:00:00Z' })]]), NOW);
  expect(isUnread(entries[URL])).toBe(true);
  expect(acknowledge(entries, 'missing', NOW)).toBe(false);
});

test('a closed unread entry is kept, and acknowledging it tombstones it', () => {
  const entries = { [URL]: entry({ state: 'CLOSED', closedAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z' }) };
  prune(entries, NOW);
  expect(rows(entries)).toEqual([{
    id: '42', url: URL, repo: 'other/repo', owner: 'other', number: 1, title: 'Issue', type: 'Issue', state: 'CLOSED', authored: false,
    unread: true, subscribed: true, updatedAt: '2026-10-28T00:00:00Z', closedAt: '2026-10-28T00:00:00Z',
  }]);
  expect(acknowledge(entries, URL, NOW)).toBe(true);
  expect(entries[URL].removedAt).toBe(NOW.toISOString());
  expect(rows(entries)).toEqual([]);
  mergeDiscovered(entries, [thread({ unread: true, state: 'CLOSED', updatedAt: '2026-10-28T00:00:00Z' })], NOW);
  expect(rows(entries)).toEqual([]);
});

test('discovery never moves updatedAt backwards', () => {
  const entries = { [URL]: entry({ updatedAt: '2026-10-29T00:00:00Z', seenUpdatedAt: '2026-10-27T00:00:00Z' }) };
  mergeDiscovered(entries, [thread({ updatedAt: '2026-10-28T00:00:00Z' })], NOW);
  expect(entries[URL].updatedAt).toBe('2026-10-29T00:00:00Z');
  expect(entries[URL].notificationUpdatedAt).toBe('2026-10-28T00:00:00Z');
  expect(isUnread(entries[URL])).toBe(true);
  mergeDiscovered(entries, [thread({ updatedAt: '2026-10-30T00:00:00Z' })], NOW);
  expect(entries[URL].updatedAt).toBe('2026-10-30T00:00:00Z');
});

test('a closed seen entry is tombstoned and subscribed === false is deleted', () => {
  const entries = {
    closed: entry({ url: 'closed', state: 'CLOSED' }),
    merged: entry({ url: 'merged', state: 'MERGED' }),
    unsubscribed: entry({ url: 'unsubscribed', subscribed: false, updatedAt: '2026-10-29T00:00:00Z' }),
    unknownSubscription: entry({ url: 'unknownSubscription', subscribed: null }),
    open: entry({ url: 'open' }),
  };
  prune(entries, NOW);
  expect(Object.keys(entries).sort()).toEqual(['closed', 'merged', 'open', 'unknownSubscription']);
  expect([entries.closed.removedAt, entries.merged.removedAt, entries.open.removedAt]).toEqual([NOW.toISOString(), NOW.toISOString(), null]);
  expect(rows(entries).map(({ url }) => url).sort()).toEqual(['open', 'unknownSubscription']);
  expect(mergeDiscovered(entries, [thread({ url: 'closed', state: 'CLOSED' })], NOW)).toEqual([]);
  expect(entries.closed.removedAt).toBe(NOW.toISOString());
  const pruned = structuredClone(entries);
  prune(entries, NOW);
  expect(entries).toEqual(pruned);
});

test('an unknown lookup keeps the entry with state: null until it has been unknown for 14 days', () => {
  const entries = { [URL]: entry({ state: 'CLOSED', closedAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z', seenUpdatedAt: '2026-10-28T00:00:00Z' }) };
  applyTracked(entries, new Map([[URL, unknown]]), NOW);
  expect(entries[URL]).toEqual(entry({ state: null, closedAt: null, subscribed: null, updatedAt: '2026-10-28T00:00:00Z', seenUpdatedAt: '2026-10-28T00:00:00Z', unknownSince: NOW.toISOString() }));
  prune(entries, NOW);
  expect(rows(entries).map(({ state }) => state)).toEqual([null]);

  const later = new Date(NOW.getTime() + 13 * DAY);
  applyTracked(entries, new Map([[URL, unknown]]), later);
  expect(entries[URL].unknownSince).toBe(NOW.toISOString());
  applyTracked(entries, new Map(), later);
  prune(entries, later);
  expect(rows(entries)).toHaveLength(1);
  prune(entries, new Date(NOW.getTime() + 15 * DAY));
  expect(entries[URL].removedAt).toBe(new Date(NOW.getTime() + 15 * DAY).toISOString());
  expect(rows(entries)).toEqual([]);
});

test('a known lookup clears unknownSince so the entry is not pruned', () => {
  const entries = { [URL]: entry({ state: null, unknownSince: '2026-01-01T00:00:00Z' }) };
  applyTracked(entries, new Map([[URL, open()]]), NOW);
  expect(entries[URL].unknownSince).toBeNull();
  prune(entries, NOW);
  expect(rows(entries).map(({ state }) => state)).toEqual(['OPEN']);
});

test('applyTracked copies lookup fields and skips tombstones and missing results', () => {
  const removed = entry({ url: 'removed', removedAt: '2026-10-29T00:00:00Z' });
  const entries = { [URL]: entry(), removed, untouched: entry({ url: 'untouched' }) };
  const subject = { title: 'New', updatedAt: '2026-10-29T00:00:00Z', state: 'CLOSED', closedAt: '2026-10-29T00:00:00Z', subscribed: true };
  applyTracked(entries, new Map([[URL, subject], ['removed', subject]]), NOW);
  expect(entries[URL]).toEqual(entry({ ...subject, activityAt: null, unknownSince: null }));
  expect(entries.removed).toEqual(removed);
  expect(entries.untouched).toEqual(entry({ url: 'untouched' }));
});

test('pull requests are ignored', () => {
  const entries = {};
  expect(mergeDiscovered(entries, [thread({ type: 'PullRequest' })], NOW)).toEqual([]);
  expect(entries).toEqual({});
});

test('a tombstone is not revived by authored search or older/authored notifications, but is by a newer manual notification', () => {
  const tombstone = entry({ removedAt: '2026-10-28T00:00:00Z', seenUpdatedAt: '2026-10-27T00:00:00Z' });
  const entries = { [URL]: tombstone };
  mergeDiscovered(entries, [
    thread({ id: null, authored: true, updatedAt: '2026-10-29T00:00:00Z' }),
    thread({ unread: true, updatedAt: '2026-10-27T12:00:00Z' }),
    thread({ authored: true, unread: true, updatedAt: '2026-10-29T00:00:00Z' }),
  ], NOW);
  expect(entries[URL]).toEqual({ ...tombstone, lastSeenAt: NOW.toISOString() });
  expect(rows(entries)).toEqual([]);

  mergeDiscovered(entries, [thread({ unread: true, updatedAt: '2026-10-29T00:00:00Z' })], NOW);
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
  mergeDiscovered(entries, [thread({ updatedAt: '2026-10-20T00:00:00Z' })], NOW);
  settleAdded(entries, [URL]);
  expect(entries[URL].seenUpdatedAt).toBe(later);
  applyTracked(entries, new Map([[URL, { ...unknown, updatedAt: '2026-10-01T00:00:00Z' }]]));
  expect(entries[URL].seenUpdatedAt).toBe(later);

  const revived = { [URL]: entry({ removedAt: '2026-10-28T00:00:00Z', seenUpdatedAt: later }) };
  mergeDiscovered(revived, [thread({ unread: true, updatedAt: '2026-10-30T00:00:00Z' })], NOW);
  expect(revived[URL].removedAt).toBeNull();
  expect(revived[URL].seenUpdatedAt).toBe(later);
});

test('a tombstone that is still discovered never expires, and an unseen one does after 180 days', () => {
  const removedAt = '2026-01-01T00:00:00Z';
  const seen = { [URL]: entry({ removedAt }) };
  mergeDiscovered(seen, [thread({ updatedAt: '2026-01-01T00:00:00Z' })], NOW);
  expect(seen[URL].lastSeenAt).toBe(NOW.toISOString());
  prune(seen, new Date(NOW.getTime() + 179 * 86400000));
  expect(seen[URL]).toBeDefined();
  const before = seen[URL];
  mergeDiscovered(seen, [thread({ updatedAt: '2026-01-01T00:00:00Z' })], new Date(NOW.getTime() + 12 * 3600000));
  expect(seen[URL]).toBe(before);
  prune(seen, new Date(NOW.getTime() + 181 * 86400000));
  expect(seen[URL]).toBeUndefined();

  const unseen = { [URL]: entry({ removedAt }) };
  prune(unseen, NOW);
  expect(unseen[URL]).toBeUndefined();
});

test('the viewer\'s own activity after acknowledge keeps an item read', () => {
  const entries = { [URL]: entry({ seenUpdatedAt: null, updatedAt: '2026-10-20T00:00:00Z' }) };
  applyTracked(entries, new Map([[URL, open({ updatedAt: '2026-10-20T00:00:00Z', activityAt: '2026-10-20T00:00:00Z' })]]), NOW);
  expect(isUnread(entries[URL])).toBe(true);
  acknowledge(entries, URL, NOW);
  expect(isUnread(entries[URL])).toBe(false);
  applyTracked(entries, new Map([[URL, open({ updatedAt: '2026-10-29T00:00:00Z', activityAt: '2026-10-20T00:00:00Z' })]]), NOW);
  expect(isUnread(entries[URL])).toBe(false);
  expect(rows(entries)[0].updatedAt).toBe('2026-10-29T00:00:00Z');
});

test('a comment by someone else flips an acknowledged item to unread', () => {
  const entries = { [URL]: entry({ activityAt: null }) };
  expect(isUnread(entries[URL])).toBe(false);
  applyTracked(entries, new Map([[URL, open({ updatedAt: '2026-10-29T00:00:00Z', activityAt: '2026-10-29T00:00:00Z' })]]), NOW);
  expect(isUnread(entries[URL])).toBe(true);
  acknowledge(entries, URL, NOW);
  expect(entries[URL].seenUpdatedAt).toBe('2026-10-29T00:00:00Z');
  expect(isUnread(entries[URL])).toBe(false);
});

test('a closure flips an item to unread and keeps it through prune', () => {
  const entries = { [URL]: entry({ activityAt: null }) };
  const closed = open({ state: 'CLOSED', closedAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:00:00Z', activityAt: '2026-10-29T00:00:00Z' });
  applyTracked(entries, new Map([[URL, closed]]), NOW);
  prune(entries, NOW);
  expect(rows(entries).map(({ unread, state }) => [unread, state])).toEqual([[true, 'CLOSED']]);
});

test('updatedAt is the unread fallback only for entries that never had activityAt', () => {
  const legacy = entry({ updatedAt: '2026-10-29T00:00:00Z' });
  expect(isUnread(legacy)).toBe(true);
  expect(isUnread({ ...legacy, activityAt: null })).toBe(false);
  const entries = { [URL]: entry({ updatedAt: '2026-10-29T00:00:00Z', activityAt: '2026-10-20T00:00:00Z' }) };
  applyTracked(entries, new Map([[URL, unknown]]), NOW);
  applyTracked(entries, new Map(), NOW);
  expect(entries[URL].activityAt).toBe('2026-10-20T00:00:00Z');
  expect(isUnread(entries[URL])).toBe(false);
});
