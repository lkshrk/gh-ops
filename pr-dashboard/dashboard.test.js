import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  attentionReasons,
  parseRenovateDashboard,
  renovateHealth,
  buildContributions,
  buildSnapshot,
  summarizeRenovate,
  summarizeWorkflows,
} from './dashboard.js';
import { GitHubError, createGitHubClient, parseOwnerTokens } from './github.js';
import { createLogger } from './log.js';

const me = { login: 'me', __typename: 'User' };
const maintainer = { login: 'maintainer', __typename: 'User' };
const bot = { login: 'codecov', __typename: 'Bot' };

function pullRequest(overrides = {}) {
  return {
    number: 1,
    title: 'Fix thing',
    url: 'https://github.com/up/stream/pull/1',
    state: 'OPEN',
    isDraft: false,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-05T00:00:00Z',
    reviewDecision: null,
    repository: { nameWithOwner: 'up/stream', owner: { avatarUrl: 'https://avatars.githubusercontent.com/u/1' } },
    commits: { nodes: [{ commit: { committedDate: '2026-09-02T00:00:00Z', statusCheckRollup: { state: 'SUCCESS' } } }] },
    reviews: { nodes: [] },
    comments: { nodes: [] },
    reviewThreads: { nodes: [] },
    ...overrides,
  };
}

test('attentionReasons is empty when nobody spoke after my last push', () => {
  const pr = pullRequest({
    comments: { nodes: [{ createdAt: '2026-09-01T12:00:00Z', author: maintainer }] },
  });

  assert.deepEqual(attentionReasons(pr, 'me'), []);
});

test('attentionReasons flags a maintainer comment newer than my last activity', () => {
  const pr = pullRequest({
    comments: { nodes: [{ createdAt: '2026-09-03T00:00:00Z', author: maintainer }] },
  });

  assert.deepEqual(attentionReasons(pr, 'me'), ['awaiting-reply']);
});

test('attentionReasons ignores bots, approvals and comments I already answered', () => {
  const pr = pullRequest({
    reviews: { nodes: [{ state: 'APPROVED', submittedAt: '2026-09-04T00:00:00Z', author: maintainer }] },
    comments: {
      nodes: [
        { createdAt: '2026-09-03T00:00:00Z', author: maintainer },
        { createdAt: '2026-09-03T01:00:00Z', author: me },
        { createdAt: '2026-09-04T00:00:00Z', author: bot },
      ],
    },
  });

  assert.deepEqual(attentionReasons(pr, 'me'), []);
});

test('attentionReasons flags failing CI, requested changes and unresolved threads', () => {
  const pr = pullRequest({
    reviewDecision: 'CHANGES_REQUESTED',
    commits: { nodes: [{ commit: { committedDate: '2026-09-10T00:00:00Z', statusCheckRollup: { state: 'FAILURE' } } }] },
    reviewThreads: {
      nodes: [
        { isResolved: false, comments: { nodes: [{ createdAt: '2026-09-01T00:00:00Z', author: maintainer }] } },
        { isResolved: true, comments: { nodes: [{ createdAt: '2026-09-01T00:00:00Z', author: maintainer }] } },
      ],
    },
  });

  assert.deepEqual(attentionReasons(pr, 'me'), ['ci-failing', 'changes-requested', 'awaiting-reply']);
});

test('attentionReasons never flags closed pull requests', () => {
  const pr = pullRequest({ state: 'MERGED', reviewDecision: 'CHANGES_REQUESTED' });

  assert.deepEqual(attentionReasons(pr, 'me'), []);
});

