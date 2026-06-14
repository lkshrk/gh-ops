const crypto = require('node:crypto');
const {
  managedRepositories,
} = require('../renovate/repositories');

const managedRepositorySet = new Set(managedRepositories);

const checkboxPatterns = [
  /^\s*[-*]\s+\[x]\s+(?:run\s+)?renovate\b/i,
  /^\s*[-*]\s+\[x]\s+trigger\s+renovate\b/i,
  /^\s*[-*]\s+\[x]\s+rerun\s+renovate\b/i,
];

function verifyGitHubSignature(secret, rawBody, signatureHeader) {
  if (!secret) {
    throw new Error('GITHUB_WEBHOOK_SECRET is required');
  }

  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const expected = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex')}`;
  const actual = Buffer.from(signatureHeader);
  const expectedBuffer = Buffer.from(expected);

  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

function hasRenovateTriggerCheckbox(text) {
  return String(text || '')
    .split(/\r?\n/)
    .some((line) => checkboxPatterns.some((pattern) => pattern.test(line)));
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
  const currentBody = bodyFromPayload(event, payload);
  if (!hasRenovateTriggerCheckbox(currentBody)) {
    return false;
  }

  if (payload.action !== 'edited') {
    return true;
  }

  const previousBody = previousBodyFromPayload(payload);
  return previousBody === undefined || !hasRenovateTriggerCheckbox(previousBody);
}

function resolveTrigger(event, payload) {
  const repo = repositoryFromPayload(payload);
  if (!repo) {
    return { shouldTrigger: false, reason: 'missing repository' };
  }

  if (!managedRepositorySet.has(repo)) {
    return { shouldTrigger: false, reason: `repository ${repo} is not managed` };
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

  for (const key of ['delivery', 'event', 'action', 'repository', 'reason', 'error']) {
    if (details[key]) {
      entry[key] = details[key];
    }
  }

  if (details.pipeline) {
    if (details.pipeline.number !== undefined) {
      entry.pipelineNumber = details.pipeline.number;
    }
    if (details.pipeline.status) {
      entry.pipelineStatus = details.pipeline.status;
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

async function triggerWoodpecker(repository, options = {}) {
  const apiUrl = (options.apiUrl || process.env.WOODPECKER_API_URL || 'https://ci.h-cloud.io/api').replace(/\/$/, '');
  const token = options.token || process.env.WOODPECKER_TOKEN;
  const repoId = options.repoId || process.env.WOODPECKER_REPO_ID || '13';
  const branch = options.branch || process.env.WOODPECKER_BRANCH || 'main';

  if (!token) {
    throw new Error('WOODPECKER_TOKEN is required');
  }

  const response = await fetch(`${apiUrl}/repos/${repoId}/pipelines`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      branch,
      variables: {
        RENOVATE_REPOSITORIES: repository,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Woodpecker trigger failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

module.exports = {
  buildBridgeLogEntry,
  createDeliveryDeduper,
  hasRenovateTriggerCheckbox,
  resolveTrigger,
  triggerWoodpecker,
  verifyGitHubSignature,
};
