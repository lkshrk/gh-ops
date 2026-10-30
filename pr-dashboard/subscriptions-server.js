import { summarizeSubscriptions } from './dashboard.js';

export function createSubscriptionsController({ createClient, rebuild, respond, json = (status, body) => Response.json(body, { status }) }) {
  let client = null;
  let generation = 0;
  let data = { threads: [], warnings: [], truncated: false };
  let error = null;

  function snapshot() {
    return {
      ...summarizeSubscriptions(data.threads),
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
      client ??= createClient();
      const fetched = await client.fetchSubscriptions(options);
      if (version !== generation) return;
      data = fetched;
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
    data = { ...data, threads: data.threads.filter((item) => item.url !== thread.url) };
    rebuild();
    return respond();
  }

  return { snapshot, refresh, unsubscribe };
}