test('buildContributions splits open pull requests by attention and orders closed by close date', () => {
  const quiet = pullRequest({ number: 1 });
  const red = pullRequest({
    number: 2,
    commits: { nodes: [{ commit: { committedDate: '2026-09-02T00:00:00Z', statusCheckRollup: { state: 'ERROR' } } }] },
  });
  const older = pullRequest({ number: 3, state: 'CLOSED', closedAt: '2026-09-01T00:00:00Z' });
  const newer = pullRequest({ number: 4, state: 'MERGED', closedAt: '2026-09-09T00:00:00Z', mergedAt: '2026-09-09T00:00:00Z' });

  const result = buildContributions([quiet, red], [older, newer], 'me');

  assert.deepEqual(result.attention.map((pr) => pr.number), [2]);
  assert.equal(result.attention[0].ci, 'failure');
  assert.deepEqual(result.open.map((pr) => pr.number), [1]);
  assert.deepEqual(result.closed.map((pr) => pr.number), [4, 3]);
});

function suite(name, conclusion, createdAt, overrides = {}) {
  return {
    status: 'COMPLETED',
    conclusion,
    app: { slug: 'github-actions' },
    workflowRun: { url: `https://github.com/me/app/actions/runs/${createdAt}`, createdAt, event: 'schedule', workflow: { name } },
    ...overrides,
  };
}

function repoWithCommits(commitSuites, overrides = {}) {
  return {
    nameWithOwner: 'me/app',
    isPrivate: false,
    url: 'https://github.com/me/app',
    defaultBranchRef: {
      name: 'main',
      target: {
        history: {
          nodes: commitSuites.map((suites) => ({
            author: { name: 'Renovate Bot', user: { login: 'renovate-master[bot]' } },
            checkSuites: { nodes: suites },
          })),
        },
      },
    },
    merged: { nodes: [] },
    open: { nodes: [] },
    ...overrides,
  };
}

test('summarizeWorkflows separates constant failures from a single red run', () => {
  const repo = repoWithCommits([
    [suite('Release', 'FAILURE', '2026-09-04'), suite('CI', 'FAILURE', '2026-09-04')],
    [suite('Release', 'TIMED_OUT', '2026-09-03'), suite('CI', 'SUCCESS', '2026-09-03')],
    [suite('Release', 'FAILURE', '2026-09-02')],
    [suite('Release', 'SUCCESS', '2026-09-01')],
  ]);

  const { failing, recent } = summarizeWorkflows([repo], { failStreak: 3 });

  assert.equal(failing.length, 1);
  assert.equal(failing[0].workflow, 'Release');
  assert.equal(failing[0].streak, 3);
  assert.equal(failing[0].streakCapped, false);
  assert.equal(failing[0].failingSince, '2026-09-02');
  assert.equal(failing[0].failRate, 0.75);
  assert.equal(failing[0].latestRun.author, 'renovate-master[bot]');
  assert.equal(failing[0].latestRun.event, 'schedule');
  assert.deepEqual(recent.map((entry) => [entry.workflow, entry.streak]), [['CI', 1]]);
});

test('summarizeWorkflows skips cancelled, running and non-Actions suites', () => {
  const repo = repoWithCommits([
    [
      suite('CI', 'CANCELLED', '2026-09-05'),
      suite('CI', null, '2026-09-05', { status: 'IN_PROGRESS' }),
      suite('CI', 'FAILURE', '2026-09-05', { app: { slug: 'codecov' } }),
    ],
    [suite('CI', 'SUCCESS', '2026-09-04')],
  ]);

  const { failing, recent } = summarizeWorkflows([repo]);

  assert.deepEqual(failing, []);
  assert.deepEqual(recent, []);
});

test('summarizeWorkflows reads check suites newest first within a commit', () => {
  const repo = repoWithCommits([[suite('Nightly', 'FAILURE', '2026-09-01'), suite('Nightly', 'SUCCESS', '2026-09-02')]]);

  assert.deepEqual(summarizeWorkflows([repo]).recent, []);
});

test('summarizeWorkflows marks a streak that fills the whole window as capped', () => {
  const repo = repoWithCommits([[suite('CI', 'FAILURE', '2026-09-03')], [suite('CI', 'FAILURE', '2026-09-02')], [suite('CI', 'FAILURE', '2026-09-01')]]);

  const [entry] = summarizeWorkflows([repo]).failing;

  assert.equal(entry.streakCapped, true);
});

