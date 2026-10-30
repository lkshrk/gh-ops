import { createLogger } from './log.js';

const API_URL = 'https://api.github.com';
const GRAPHQL_URL = `${API_URL}/graphql`;
const DEFAULT_BRANCH_RUNS = 50;
const RECENT_RUNS = 100;
const REPO_BATCH_SIZE = 6;
const SUBSCRIPTION_LIMIT = 30;
const NOTIFICATION_PAGE_LIMIT = 10;
const AUTHORED_LIMIT = 50;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const LAST_COMMENT = 'comments(last: 1) { nodes { createdAt author { login } } }';

const RENOVATE_CONFIG_FILES = [
  'renovate.json',
  'renovate.json5',
  '.github/renovate.json',
  '.github/renovate.json5',
  '.gitlab/renovate.json',
  '.renovaterc',
  '.renovaterc.json',
  '.renovaterc.json5',
];

const renovateConfigFields = RENOVATE_CONFIG_FILES.map(
  (file, index) => `renovateConfig${index}: object(expression: "HEAD:${file}") { id }`,
).join('\n          ');

const REPO_LIST_QUERY = `
  query ($owner: String!, $cursor: String) {
    repositoryOwner(login: $owner) {
      repositories(
        first: 100
        after: $cursor
        isArchived: false
        isFork: false
        ownerAffiliations: [OWNER]
        orderBy: { field: PUSHED_AT, direction: DESC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes { name }
      }
    }
  }
`;

const REPO_DETAIL_FIELDS = `
  nameWithOwner
  isPrivate
  url
  ${renovateConfigFields}
  defaultBranchRef {
    name
    target {
      ... on Commit {
        history(first: 100) {
          nodes {
            committedDate url messageHeadline
            author { user { login } }
            associatedPullRequests(first: 5) {
              nodes { state headRefName baseRefName baseRepository { nameWithOwner } }
            }
          }
        }
      }
    }
  }
  renovateIssues: issues(first: 5, states: OPEN, filterBy: { createdBy: $renovateBot }) {
    nodes { title url body }
  }
  merged: pullRequests(states: MERGED, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
    nodes { number title url headRefName mergedAt mergedBy { login __typename } }
  }
  open: pullRequests(states: OPEN, first: 30, orderBy: { field: CREATED_AT, direction: ASC }) {
    nodes {
      number title url headRefName headRefOid createdAt isDraft
    }
  }
`;

function repoDetailsQuery(count) {
  const variables = [
    '$renovateBot: String!',
    ...Array.from({ length: count }, (_, i) => `$owner${i}: String!, $name${i}: String!`),
  ].join(', ');
  const fields = Array.from(
    { length: count },
    (_, i) => `repo${i}: repository(owner: $owner${i}, name: $name${i}) { ${REPO_DETAIL_FIELDS} }`,
  ).join('\n');
  return `query (${variables}) { ${fields} }`;
}

const PULL_REQUEST_FIELDS = `
  number title url state isDraft createdAt updatedAt mergedAt closedAt reviewDecision
  repository { nameWithOwner owner { avatarUrl(size: 40) } }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
`;

const OPEN_CONTRIBUTIONS_QUERY = `
  query ($q: String!) {
    search(type: ISSUE, query: $q, first: 100) {
      nodes {
        ... on PullRequest {
          ${PULL_REQUEST_FIELDS}
          reviews(last: 20) { nodes { state submittedAt author { login __typename } } }
          comments(last: 20) { nodes { createdAt author { login __typename } } }
          reviewThreads(last: 30) {
            nodes { isResolved comments(last: 1) { nodes { createdAt author { login __typename } } } }
          }
        }
      }
    }
  }
`;

const CLOSED_CONTRIBUTIONS_QUERY = `
  query ($q: String!) {
    search(type: ISSUE, query: $q, first: 30) {
      nodes { ... on PullRequest { ${PULL_REQUEST_FIELDS} } }
    }
  }
`;

const AUTHORED_SUBJECT_FIELDS = 'number title updatedAt viewerSubscription repository { nameWithOwner }';

