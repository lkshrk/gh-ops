const checkboxPatterns = [
  /^\s*[-*]\s+\[x]\s+(?:run\s+)?renovate\b/i,
  /^\s*[-*]\s+\[x]\s+trigger\s+renovate\b/i,
  /^\s*[-*]\s+\[x]\s+rerun\s+renovate\b/i,
  // Renovate Dependency Dashboard / PR checkboxes: checked box followed by a
  // hidden HTML-comment marker, e.g. `- [x] <!-- rebase-all-open-prs -->`.
  /^\s*[-*]\s+\[x]\s*<!--/i,
];

const handledEvents = ['issues', 'pull_request', 'issue_comment'];
const handledActions = ['edited', 'created'];

const encoder = new TextEncoder();

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function verifySignature(secret, rawBody, signatureHeader) {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const expected = `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  return constantTimeEqual(expected, signatureHeader);
}

function triggerLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => checkboxPatterns.some((pattern) => pattern.test(line)))
    .map((line) => line.trim());
}

function bodyFor(event, payload) {
  if (event === 'issues') return payload.issue && payload.issue.body;
  if (event === 'pull_request') return payload.pull_request && payload.pull_request.body;
  if (event === 'issue_comment') return payload.comment && payload.comment.body;
  return '';
}

function hasNewlyCheckedBox(event, payload) {
  const current = triggerLines(bodyFor(event, payload));
  if (current.length === 0) return false;
  if (payload.action !== 'edited') return true;

  const previousBody = payload.changes && payload.changes.body && payload.changes.body.from;
  if (previousBody === undefined) return true;

  const previous = new Set(triggerLines(previousBody));
  return current.some((line) => !previous.has(line));
}

async function dispatch(env, repository) {
  const response = await fetch(`https://api.github.com/repos/${env.DISPATCH_REPO}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.DISPATCH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'renovate-webhook',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      event_type: env.EVENT_TYPE || 'renovate',
      client_payload: { repositories: repository },
    }),
  });
  if (!response.ok) {
    throw new Error(`dispatch failed: ${response.status} ${await response.text()}`);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return new Response('ok');
    }
    if (request.method !== 'POST') {
      return new Response('method not allowed', { status: 405 });
    }
    if (!env.WEBHOOK_SECRET || !env.DISPATCH_TOKEN || !env.DISPATCH_REPO) {
      return new Response('worker not configured', { status: 500 });
    }

    const rawBody = await request.text();
    const signature = request.headers.get('x-hub-signature-256');
    if (!(await verifySignature(env.WEBHOOK_SECRET, rawBody, signature))) {
      return new Response('invalid signature', { status: 401 });
    }

    const event = request.headers.get('x-github-event');
    if (!handledEvents.includes(event)) {
      return new Response('ignored event', { status: 202 });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response('bad payload', { status: 400 });
    }

    const repository = payload.repository && payload.repository.full_name;
    if (!repository || !handledActions.includes(payload.action)) {
      return new Response('ignored', { status: 202 });
    }
    if (!hasNewlyCheckedBox(event, payload)) {
      return new Response('no new trigger checkbox', { status: 202 });
    }

    await dispatch(env, repository);
    return new Response(`triggered ${repository}`, { status: 202 });
  },
};