function renovatePr(number, extra = {}) {
  return { number, title: `Update dep ${number}`, url: `https://github.com/me/app/pull/${number}`, headRefName: `renovate/dep-${number}`, ...extra };
}

test('summarizeRenovate ranks repositories by oldest merged Renovate update', () => {
  const fresh = repoWithCommits([], {
    nameWithOwner: 'me/fresh',
    hasRenovateConfig: true,
    merged: {
      nodes: [
        renovatePr(1, { mergedAt: '2026-09-01T00:00:00Z' }),
        renovatePr(2, { mergedAt: '2026-09-20T00:00:00Z' }),
        { ...renovatePr(3, { mergedAt: '2026-09-25T00:00:00Z' }), headRefName: 'feature/x' },
      ],
    },
  });
  const stale = repoWithCommits([], {
    nameWithOwner: 'org/stale',
    hasRenovateConfig: true,
    merged: { nodes: [renovatePr(4, { mergedAt: '2026-06-01T00:00:00Z' })] },
    open: {
      nodes: [
        renovatePr(5, {
          createdAt: '2026-08-01T00:00:00Z',
          commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
        }),
      ],
    },
  });
  const never = repoWithCommits([], { nameWithOwner: 'me/never', hasRenovateConfig: true });

  const { repos } = summarizeRenovate([fresh, stale, never]);

  assert.deepEqual(repos.map((repo) => repo.repo), ['me/never', 'org/stale', 'me/fresh']);
  assert.equal(repos[2].lastMerged.number, 2);
  assert.equal(repos[1].owner, 'org');
  assert.deepEqual(repos[1].open.map((pr) => [pr.number, pr.ci]), [[5, 'failure']]);
});

test('summarizeRenovate separates onboarding and repositories without Renovate', () => {
  const onboarding = repoWithCommits([], {
    nameWithOwner: 'me/new',
    open: { nodes: [{ ...renovatePr(1, { createdAt: '2026-05-31T00:00:00Z' }), headRefName: 'renovate/configure' }] },
  });
  const none = repoWithCommits([], { nameWithOwner: 'me/none' });

  const result = summarizeRenovate([onboarding, none]);

  assert.deepEqual(result.repos, []);
  assert.deepEqual(result.onboarding.map((repo) => [repo.repo, repo.pullRequest.number]), [['me/new', 1]]);
  assert.deepEqual(result.untracked.map((repo) => repo.repo), ['me/none']);
});

test('buildSnapshot lists the viewer first among owners', () => {
  const repos = ['zeta/a', 'me/b', 'alpha/c'].map((nameWithOwner) => repoWithCommits([], { nameWithOwner }));

  const snapshot = buildSnapshot({ viewer: 'me', repos, openPullRequests: [], closedPullRequests: [], now: new Date(0) });

  assert.deepEqual(snapshot.owners, ['me', 'alpha', 'zeta']);
  assert.equal(snapshot.repoCount, 3);
  assert.equal(snapshot.generatedAt, '1970-01-01T00:00:00.000Z');
});

function scriptedFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const next = responses.shift();
    return typeof next === 'function' ? next(body) : next;
  };
  return { calls, fetchImpl };
}

