const TOMBSTONE_TTL_MS = 180 * 86400000;

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

function isUnread(entry) {
  return isAfter(entry.updatedAt, entry.seenUpdatedAt)
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
    seenUpdatedAt: notificationUnread ? null : updatedAt, removedAt: null,
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
  if (thread.updatedAt != null) next.updatedAt = thread.updatedAt;
  if (thread.state != null) {
    next.state = thread.state;
    next.closedAt = thread.closedAt ?? null;
  }
  return next;
}

function revives(entry, thread) {
  return Boolean(thread.id) && thread.authored === false && time(entry.removedAt) !== null && isAfter(thread.updatedAt, entry.removedAt);
}

function mergeDiscovered(entries, threads, _now) {
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
      entries[thread.url] = refreshed({ ...entry, removedAt: null, seenUpdatedAt: latest(entry.seenUpdatedAt, entry.removedAt) }, thread);
    }
  }
  return added;
}

function settleAdded(entries, urls) {
  for (const url of urls) {
    const entry = entries[url];
    if (!entry || entry.removedAt || entry.notificationUnread) continue;
    entries[url] = { ...entry, seenUpdatedAt: latest(entry.seenUpdatedAt, entry.updatedAt) };
  }
}

function applyTracked(entries, subjects) {
  for (const [url, subject] of subjects || []) {
    const entry = entries[url];
    if (!entry || entry.removedAt || !subject) continue;
    entries[url] = {
      ...entry,
      title: subject.title ?? entry.title,
      updatedAt: subject.updatedAt ?? entry.updatedAt,
      state: subject.state ?? null,
      closedAt: subject.closedAt ?? null,
      subscribed: subject.subscribed ?? null,
    };
  }
}

function prune(entries, now) {
  const cutoff = now.getTime() - TOMBSTONE_TTL_MS;
  for (const [url, entry] of Object.entries(entries)) {
    const drop = entry.removedAt
      ? (time(entry.removedAt) ?? -Infinity) < cutoff
      : entry.subscribed === false || (isClosed(entry) && !isUnread(entry));
    if (drop) delete entries[url];
  }
}

function acknowledge(entries, url) {
  const entry = entries[url];
  if (!entry || entry.removedAt) return false;
  if (isClosed(entry)) delete entries[url];
  else entries[url] = { ...entry, seenUpdatedAt: latest(entry.seenUpdatedAt, entry.updatedAt, entry.notificationUpdatedAt) };
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
      subscribed: entry.subscribed, updatedAt: entry.updatedAt, closedAt: entry.closedAt, mergedAt: null,
    }))
    .sort((a, b) => Number(b.unread) - Number(a.unread) || recency(b) - recency(a));
}

export { acknowledge, applyTracked, isUnread, markRemoved, mergeDiscovered, prune, rows, settleAdded };
