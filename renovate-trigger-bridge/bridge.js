const crypto = require('node:crypto');

const DEFAULT_FORWARD_EVENTS = ['pull_request', 'issue_comment'];
const DEFAULT_FORWARD_TIMEOUT_MS = 5000;

const checkboxPatterns = [
  /^\s*[-*]\s+\[x]\s+(?:run\s+)?renovate\b/i,
  /^\s*[-*]\s+\[x]\s+trigger\s+renovate\b/i,
  /^\s*[-*]\s+\[x]\s+rerun\s+renovate\b/i,
  // Renovate Dependency Dashboard checkboxes: checked box followed by a hidden
  // HTML-comment marker, e.g. `- [x] <!-- rebase-all-open-prs -->...`.
  /^\s*[-*]\s+\[x]\s*<!--/i,
];

function signBody(secret, rawBody) {
  return `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

function verifyGitHubSignature(secret, rawBody, signatureHeader) {
  if (!secret) {
    throw new Error('GITHUB_WEBHOOK_SECRET is required');
  }

  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const expected = signBody(secret, rawBody);
  const actual = Buffer.from(signatureHeader);
  const expectedBuffer = Buffer.from(expected);

  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

function triggerCheckboxLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => checkboxPatterns.some((pattern) => pattern.test(line)))
    .map((line) => line.trim());
}

function hasRenovateTriggerCheckbox(text) {
  return triggerCheckboxLines(text).length > 0;
}

function repositoryFromPayload(payload) {
  return payload.repository && payload.repository.full_name;
}

function bodyFromPayload(event, payload) {
  if (event === 'issues') {
    return payload.issue && payload.issue.body;
  }

  if (event === 'pull_request') {
    return payload.pull_request && payload.pull_request.body;
  }

  if (event === 'issue_comment') {
    return payload.comment && payload.comment.body;
  }

  return '';
}

function previousBodyFromPayload(payload) {
  return payload.changes && payload.changes.body && payload.changes.body.from;
}

function hasNewTriggerCheckbox(event, payload) {
  const currentLines = triggerCheckboxLines(bodyFromPayload(event, payload));
  if (currentLines.length === 0) {
    return false;
  }

  if (payload.action !== 'edited') {
    return true;
  }

  const previousBody = previousBodyFromPayload(payload);
  if (previousBody === undefined) {
    return true;
  }

  const previousChecked = new Set(triggerCheckboxLines(previousBody));
  return currentLines.some((line) => !previousChecked.has(line));
}

function resolveTrigger(event, payload) {
  const repo = repositoryFromPayload(payload);
  if (!repo) {
    return { shouldTrigger: false, reason: 'missing repository' };
  }

  if (!['issues', 'pull_request', 'issue_comment'].includes(event)) {
    return { shouldTrigger: false, reason: `ignored event ${event}` };
  }

  if (!['edited', 'created'].includes(payload.action)) {
    return { shouldTrigger: false, reason: `ignored action ${payload.action}` };
  }

  if (!hasNewTriggerCheckbox(event, payload)) {
    return { shouldTrigger: false, reason: 'no newly checked Renovate trigger checkbox' };
  }

  return {
    shouldTrigger: true,
    repository: repo,
    reason: `${event}.${payload.action}`,
  };
}

function buildBridgeLogEntry(outcome, details = {}) {
  const entry = {
    component: 'renovate-trigger-bridge',
    outcome,
  };

  for (const key of ['delivery', 'event', 'action', 'repository', 'reason', 'status', 'error']) {
    if (details[key]) {
      entry[key] = details[key];
    }
  }

  return entry;
}

function createDeliveryDeduper(options = {}) {
  const ttlMs = options.ttlMs || 60 * 60 * 1000;
  const now = options.now || Date.now;
  const seenDeliveries = new Map();

  function prune(currentTime) {
    for (const [delivery, timestamp] of seenDeliveries) {
      if (currentTime - timestamp > ttlMs) {
        seenDeliveries.delete(delivery);
      }
    }
  }

  return {
    check(delivery) {
      if (!delivery) {
        return false;
      }

      const currentTime = now();
      prune(currentTime);

      if (seenDeliveries.has(delivery)) {
        return true;
      }

      seenDeliveries.set(delivery, currentTime);
      return false;
    },
  };
}

async function triggerDispatch(repository, options = {}) {
  const dispatchRepo = options.dispatchRepo || process.env.DISPATCH_REPO || 'lkshrk/gh-ops';
  const token = options.token || process.env.GITHUB_DISPATCH_TOKEN;
  const eventType = options.eventType || process.env.EVENT_TYPE || 'renovate';

  if (!token) {
    throw new Error('GITHUB_DISPATCH_TOKEN is required');
  }

  const response = await fetch(`https://api.github.com/repos/${dispatchRepo}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'renovate-trigger-bridge',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      event_type: eventType,
      client_payload: { repositories: repository },
    }),
  });

  if (!response.ok) {
    throw new Error(`dispatch failed: ${response.status} ${await response.text()}`);
  }

  // 204 No Content — no body to parse
  return { status: response.status };
}

function logBridgeEvent(outcome, details) {
  console.log(JSON.stringify(buildBridgeLogEntry(outcome, details)));
}

function parseForwardEvents(value) {
  const entries = Array.isArray(value) ? value : String(value == null ? '' : value).split(',');
  const events = entries.map((entry) => String(entry).trim()).filter(Boolean);

  return events.length > 0 ? events : DEFAULT_FORWARD_EVENTS;
}

async function forwardToOpenHands({ event, delivery, action, rawBody, options = {} }) {
  const url = options.url || process.env.OPENHANDS_EVENTS_URL;
  if (!url) {
    return { forwarded: false, reason: 'openhands forwarding disabled' };
  }

  const events = parseForwardEvents(
    options.events === undefined ? process.env.OPENHANDS_FORWARD_EVENTS : options.events,
  );
  if (!events.includes(event)) {
    return { forwarded: false, reason: `event ${event} not forwarded` };
  }

  const log = options.log || logBridgeEvent;
  const details = { delivery, event, action };
  const dryRun =
    options.dryRun === undefined ? process.env.RENOVATE_BRIDGE_DRY_RUN === 'true' : options.dryRun;

  if (dryRun) {
    log('openhands_dry_run', { ...details, reason: 'dry run' });
    return { forwarded: false, reason: 'dry run' };
  }

  const secret = options.secret || process.env.OPENHANDS_WEBHOOK_SECRET;
  const timeoutMs = Number(
    options.timeoutMs || process.env.OPENHANDS_FORWARD_TIMEOUT_MS || DEFAULT_FORWARD_TIMEOUT_MS,
  );
  const doFetch = options.fetch || globalThis.fetch;
  const body = JSON.stringify({ payload: JSON.parse(rawBody) });

  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'renovate-trigger-bridge',
        'X-GitHub-Event': event,
        'X-GitHub-Delivery': delivery,
        'X-Hub-Signature-256': signBody(secret, body),
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });

    log('openhands_forwarded', { ...details, status: response.status });
    return { forwarded: true, status: response.status };
  } catch (error) {
    log('openhands_forward_failed', { ...details, error: error.message });
    return { forwarded: false, error: error.message };
  }
}

module.exports = {
  buildBridgeLogEntry,
  createDeliveryDeduper,
  forwardToOpenHands,
  hasRenovateTriggerCheckbox,
  logBridgeEvent,
  resolveTrigger,
  triggerDispatch,
  verifyGitHubSignature,
};