const AUTHORED_QUERY = `
  query ($issues: String!, $discussions: String!) {
    issues: search(type: ISSUE, query: $issues, first: ${AUTHORED_LIMIT}) {
      issueCount
      nodes { ... on Issue { ${AUTHORED_SUBJECT_FIELDS} } }
    }
    discussions: search(type: DISCUSSION, query: $discussions, first: ${AUTHORED_LIMIT}) {
      discussionCount
      nodes { ... on Discussion { ${AUTHORED_SUBJECT_FIELDS} } }
    }
  }
`;

function normalizeRun(run) {
  return {
    workflow: run.name,
    status: run.status,
    conclusion: run.conclusion ? run.conclusion.toUpperCase() : null,
    url: run.html_url,
    createdAt: run.created_at,
    event: run.event,
    author: run.head_commit?.author?.name || run.actor?.login || null,
    headSha: run.head_sha,
  };
}

class GitHubError extends Error {
  constructor(message, details = {}, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'GitHubError';
    Object.assign(this, details);
  }
}

function headerNumber(headers, name) {
  const value = headers.get(name);
  return value === null ? null : Number(value);
}

function responseMeta(response) {
  const reset = headerNumber(response.headers, 'x-ratelimit-reset');
  return {
    status: response.status,
    requestId: response.headers.get('x-github-request-id'),
    rateLimit: {
      limit: headerNumber(response.headers, 'x-ratelimit-limit'),
      remaining: headerNumber(response.headers, 'x-ratelimit-remaining'),
      resetAt: reset === null ? null : new Date(reset * 1000).toISOString(),
    },
    retryAfter: response.headers.get('retry-after'),
  };
}