function jsonResponse(data, status = 200, headers = {}) {
  return {
    ok: status < 400,
    status,
    headers: new Headers(headers),
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function recordingLogger() {
  const lines = [];
  return { lines, logger: createLogger({ level: 'debug', write: (line) => lines.push(JSON.parse(line)) }) };
}

test('fetchOwnerRepos lists one owner\'s repositories, then fetches details in batches', async () => {
  const names = Array.from({ length: 7 }, (_, i) => ({ name: `repo${i}` }));
  const detail = (body) =>
    jsonResponse({
      data: Object.fromEntries(
        Object.keys(body.variables)
          .filter((key) => key.startsWith('name'))
          .map((key) => [
            `repo${key.slice(4)}`,
            { nameWithOwner: `me/${body.variables[key]}`, renovateConfig6: key === 'name0' ? { id: 'x' } : null },
          ]),
      ),
    });
  const { calls, fetchImpl } = scriptedFetch([
    jsonResponse({ data: { repositoryOwner: { repositories: { pageInfo: { hasNextPage: false }, nodes: names } } } }),
    detail,
    detail,
  ]);

  const repos = await createGitHubClient({ token: 't', fetchImpl }).fetchOwnerRepos('me');

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].variables, { owner: 'me', cursor: null });
  assert.deepEqual(repos.map((repo) => repo.nameWithOwner), names.map((repo) => `me/${repo.name}`));
  assert.deepEqual(repos.map((repo) => repo.hasRenovateConfig), [true, false, false, false, false, false, true]);
});

test('graphql retries a gateway timeout once', async () => {
  const { calls, fetchImpl } = scriptedFetch([jsonResponse({}, 502), jsonResponse({ data: { viewer: { login: 'me' } } })]);

  const login = await createGitHubClient({ token: 't', fetchImpl }).fetchViewer();

  assert.equal(login, 'me');
  assert.equal(calls.length, 2);
});

test('fetchContributions excludes own owners from the search', async () => {
  const empty = jsonResponse({ data: { search: { nodes: [{}] } } });
  const { calls, fetchImpl } = scriptedFetch([empty, empty]);

  const result = await createGitHubClient({ token: 't', fetchImpl }).fetchContributions({
    viewer: 'me',
    excludeOwners: ['me', 'my-org'],
    closedSince: '2026-09-01',
  });

  assert.deepEqual(result, { openPullRequests: [], closedPullRequests: [] });
  assert.equal(calls[0].variables.q, 'is:pr author:me archived:false -user:me -user:my-org is:open');
  assert.equal(calls[1].variables.q, 'is:pr author:me archived:false -user:me -user:my-org is:closed closed:>=2026-09-01 sort:updated-desc');
});

test('summarizeRenovate splits recent merges into automerged and merged by hand', () => {
  const bot = { login: 'renovate-master', __typename: 'Bot' };
  const human = { login: 'me', __typename: 'User' };
  const repo = repoWithCommits([], {
    hasRenovateConfig: true,
    merged: {
      nodes: [
        renovatePr(1, { mergedAt: '2026-10-03T00:00:00Z', mergedBy: bot }),
        renovatePr(2, { mergedAt: '2026-10-02T00:00:00Z', mergedBy: bot }),
        renovatePr(3, { mergedAt: '2026-10-01T00:00:00Z', mergedBy: human }),
        renovatePr(4, { mergedAt: '2026-09-01T00:00:00Z', mergedBy: bot }),
        { ...renovatePr(5, { mergedAt: '2026-10-03T00:00:00Z', mergedBy: human }), headRefName: 'feature/x' },
      ],
    },
  });

  const result = summarizeRenovate([repo], { now: new Date('2026-10-04T00:00:00Z') });

  assert.deepEqual(result.repos[0].recentlyMerged, { automerged: 2, manual: 1 });
  assert.deepEqual(result.stats, { windowDays: 7, capped: false });
});

test('summarizeRenovate flags merge counts capped by the fetch limit', () => {
  const merged = Array.from({ length: 50 }, (_, i) => renovatePr(i, { mergedAt: '2026-10-03T00:00:00Z' }));
  const repo = repoWithCommits([], { hasRenovateConfig: true, merged: { nodes: merged } });

  const result = summarizeRenovate([repo], { now: new Date('2026-10-04T00:00:00Z') });

  assert.equal(result.stats.capped, true);
});

