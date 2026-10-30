const DAY_MS = 86400000;
const TOMBSTONE_TTL_MS = 180 * DAY_MS;
const UNKNOWN_TTL_MS = 14 * DAY_MS;

function time(value) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function isAfter(value, reference) {
  const at = time(value);
  if (at === null) return false;
  const ref = time(reference);
  return ref === null || at > ref;
}

function latest(...values) {
  return values.reduce((best, value) => (isAfter(value, best) ? value : best), null);
}

function isClosed(entry) {
  return entry.state === 'CLOSED' || entry.state === 'MERGED';
}

// Entries never looked up (no activityAt key) fall back to updatedAt.
function activity(entry) {
  return entry.activityAt === undefined ? entry.updatedAt : entry.activityAt;
}

function isUnread(entry) {
  return isAfter(activity(entry), entry.seenUpdatedAt)
    || Boolean(entry.notificationUnread && isAfter(entry.notificationUpdatedAt, entry.seenUpdatedAt));
}

function newEntry(thread) {
  const notified = Boolean(thread.id);
  const updatedAt = thread.updatedAt ?? null;
  const notificationUnread = notified && Boolean(thread.unread);
  return {
    url: thread.url, owner: thread.owner, repo: thread.repo, type: thread.type, number: thread.number,
    authored: Boolean(thread.authored), threadId: thread.id ?? null, title: thread.title ?? null, updatedAt,
    state: thread.state ?? null, closedAt: thread.closedAt ?? null, subscribed: thread.subscribed ?? null,
    notificationUnread, notificationUpdatedAt: notified ? updatedAt : null,
    seenUpdatedAt: notificationUnread ? null : updatedAt, removedAt: null, unsettled: true,
  };
}

function refreshed(entry, thread) {
  const next = { ...entry, authored: entry.authored || Boolean(thread.authored) };
  if (thread.id) {
    next.threadId = thread.id;
    next.notificationUnread = Boolean(thread.unread);
    next.notificationUpdatedAt = thread.updatedAt ?? null;
  }
  if (thread.title != null) next.title = thread.title;
  next.updatedAt = latest(entry.updatedAt, thread.updatedAt);
  if (thread.state != null) {
    next.state = thread.state;
    next.closedAt = thread.closedAt ?? null;
  }
  return next;
}

function revives(entry, thread) {
  return Boolean(thread.id) && thread.authored === false && time(entry.removedAt) !== null && isAfter(thread.updatedAt, entry.removedAt);
}

function mergeDiscovered(entries, threads, now) {
  const added = [];
  for (const thread of threads || []) {
    if (!thread?.url || thread.type === 'PullRequest') continue;
    const entry = entries[thread.url];
    if (!entry) {
      entries[thread.url] = newEntry(thread);
      added.push(thread.url);
    } else if (!entry.removedAt) {
      entries[thread.url] = refreshed(entry, thread);
    } else if (revives(entry, thread)) {
      entries[thread.url] = refreshed({ ...entry, removedAt: null, lastSeenAt: null, seenUpdatedAt: latest(entry.seenUpdatedAt, entry.removedAt) }, thread);
    } else if ((time(entry.lastSeenAt) ?? -Infinity) <= now.getTime() - DAY_MS) {
      entries[thread.url] = { ...entry, lastSeenAt: now.toISOString() };
    }
  }
  return added;
}

function settleAdded(entries, urls) {
  for (const url of urls) {
    const entry = entries[url];
    if (!entry?.unsettled) continue;
    const { unsettled: _, ...settled } = entry;
    if (!settled.removedAt && !settled.notificationUnread) {
      settled.seenUpdatedAt = latest(settled.seenUpdatedAt, settled.updatedAt, activity(settled));
    }
    entries[url] = settled;
  }
}

function applyTracked(entries, subjects, now = new Date()) {
  for (const [url, subject] of subjects || []) {
    const entry = entries[url];
    if (!entry || entry.removedAt || !subject) continue;
    const known = subject.state != null;
    const next = {
      ...entry,
      title: subject.title ?? entry.title,
      updatedAt: subject.updatedAt ?? entry.updatedAt,
      state: subject.state ?? null,
      closedAt: subject.closedAt ?? null,
      subscribed: subject.subscribed ?? null,
      unknownSince: known ? null : entry.unknownSince ?? now.toISOString(),
    };
    if (known) next.activityAt = subject.activityAt ?? null;
    entries[url] = next;
  }
}

function prune(entries, now) {
  const cutoff = now.getTime() - TOMBSTONE_TTL_MS;
  const unknownCutoff = now.getTime() - UNKNOWN_TTL_MS;
  for (const [url, entry] of Object.entries(entries)) {
    if (entry.removedAt) {
      if ((time(latest(entry.lastSeenAt, entry.removedAt)) ?? -Infinity) < cutoff) delete entries[url];
    } else if (entry.subscribed === false) {
      delete entries[url];
    } else if ((isClosed(entry) && !isUnread(entry)) || (time(entry.unknownSince) ?? Infinity) < unknownCutoff) {
      entries[url] = { ...entry, removedAt: now.toISOString() };
    }
  }
}

function acknowledge(entries, url, now = new Date()) {
  const entry = entries[url];
  if (!entry || entry.removedAt) return false;
  if (isClosed(entry)) entries[url] = { ...entry, removedAt: now.toISOString() };
  else entries[url] = { ...entry, seenUpdatedAt: latest(entry.seenUpdatedAt, activity(entry), entry.updatedAt, entry.notificationUpdatedAt) };
  return true;
}

function markRemoved(entries, url, now) {
  if (!entries[url]) return false;
  entries[url] = { ...entries[url], removedAt: now.toISOString() };
  return true;
}

function recency(row) {
  return time(row.updatedAt) ?? Number.MIN_SAFE_INTEGER;
}

function rows(entries) {
  return Object.values(entries)
    .filter((entry) => !entry.removedAt)
    .map((entry) => ({
      id: entry.threadId ?? null, url: entry.url, repo: entry.repo, owner: entry.owner, number: entry.number, title: entry.title,
      type: entry.type, state: entry.state, authored: Boolean(entry.authored), unread: isUnread(entry),
      subscribed: entry.subscribed, updatedAt: entry.updatedAt, closedAt: entry.closedAt,
    }))
    .sort((a, b) => Number(b.unread) - Number(a.unread) || recency(b) - recency(a));
}

export { acknowledge, applyTracked, isUnread, markRemoved, mergeDiscovered, prune, rows, settleAdded };