function createGitHubClient({
  token,
  renovateBot = 'renovate[bot]',
  fetchImpl = fetch,
  logger = createLogger({ level: 'warn' }),
}) {
  if (!token) {
    throw new Error('GITHUB_TOKEN is required');
  }

  const rateLimits = new Map();
  const partialSignatures = new Map();
  const restCache = new Map();
  const restWarnings = new Map();

  async function send(operation, url, init = {}) {
    try {
      return await fetchImpl(url, {
        ...init,
        headers: {
          Authorization: `bearer ${token}`,
          'User-Agent': 'gh-ops-pr-dashboard',
          ...init.headers,
        },
      });
    } catch (error) {
      throw new GitHubError(`GitHub request "${operation}" failed before a response`, { operation }, error);
    }
  }

  function track(response) {
    const meta = responseMeta(response);
    const resource = response.headers.get('x-ratelimit-resource') || 'graphql';
    if (meta.rateLimit.remaining !== null) rateLimits.set(resource, meta.rateLimit);
    return meta;
  }

  async function graphql(operation, query, variables = {}) {
    const started = Date.now();
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) };

    let response = await send(operation, GRAPHQL_URL, init);
    let retried = false;
    if (RETRYABLE_STATUSES.has(response.status)) {
      logger.debug('retrying GitHub request', { operation, ...responseMeta(response) });
      retried = true;
      response = await send(operation, GRAPHQL_URL, init);
    }

    const meta = track(response);
    const context = { operation, variables, retried, durationMs: Date.now() - started, ...meta };

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new GitHubError(`GitHub GraphQL "${operation}" responded ${response.status}`, {
        ...context,
        responseBody: text.slice(0, 1000),
      });
    }

    const payload = await response.json();
    const graphqlErrors = (payload.errors || []).map(({ type, message, path }) => ({ type, message, path }));

    if (graphqlErrors.length && !payload.data) {
      throw new GitHubError(`GitHub GraphQL "${operation}" failed: ${graphqlErrors[0].message}`, {
        ...context,
        graphqlErrors,
      });
    }

    if (graphqlErrors.length) {
      const signature = JSON.stringify(graphqlErrors);
      const level = partialSignatures.get(operation) === signature ? 'debug' : 'warn';
      partialSignatures.set(operation, signature);
      logger[level]('GitHub returned partial data', { ...context, graphqlErrors });
    } else {
      partialSignatures.delete(operation);
    }

    return payload.data;
  }

  async function rest(operation, path, { notificationPage = false } = {}) {
    const started = Date.now();
    const cached = restCache.get(path);
    if (notificationPage && cached?.pollAfter > started) return cached;
    const init = { redirect: 'error', headers: {
      Accept: 'application/vnd.github+json',
      ...(cached?.etag ? { 'If-None-Match': cached.etag } : {}),
      ...(cached?.lastModified ? { 'If-Modified-Since': cached.lastModified } : {}),
    } };

    let response = await send(operation, `${API_URL}${path}`, init);
    let retried = false;
    if (RETRYABLE_STATUSES.has(response.status)) {
      retried = true;
      response = await send(operation, `${API_URL}${path}`, init);
    }

    const meta = track(response);
    const pollInterval = headerNumber(response.headers, 'x-poll-interval');
    if (response.status === 304 && cached) {
      cached.pollInterval = pollInterval ?? cached.pollInterval;
      cached.pollAfter = Date.now() + (cached.pollInterval || 0) * 1000;
      return notificationPage ? cached : cached.body;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new GitHubError(`GitHub REST "${operation}" responded ${response.status}`, {
        operation,
        path,
        retried,
        durationMs: Date.now() - started,
        ...meta,
        responseBody: text.slice(0, 1000),
      });
    }

    const body = await response.json();
    const etag = response.headers.get('etag');
    const entry = {
      body, etag, lastModified: response.headers.get('last-modified'),
      link: response.headers.get('link'), pollInterval,
      pollAfter: Date.now() + (pollInterval || 0) * 1000,
    };
    if (notificationPage || etag || entry.lastModified) restCache.set(path, entry);
    else restCache.delete(path);
    return notificationPage ? entry : body;
  }

  async function fetchSubscriptions({ excludeOwners = [], stateClient, viewer } = {}) {
    const warnings = [];
    const excluded = new Set(excludeOwners.map((owner) => owner.toLowerCase()));
    const candidates = new Map();
    const visited = new Set();
    let path = '/notifications?all=true&participating=true&per_page=100';
    let truncated = false;

    for (let page = 0; path && page < NOTIFICATION_PAGE_LIMIT; page++) {
      if (visited.has(path)) { truncated = true; break; }
      visited.add(path);
      const response = await rest('notifications', path, { notificationPage: true });
      for (const thread of response.body) {
        const { subject, repository } = thread;
        const authored = thread.reason === 'author';
        if ((thread.reason !== 'manual' && !authored) || !['Issue', 'Discussion'].includes(subject?.type)) continue;
        const repo = repository?.full_name;
        const [owner, name] = (repo || '').split('/');
        if (excluded.has(owner?.toLowerCase())) continue;
        const kind = { Issue: 'issues', Discussion: 'discussions' }[subject.type];
        // Never follow a subject URL: validate its identity, then build our own query and browser URL.
        const match = subject.url?.match(/^https:\/\/api\.github\.com\/repos\/([\w.-]+)\/([\w.-]+)\/(issues|discussions)\/([1-9]\d*)$/);
        if (!match || `${match[1]}/${match[2]}`.toLowerCase() !== repo?.toLowerCase() || match[3] !== kind || !/^[1-9]\d*$/.test(String(thread.id)) || !Number.isSafeInteger(Number(match[4]))) {
          warnings.push(`Invalid notification subject for thread ${thread.id}; skipped.`);
          continue;
        }
        const key = `${repo.toLowerCase()}/${kind}/${match[4]}`;
        if (candidates.has(key)) continue;
        if (candidates.size === SUBSCRIPTION_LIMIT) { truncated = true; break; }
        candidates.set(key, {
          id: String(thread.id), url: `https://github.com/${owner}/${name}/${kind}/${match[4]}`,
          repo, owner, number: Number(match[4]), title: subject.title, type: subject.type, authored,
          unread: Boolean(thread.unread), updatedAt: thread.updated_at,
          subscribed: null, state: null, closedAt: null,
        });
      }
      const next = response.link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      path = null;
      if (next) {
        try {
          const url = new URL(next);
          if (url.origin !== API_URL || url.pathname !== '/notifications' || url.username || url.password || url.hash) throw new Error('Invalid pagination URL');
          path = `${url.pathname}${url.search}`;
        } catch {
          warnings.push('Invalid notification pagination link; discovery stopped.');
          truncated = true;
        }
      }
      if (truncated || (candidates.size === SUBSCRIPTION_LIMIT && path)) { truncated = true; break; }
    }
    if (path) truncated = true;
    if (truncated) warnings.push(`Subscription discovery truncated at ${SUBSCRIPTION_LIMIT} subjects or ${NOTIFICATION_PAGE_LIMIT} notification pages.`);

    const threads = [];
    for (const thread of candidates.values()) {
      try {
        const subscription = await rest('thread-subscription', `/notifications/threads/${thread.id}/subscription`);
        if (subscription.subscribed === false || subscription.ignored === true) continue;
        thread.subscribed = typeof subscription.subscribed === 'boolean' ? subscription.subscribed : null;
        if (thread.subscribed === null) warnings.push(`Subscription status unknown for thread ${thread.id}.`);
      } catch (error) {
        if (error.status === 404) continue;
        warnings.push(`Subscription status unknown for thread ${thread.id}: ${error.message}`);
      }
      threads.push(thread);
    }

    if (viewer) {
      const scope = [`author:${viewer}`, 'is:open', ...excludeOwners.map((owner) => `-user:${owner}`)].join(' ');
      try {
        if (!stateClient) throw new Error('Viewer state client unavailable');
        // Discussion search returns nothing at all when given archived:false.
        const data = await stateClient.graphql('authored-subjects', AUTHORED_QUERY, { issues: `is:issue archived:false ${scope}`, discussions: scope });
        if (data.issues.issueCount > AUTHORED_LIMIT || data.discussions.discussionCount > AUTHORED_LIMIT) {
          truncated = true;
          warnings.push(`Authored issue and discussion discovery truncated at ${AUTHORED_LIMIT} each.`);
        }
        const subjects = [
          ...data.issues.nodes.map((node) => ({ ...node, type: 'Issue', kind: 'issues' })),
          ...data.discussions.nodes.map((node) => ({ ...node, type: 'Discussion', kind: 'discussions' })),
        ];
        for (const subject of subjects) {
          const repo = subject.repository?.nameWithOwner;
          const [owner, name] = (repo || '').split('/');
          if (!owner || !name || !Number.isSafeInteger(subject.number) || excluded.has(owner.toLowerCase())) continue;
          if (subject.viewerSubscription === 'UNSUBSCRIBED' || subject.viewerSubscription === 'IGNORED') continue;
          // Keys of dropped (unsubscribed) notification threads stay in candidates, so they are not re-added here.
          const key = `${repo.toLowerCase()}/${subject.kind}/${subject.number}`;
          if (candidates.has(key)) continue;
          candidates.set(key, null);
          threads.push({
            id: null, url: `https://github.com/${owner}/${name}/${subject.kind}/${subject.number}`,
            repo, owner, number: subject.number, title: subject.title, type: subject.type, authored: true,
            unread: false, updatedAt: subject.updatedAt,
            subscribed: subject.viewerSubscription === 'SUBSCRIBED' ? true : null,
            state: 'OPEN', closedAt: null,
          });
        }
      } catch (error) {
        warnings.push(`Authored issues and discussions unavailable: ${error.message}`);
      }
    }
    return { threads, warnings, truncated };
  }

  async function unsubscribe(threadId) {
    if (!/^[1-9]\d*$/.test(String(threadId))) throw new Error('Invalid notification thread ID');
    const path = `/notifications/threads/${threadId}/subscription`;
    const response = await send('unsubscribe', `${API_URL}${path}`, {
      method: 'DELETE', redirect: 'error', headers: { Accept: 'application/vnd.github+json' },
    });
    const meta = track(response);
    if (!response.ok) throw new GitHubError(`GitHub REST "unsubscribe" responded ${response.status}`, { operation: 'unsubscribe', path, ...meta });
    restCache.delete(path);
  }

  async function fetchActionRuns(nameWithOwner, branch) {
    const base = `/repos/${nameWithOwner}/actions/runs?exclude_pull_requests=true`;
    try {
      const [onDefault, recent] = await Promise.all([
        branch ? rest('action-runs', `${base}&branch=${encodeURIComponent(branch)}&per_page=${DEFAULT_BRANCH_RUNS}`) : null,
        rest('action-runs', `${base}&per_page=${RECENT_RUNS}`),
      ]);
      restWarnings.delete(nameWithOwner);
      return {
        defaultBranch: (onDefault?.workflow_runs || []).map(normalizeRun),
        recent: recent.workflow_runs.map(normalizeRun),
      };
    } catch (error) {
      const level = restWarnings.get(nameWithOwner) === error.message ? 'debug' : 'warn';
      restWarnings.set(nameWithOwner, error.message);
      logger[level]('workflow runs unavailable for repository', { repo: nameWithOwner, error });
      return null;
    }
  }

  async function fetchViewer() {
    const data = await graphql('viewer', 'query { viewer { login } }');
    return data.viewer.login;
  }

  async function listOwnerRepos(owner) {
    const repos = [];
    let cursor = null;

    do {
      const data = await graphql('repo-list', REPO_LIST_QUERY, { owner, cursor });
      if (!data.repositoryOwner) {
        throw new GitHubError(`GitHub owner "${owner}" not found or not visible to its token`, { operation: 'repo-list', owner });
      }
      const { repositories } = data.repositoryOwner;
      repos.push(...repositories.nodes.map((repo) => ({ owner, name: repo.name })));
      cursor = repositories.pageInfo.hasNextPage ? repositories.pageInfo.endCursor : null;
    } while (cursor);

    return repos;
  }

  async function fetchRepoBatch(batch) {
    const variables = Object.fromEntries([
      ['renovateBot', renovateBot],
      ...batch.flatMap((repo, i) => [[`owner${i}`, repo.owner], [`name${i}`, repo.name]]),
    ]);
    const data = await graphql('repo-details', repoDetailsQuery(batch.length), variables);

    const repos = batch.map((_, i) => data[`repo${i}`]).filter(Boolean);
    return Promise.all(
      repos.map(async (repo) => ({
        ...repo,
        renovateBot,
        hasRenovateConfig: RENOVATE_CONFIG_FILES.some((_, index) => repo[`renovateConfig${index}`]),
        actionRuns: await fetchActionRuns(repo.nameWithOwner, repo.defaultBranchRef?.name),
      })),
    );
  }

  async function fetchOwnerRepos(owner) {
    const list = await listOwnerRepos(owner);
    const batches = [];
    for (let i = 0; i < list.length; i += REPO_BATCH_SIZE) {
      batches.push(list.slice(i, i + REPO_BATCH_SIZE));
    }
    return (await Promise.all(batches.map(fetchRepoBatch))).flat();
  }

  async function fetchContributions({ viewer, excludeOwners = [], closedSince }) {
    const base = [`is:pr author:${viewer} archived:false`, ...excludeOwners.map((owner) => `-user:${owner}`)].join(' ');
    const isPullRequest = (node) => node && node.number;

    const [open, closed] = await Promise.all([
      graphql('contributions-open', OPEN_CONTRIBUTIONS_QUERY, { q: `${base} is:open` }),
      graphql('contributions-closed', CLOSED_CONTRIBUTIONS_QUERY, { q: `${base} is:closed closed:>=${closedSince} sort:updated-desc` }),
    ]);

    return {
      openPullRequests: open.search.nodes.filter(isPullRequest),
      closedPullRequests: closed.search.nodes.filter(isPullRequest),
    };
  }

  function lowestRateLimit() {
    return [...rateLimits.values()].sort((a, b) => a.remaining / a.limit - b.remaining / b.limit)[0] || null;
  }

  async function fetchTrackedSubjects(entries, { viewer } = {}) {
    const subjects = new Map();
    const warnings = [];
    const self = String(viewer ?? '').toLowerCase();
    const unknown = () => ({ title: null, updatedAt: null, state: null, closedAt: null, subscribed: null, activityAt: null });
    const valid = [];
    for (const entry of entries || []) {
      const [owner, name, ...rest] = String(entry?.repo ?? '').split('/');
      const label = `${entry?.repo}#${entry?.number}`;
      if (!/^[\w.-]+$/.test(owner || '') || !/^[\w.-]+$/.test(name || '') || rest.length
        || String(entry.owner ?? '').toLowerCase() !== owner.toLowerCase() || !['Issue', 'Discussion'].includes(entry.type)
        || !Number.isSafeInteger(entry.number) || entry.number <= 0) {
        warnings.push(`Skipped invalid tracked entry ${label}.`);
        continue;
      }
      valid.push({ entry, owner, name, label });
    }

    for (let start = 0; start < valid.length; start += REPO_BATCH_SIZE) {
      const batch = valid.slice(start, start + REPO_BATCH_SIZE);
      const fields = batch.map(({ entry, owner, name }, i) => {
        const [field, selection] = entry.type === 'Discussion'
          ? ['discussion', `title updatedAt closed closedAt viewerSubscription ${LAST_COMMENT}`]
          : ['issue', `title updatedAt state closedAt viewerSubscription ${LAST_COMMENT}`];
        return `repo${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { subject: ${field}(number: ${entry.number}) { ${selection} } }`;
      });
      let data;
      try {
        data = await graphql('tracked-subjects', `query { ${fields.join('\n')} }`);
      } catch (error) {
        warnings.push(`Tracked subjects unavailable: ${error.message}`);
      }
      if (!data) continue;
      batch.forEach(({ entry, label }, i) => {
        const subject = data?.[`repo${i}`]?.subject;
        if (!subject) {
          subjects.set(entry.url, unknown());
          warnings.push(`Tracked subject ${label} unavailable.`);
          return;
        }
        let state = null;
        if (entry.type === 'Discussion') {
          if (typeof subject.closed === 'boolean') state = subject.closed ? 'CLOSED' : 'OPEN';
        } else if (subject.state === 'OPEN' || subject.state === 'CLOSED') {
          state = subject.state;
        }
        const subscribed = subject.viewerSubscription === 'SUBSCRIBED' ? true
          : (subject.viewerSubscription === 'UNSUBSCRIBED' || subject.viewerSubscription === 'IGNORED' ? false : null);
        const comment = subject.comments?.nodes?.at(-1);
        const byViewer = Boolean(self) && String(comment?.author?.login ?? '').toLowerCase() === self;
        const otherCommentAt = comment?.createdAt && !byViewer ? comment.createdAt : null;
        const closedAt = subject.closedAt ?? null;
        const activityAt = [closedAt, otherCommentAt].filter((at) => Number.isFinite(Date.parse(at)))
          .reduce((best, at) => (best === null || Date.parse(at) > Date.parse(best) ? at : best), null);
        subjects.set(entry.url, { title: subject.title ?? null, updatedAt: subject.updatedAt ?? null, state, closedAt, subscribed, activityAt });
      });
    }
    return { subjects, warnings };
  }

  return { fetchContributions, fetchOwnerRepos, fetchViewer, fetchSubscriptions, fetchTrackedSubjects, unsubscribe, graphql, rest, rateLimit: lowestRateLimit };
}

function parseOwnerTokens(raw) {
  if (!raw) throw new Error('GITHUB_TOKENS is required, e.g. {"my-user":"github_pat_...","my-org":"github_pat_..."}');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('GITHUB_TOKENS must be a JSON object mapping owner to token', { cause: error });
  }

  const entries = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.entries(parsed) : [];
  const invalid = entries.filter(([, token]) => typeof token !== 'string' || !token.trim()).map(([owner]) => owner);
  if (entries.length === 0) throw new Error('GITHUB_TOKENS must contain at least one owner');
  if (invalid.length) throw new Error(`GITHUB_TOKENS has empty tokens for: ${invalid.join(', ')}`);
  return Object.fromEntries(entries.map(([owner, token]) => [owner, token.trim()]));
}

export { GitHubError, RENOVATE_CONFIG_FILES, createGitHubClient, parseOwnerTokens };