test('graphql errors carry status, request id, rate limit and response body', async () => {
  const headers = {
    'x-github-request-id': 'ABCD:1234',
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': '1790000000',
  };
  const { fetchImpl } = scriptedFetch([jsonResponse({ message: 'API rate limit exceeded' }, 403, headers)]);
  const client = createGitHubClient({ token: 't', fetchImpl });

  const error = await client.fetchViewer().catch((caught) => caught);

  assert.ok(error instanceof GitHubError);
  assert.equal(error.operation, 'viewer');
  assert.equal(error.status, 403);
  assert.equal(error.requestId, 'ABCD:1234');
  assert.deepEqual(error.rateLimit, { limit: 5000, remaining: 0, resetAt: '2026-09-21T14:13:20.000Z' });
  assert.match(error.responseBody, /rate limit exceeded/);
  assert.deepEqual(client.rateLimit(), error.rateLimit);
});

test('graphql wraps network failures with the operation and cause', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };

  const error = await createGitHubClient({ token: 't', fetchImpl }).fetchViewer().catch((caught) => caught);

  assert.equal(error.operation, 'viewer');
  assert.equal(error.cause.message, 'fetch failed');
});

test('graphql reports error paths when GitHub returns no data', async () => {
  const { fetchImpl } = scriptedFetch([
    jsonResponse({ errors: [{ type: 'NOT_FOUND', message: 'Could not resolve', path: ['viewer'] }] }),
  ]);

  const error = await createGitHubClient({ token: 't', fetchImpl }).fetchViewer().catch((caught) => caught);

  assert.deepEqual(error.graphqlErrors, [{ type: 'NOT_FOUND', message: 'Could not resolve', path: ['viewer'] }]);
});

test('graphql warns about partial data once until the errors change', async () => {
  const partial = (message) =>
    jsonResponse({ data: { viewer: { login: 'me' } }, errors: [{ type: 'FORBIDDEN', message, path: ['repo0'] }] });
  const { fetchImpl } = scriptedFetch([partial('SAML'), partial('SAML'), partial('other')]);
  const { lines, logger } = recordingLogger();
  const client = createGitHubClient({ token: 't', fetchImpl, logger });

  await client.fetchViewer();
  await client.fetchViewer();
  await client.fetchViewer();

  assert.deepEqual(lines.map((line) => line.level), ['warn', 'debug', 'warn']);
  assert.equal(lines[0].graphqlErrors[0].message, 'SAML');
});

test('logger drops lines below its level and serializes errors with cause', () => {
  const lines = [];
  const logger = createLogger({ level: 'info', write: (line) => lines.push(JSON.parse(line)) });

  logger.debug('hidden');
  logger.error('boom', { error: new GitHubError('outer', { status: 502 }, new Error('inner')) });

  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 'error');
  assert.equal(lines[0].error.name, 'GitHubError');
  assert.equal(lines[0].error.status, 502);
  assert.equal(lines[0].error.cause.message, 'inner');
  assert.match(lines[0].error.stack, /outer/);
});

test('fetchOwnerRepos names the owner when its token cannot see it', async () => {
  const { fetchImpl } = scriptedFetch([jsonResponse({ data: { repositoryOwner: null } })]);

  const error = await createGitHubClient({ token: 't', fetchImpl }).fetchOwnerRepos('ghost-org').catch((caught) => caught);

  assert.equal(error.owner, 'ghost-org');
  assert.match(error.message, /ghost-org/);
});

test('parseOwnerTokens accepts an owner to token map and trims tokens', () => {
  assert.deepEqual(parseOwnerTokens('{"me":" github_pat_a ","my-org":"github_pat_b"}'), {
    me: 'github_pat_a',
    'my-org': 'github_pat_b',
  });
});

test('parseOwnerTokens rejects missing, malformed and empty configuration', () => {
  assert.throws(() => parseOwnerTokens(undefined), /GITHUB_TOKENS is required/);
  assert.throws(() => parseOwnerTokens('not json'), /JSON object/);
  assert.throws(() => parseOwnerTokens('["github_pat_a"]'), /at least one owner/);
  assert.throws(() => parseOwnerTokens('{}'), /at least one owner/);
  assert.throws(() => parseOwnerTokens('{"me":"github_pat_a","my-org":""}'), /empty tokens for: my-org/);
});

