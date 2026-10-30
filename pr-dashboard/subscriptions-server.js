import { summarizeSubscriptions } from './dashboard.js';
import { applyTracked, mergeDiscovered, prune, rows, settleAdded } from './watchlist.js';

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
          tracked = await options.stateClient.fetchTrackedSubjects(targets);
        } catch (cause) {
          tracked = { subjects: new Map(), warnings: [`Tracked subjects unavailable: ${cause.message}`] };
        }
      }
      if (version !== generation) return;

      // Synchronous from here: re-read the store so acknowledges and removals made during the awaits survive.
      const entries = { ...watchStore.watchlistAll() };
      const now = new Date();
      const added = mergeDiscovered(entries, surviving(entries), now);
      applyTracked(entries, tracked.subjects);
      settleAdded(entries, added);
      prune(entries, now);
      watchStore.replaceWatch(entries);
      data = { warnings: [...discovered.warnings, ...tracked.warnings], truncated: discovered.truncated };
      error = null;
    } catch (cause) {
      if (version === generation) error = cause.message;
    }
  }

  async function unsubscribe(request) {
    if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
      return json(415, { error: 'expected application/json' });
    }
    const site = request.headers.get('sec-fetch-site');
    if (site && site !== 'same-origin') return json(403, { error: 'cross-site request' });
    const body = await request.json().catch(() => null);
    if (typeof body?.url !== 'string') return json(400, { error: 'expected {"url": string}' });
    if (!snapshot().canUnsubscribe) return json(503, { error: 'notifications unavailable' });
    const thread = snapshot().items.find((item) => item.url === body.url && item.subscribed === true && item.id);
    if (!thread) return json(404, { error: 'no eligible subscription with that url' });

    try {
      client ??= createClient();
      await client.unsubscribe(thread.id);
    } catch {
      return json(502, { error: 'could not unsubscribe' });
    }
    generation++;
    // Retire all old caches too: an in-flight REST response may repopulate them after DELETE.
    client = null;
    watchStore.deleteWatch(thread.url);
    rebuild();
    return respond();
  }

  return { snapshot, refresh, unsubscribe };
}
