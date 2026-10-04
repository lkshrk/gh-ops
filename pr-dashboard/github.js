import { createLogger } from './log.js';

const GRAPHQL_URL = 'https://api.github.com/graphql';
const REPO_BATCH_SIZE = 6;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

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
        history(first: 8) {
          nodes {
            author { name user { login } }
            checkSuites(last: 15) {
              nodes {
                status
                conclusion
                app { slug }
                workflowRun { url createdAt event workflow { name } }
              }
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
      number title url headRefName createdAt isDraft
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
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

  let rateLimit = null;
  const partialSignatures = new Map();

  async function send(operation, body) {
    try {
      return await fetchImpl(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          Authorization: `bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'gh-ops-pr-dashboard',
        },
        body,
      });
    } catch (error) {
      throw new GitHubError(`GitHub GraphQL request "${operation}" failed before a response`, { operation }, error);
    }
  }

  async function graphql(operation, query, variables = {}) {
    const started = Date.now();
    const body = JSON.stringify({ query, variables });

    let response = await send(operation, body);
    let retried = false;
    if (RETRYABLE_STATUSES.has(response.status)) {
      logger.debug('retrying GitHub request', { operation, ...responseMeta(response) });
      retried = true;
      response = await send(operation, body);
    }

    const meta = responseMeta(response);
    if (meta.rateLimit.remaining !== null) rateLimit = meta.rateLimit;
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

    return batch
      .map((_, i) => data[`repo${i}`])
      .filter(Boolean)
      .map((repo) => ({
        ...repo,
        hasRenovateConfig: RENOVATE_CONFIG_FILES.some((_, index) => repo[`renovateConfig${index}`]),
      }));
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

  return { fetchContributions, fetchOwnerRepos, fetchViewer, graphql, rateLimit: () => rateLimit };
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