const hCloudDashboard = [
  'This issue lists Renovate updates and detected dependencies.',
  '',
  '## Repository Problems',
  '',
  'These problems occurred while renovating this repository.',
  '',
  ' - ⚠️ WARN: Package lookup failures',
  '',
  '## Pending Status Checks',
  '',
  ' - [ ] <!-- approvePr-branch=renovate/foo -->chore(deps): update foo',
  '',
  '> [!WARNING]',
  '> Renovate failed to look up the following dependencies: `ghcr.io/lkshrk/hermes-hq: no-result`.',
  '>',
  '> Files affected: `kubernetes/apps/ai/hermes-hq/app/helmrelease.yaml`',
  '',
  '## Rate-Limited',
  '',
  ' - [ ] <!-- unlimit-branch=renovate/a -->update a',
  ' - [ ] <!-- unlimit-branch=renovate/b -->update b',
  ' - [ ] <!-- create-all-rate-limited-prs -->🔐 **Create all rate-limited PRs at once** 🔐',
  '',
  '## PR Edited (Blocked)',
  '',
  ' - [ ] <!-- rebase-branch=renovate/c -->[update c](../pull/61)',
  '',
  '## Open',
  '',
  ' - [ ] <!-- rebase-branch=renovate/d -->[update d](../pull/76)',
  ' - [ ] <!-- rebase-all-open-prs -->**Click on this checkbox to rebase all open PRs at once**',
  '',
  '## Detected Dependencies',
  '',
  '> [!NOTE]',
  '> Detected dependencies section has been truncated',
  ' - `node 24-alpine`',
].join('\n');

test('parseRenovateDashboard extracts problems, warnings and section counts', () => {
  const parsed = parseRenovateDashboard(hCloudDashboard);

  assert.deepEqual(parsed.problems, ['WARN: Package lookup failures']);
  assert.deepEqual(parsed.warnings, [
    'Renovate failed to look up the following dependencies: `ghcr.io/lkshrk/hermes-hq: no-result`. Files affected: `kubernetes/apps/ai/hermes-hq/app/helmrelease.yaml`',
  ]);
  assert.deepEqual(parsed.counts, { pendingChecks: 1, rateLimited: 2, blocked: 1 });
});

test('renovateHealth rates problems as error, blocked PRs as warn and a clean dashboard as ok', () => {
  const issue = (title, body = '') => ({ title, url: `https://github.com/me/app/issues/${title.length}`, body });
  const withIssues = (...issues) => ({ renovateIssues: { nodes: issues } });

  assert.equal(renovateHealth(withIssues(issue('Renovate Dashboard 🤖', hCloudDashboard))).severity, 'error');
  assert.equal(renovateHealth(withIssues(issue('Renovate Dashboard', '## PR Edited (Blocked)\n - [ ] x'))).severity, 'warn');
  assert.equal(renovateHealth(withIssues(issue('Renovate Dashboard', '## Open\n - [ ] x'))).severity, 'ok');
  assert.equal(renovateHealth(withIssues()), null);

  const config = renovateHealth(withIssues(issue('Action Required: Fix Renovate Configuration')));
  assert.equal(config.severity, 'error');
  assert.equal(config.configError.title, 'Action Required: Fix Renovate Configuration');
  assert.equal(config.dashboardUrl, null);
});

test('summarizeRenovate keeps repositories whose only Renovate signal is a dashboard issue', () => {
  const repo = repoWithCommits([], {
    nameWithOwner: 'me/quiet',
    renovateIssues: { nodes: [{ title: 'Renovate Dashboard', url: 'u', body: '## Repository Problems\n - ⚠️ WARN: x' }] },
  });

  const result = summarizeRenovate([repo]);

  assert.deepEqual(result.onboarding, []);
  assert.equal(result.repos[0].health.severity, 'error');
});
