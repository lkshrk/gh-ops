import path from 'node:path';
import { buildSnapshot } from './dashboard.js';
import { createGitHubClient, parseOwnerTokens } from './github.js';
import { createLogger } from './log.js';

const logger = createLogger({ level: process.env.LOG_LEVEL || 'info' });

process.on('unhandledRejection', (error) => logger.error('unhandled promise rejection', { error }));
process.on('uncaughtException', (error) => {
  logger.error('uncaught exception, exiting', { error });
  process.exit(1);
});

const port = Number(process.env.PORT || 3000);
const refreshIntervalMs = Number(process.env.REFRESH_INTERVAL_MS || 60 * 1000);
const closedWindowDays = Number(process.env.CLOSED_WINDOW_DAYS || 30);
const options = {
  failStreak: Number(process.env.FAIL_STREAK || 3),
  branchPrefix: process.env.RENOVATE_BRANCH_PREFIX || 'renovate/',
};

const renovateBot = process.env.RENOVATE_BOT_LOGIN || 'renovate[bot]';

let clients;
try {
  clients = Object.fromEntries(
    Object.entries(parseOwnerTokens(process.env.GITHUB_TOKENS)).map(([owner, token]) => [
      owner,
      createGitHubClient({ token, renovateBot, logger: logger.child({ owner }) }),
    ]),
  );
} catch (error) {
  logger.error('invalid configuration, exiting', { error });
  process.exit(1);
}
const owners = Object.keys(clients);

const publicDir = path.join(import.meta.dir, 'public');
const assets = {
  '/': 'index.html',
  '/app.js': 'app.js',
  '/style.css': 'style.css',
};

const securityHeaders = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' https://avatars.githubusercontent.com; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-cache',
};

let viewer = null;
let snapshot = null;
let lastError = null;
let refreshing = false;
let lastSuccessAt = null;
let failingSince = null;
let consecutiveFailures = 0;
const ownerState = new Map();
const rateLimitWarnedFor = new Map();

function checkRateLimits() {
  for (const [owner, client] of Object.entries(clients)) {
    const rateLimit = client.rateLimit();
    if (!rateLimit?.limit || rateLimit.remaining > rateLimit.limit * 0.1) continue;
    if (rateLimitWarnedFor.get(owner) === rateLimit.resetAt) continue;
    rateLimitWarnedFor.set(owner, rateLimit.resetAt);
    logger.warn('GitHub rate limit below 10%', { owner, rateLimit, refreshIntervalMs });
  }
}

async function refreshOwner(owner) {
  const state = ownerState.get(owner) || { repos: null, fetchedAt: null, failures: 0, failingSince: null, error: null };
  ownerState.set(owner, state);

  try {
    state.repos = await clients[owner].fetchOwnerRepos(owner);
    if (state.failures > 0) {
      logger.info('owner recovered', { owner, failedRefreshes: state.failures, failingSince: state.failingSince });
    }
    Object.assign(state, { fetchedAt: new Date().toISOString(), failures: 0, failingSince: null, error: null });
  } catch (error) {
    state.failures += 1;
    state.failingSince ??= new Date().toISOString();
    state.error = error.message;
    logger.error('owner refresh failed', {
      owner,
      consecutiveFailures: state.failures,
      failingSince: state.failingSince,
      servingReposFrom: state.fetchedAt,
      rateLimit: clients[owner].rateLimit(),
      error,
    });
  }
}

function ownerErrors() {
  return [...ownerState]
    .filter(([, state]) => state.failures > 0)
    .map(([owner, state]) => ({ owner, message: state.error, since: state.failingSince, dataFrom: state.fetchedAt }));
}

async function refresh() {
  if (refreshing) {
    logger.warn('refresh skipped, previous refresh still running', { refreshIntervalMs });
    return;
  }
  refreshing = true;
  const started = Date.now();
  let phase = 'viewer';

  try {
    viewer ??= await clients[owners[0]].fetchViewer();
    const searchClient = clients[viewer] || clients[owners[0]];

    phase = 'repos';
    await Promise.all(owners.map(refreshOwner));
    if (owners.every((owner) => !ownerState.get(owner).repos)) {
      throw new Error('no owner returned repositories; see owner refresh failed entries');
    }
    const repos = owners.flatMap((owner) => ownerState.get(owner).repos || []);

    phase = 'contributions';
    const closedSince = new Date(Date.now() - closedWindowDays * 86400000).toISOString().slice(0, 10);
    const contributions = await searchClient.fetchContributions({ viewer, excludeOwners: owners, closedSince });

    phase = 'build';
    snapshot = { ...buildSnapshot({ viewer, repos, ...contributions, options }), ownerErrors: ownerErrors() };

    const durationMs = Date.now() - started;
    const summary = { owners: owners.length, repos: repos.length, durationMs };
    if (consecutiveFailures > 0) {
      logger.info('refresh recovered', { ...summary, failedRefreshes: consecutiveFailures, failingSince });
    } else if (!lastSuccessAt) {
      logger.info('first refresh complete', { viewer, ...summary });
    } else {
      logger.debug('refreshed', summary);
    }
    if (durationMs > refreshIntervalMs / 2) {
      logger.warn('refresh took more than half the refresh interval', { durationMs, refreshIntervalMs });
    }

    lastSuccessAt = new Date().toISOString();
    lastError = null;
    failingSince = null;
    consecutiveFailures = 0;
  } catch (error) {
    consecutiveFailures += 1;
    failingSince ??= new Date(started).toISOString();
    lastError = { message: error.message, at: new Date().toISOString() };
    logger.error('refresh failed', {
      phase,
      consecutiveFailures,
      failingSince,
      lastSuccessAt,
      servingSnapshotFrom: snapshot?.generatedAt ?? null,
      durationMs: Date.now() - started,
      error,
    });
  } finally {
    refreshing = false;
    checkRateLimits();
  }
}

function json(status, body) {
  return Response.json(body, { status, headers: securityHeaders });
}

function route(request) {
  const { pathname } = new URL(request.url);

  if (request.method !== 'GET') return json(405, { error: 'method not allowed' });
  if (pathname === '/healthz') return json(200, { ok: true });

  if (pathname === '/data.json') {
    if (!snapshot) return json(503, { error: lastError?.message || 'warming up' });
    return json(200, { ...snapshot, refreshIntervalMs, error: lastError });
  }

  const asset = assets[pathname];
  if (asset) return new Response(Bun.file(path.join(publicDir, asset)), { headers: securityHeaders });

  return json(404, { error: 'not found' });
}

Bun.serve({
  port,
  fetch(request) {
    try {
      return route(request);
    } catch (error) {
      logger.error('request failed', { method: request.method, url: request.url, error });
      return json(500, { error: 'internal error' });
    }
  },
});

logger.info('listening', { port, owners, renovateBot, refreshIntervalMs, ...options, closedWindowDays });
refresh();
setInterval(refresh, refreshIntervalMs);
