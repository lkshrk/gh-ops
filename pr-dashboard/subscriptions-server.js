import { summarizeSubscriptions } from './dashboard.js';
import { acknowledge as watchlistAcknowledge, applyTracked, markRemoved, mergeDiscovered, prune, rows, settleAdded } from './watchlist.js';

export function createSubscriptionsController({ createClient, watchStore, rebuild, respond, json = (status, body) => Response.json(body, { status }) }) {
  let client = null;
  let generation = 0;
  let data = { warnings: [], truncated: false };
  let error = null;

  function snapshot() {
    return {
      ...summarizeSubscriptions(rows(watchStore.watchlistAll())),
      warnings: data.warnings,
      truncated: data.truncated,
      error,
      canUnsubscribe: Boolean(createClient) && error === null,
    };
  }

  async function refresh(options) {
    if (!createClient) return;
    const version = ++generation;
    try {
      const before = watchStore.watchlistAll();
      client ??= createClient();
      const discovered = await client.fetchSubscriptions(options);
      if (version !== generation) return;
      const surviving = (entries) => discovered.threads.filter((thread) => !(thread.url in before) || thread.url in entries);
      const draft = { ...watchStore.watchlistAll() };
      mergeDiscovered(draft, surviving(draft), new Date());
      const targets = Object.values(draft).filter((entry) => !entry.removedAt);
      let tracked = { subjects: new Map(), warnings: [] };
      if (options?.stateClient?.fetchTrackedSubjects && targets.length) {
        try {
          tracked = await options.stateClient.fetchTrackedSubjects(targets, { viewer: options.viewer });
        } catch (cause) {
          tracked = { subjects: new Map(), warnings: [`Tracked subjects unavailable: ${cause.message}`] };
        }
      }
      if (version !== generation) return;

      // Synchronous from here: re-read the store.
      const entries = { ...watchStore.watchlistAll() };
      const now = new Date();
      mergeDiscovered(entries, surviving(entries), now);
      applyTracked(entries, tracked.subjects, now);
      settleAdded(entries, [...tracked.subjects.keys()]);
      prune(entries, now);
      if (JSON.stringify(entries) !== JSON.stringify(watchStore.watchlistAll())) watchStore.replaceWatch(entries);
      data = { warnings: [...discovered.warnings, ...tracked.warnings], truncated: discovered.truncated };
      error = null;
    } catch (cause) {
      if (version === generation) error = cause.message;
    }
  }

  async function target(request) {
    if (request.method !== 'POST') return { failure: json(405, { error: 'method not allowed' }) };
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
      return { failure: json(415, { error: 'expected application/json' }) };
    }
    const site = request.headers.get('sec-fetch-site');
    if (site && site !== 'same-origin') return { failure: json(403, { error: 'cross-site request' }) };
    const body = await request.json().catch(() => null);
    if (typeof body?.url !== 'string') return { failure: json(400, { error: 'expected {"url": string}' }) };
    const row = rows(watchStore.watchlistAll()).find((item) => item.url === body.url);
    if (!row) return { failure: json(404, { error: 'no watched item with that url' }) };
    return { row };
  }

  function update(change) {
    const entries = { ...watchStore.watchlistAll() };
    change(entries);
    watchStore.replaceWatch(entries);
    rebuild();
    return respond();
  }

  async function acknowledge(request) {
    const { row, failure } = await target(request);
    if (failure) return failure;
    return update((entries) => watchlistAcknowledge(entries, row.url, new Date()));
  }

  async function remove(request) {
    const { row, failure } = await target(request);
    if (failure) return failure;
    if (row.id && row.subscribed === true && snapshot().canUnsubscribe) {
      try {
        client ??= createClient();
        await client.unsubscribe(row.id);
      } catch {
        return json(502, { error: 'could not unsubscribe' });
      }
      generation++;
      // Retire all old caches too: an in-flight REST response may repopulate them after DELETE.
      client = null;
    }
    return update((entries) => markRemoved(entries, row.url, new Date()));
  }

  return { snapshot, refresh, acknowledge, remove };
}
