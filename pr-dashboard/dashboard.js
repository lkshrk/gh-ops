const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE']);
const PASSED_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL']);
const REPLY_REVIEW_STATES = new Set(['COMMENTED', 'CHANGES_REQUESTED']);
const RUN_STRIP_LENGTH = 10;
const RENOVATE_WINDOW_DAYS = 7;
const MERGED_FETCH_LIMIT = 50;

function nodes(connection) {
  return (connection && connection.nodes) || [];
}

function latest(dates) {
  return dates.filter(Boolean).sort().at(-1) || null;
}

function ciState(pullRequest) {
  const rollup = nodes(pullRequest.commits)[0]?.commit?.statusCheckRollup?.state;

  if (rollup === 'FAILURE' || rollup === 'ERROR') return 'failure';
  if (rollup === 'PENDING' || rollup === 'EXPECTED') return 'pending';
  if (rollup === 'SUCCESS') return 'success';
  return 'none';
}

function attentionReasons(pullRequest, viewer) {
  if (pullRequest.state !== 'OPEN') return [];

  const isMe = (author) => author?.login === viewer;
  const isOther = (author) => author && !isMe(author) && author.__typename !== 'Bot';
  const reviews = nodes(pullRequest.reviews);
  const comments = nodes(pullRequest.comments);
  const threadTails = nodes(pullRequest.reviewThreads)
    .filter((thread) => !thread.isResolved)
    .map((thread) => nodes(thread.comments).at(-1))
    .filter(Boolean);

  const myLast = latest([
    nodes(pullRequest.commits)[0]?.commit?.committedDate,
    ...reviews.filter((review) => isMe(review.author)).map((review) => review.submittedAt),
    ...comments.filter((comment) => isMe(comment.author)).map((comment) => comment.createdAt),
    ...threadTails.filter((comment) => isMe(comment.author)).map((comment) => comment.createdAt),
  ]);
  const othersLast = latest([
    ...reviews
      .filter((review) => isOther(review.author) && REPLY_REVIEW_STATES.has(review.state))
      .map((review) => review.submittedAt),
    ...comments.filter((comment) => isOther(comment.author)).map((comment) => comment.createdAt),
  ]);
  const openThreads = threadTails.filter((comment) => isOther(comment.author)).length;

  const reasons = [];
  if (ciState(pullRequest) === 'failure') reasons.push('ci-failing');
  if (pullRequest.reviewDecision === 'CHANGES_REQUESTED') reasons.push('changes-requested');
  if (openThreads > 0 || (othersLast && (!myLast || othersLast > myLast))) reasons.push('awaiting-reply');
  return reasons;
}

function summarizeContribution(pullRequest, viewer) {
  const [owner] = pullRequest.repository.nameWithOwner.split('/');

  return {
    repo: pullRequest.repository.nameWithOwner,
    owner,
    avatarUrl: pullRequest.repository.owner?.avatarUrl || null,
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    state: pullRequest.state,
    isDraft: Boolean(pullRequest.isDraft),
    ci: ciState(pullRequest),
    reviewDecision: pullRequest.reviewDecision || null,
    createdAt: pullRequest.createdAt,
    updatedAt: pullRequest.updatedAt,
    closedAt: pullRequest.closedAt || null,
    mergedAt: pullRequest.mergedAt || null,
    reasons: attentionReasons(pullRequest, viewer),
  };
}

function buildContributions(openPullRequests, closedPullRequests, viewer) {
  const byUpdated = (a, b) => b.updatedAt.localeCompare(a.updatedAt);
  const open = openPullRequests.map((pr) => summarizeContribution(pr, viewer)).sort(byUpdated);

  return {
    attention: open.filter((pr) => pr.reasons.length > 0),
    open: open.filter((pr) => pr.reasons.length === 0),
    closed: closedPullRequests
      .map((pr) => summarizeContribution(pr, viewer))
      .sort((a, b) => (b.closedAt || '').localeCompare(a.closedAt || '')),
  };
}

function repoMeta(repo) {
  const [owner, name] = repo.nameWithOwner.split('/');
  return { repo: repo.nameWithOwner, owner, name, private: Boolean(repo.isPrivate), url: repo.url };
}

function runResult(conclusion) {
  if (FAILED_CONCLUSIONS.has(conclusion)) return 'fail';
  if (PASSED_CONCLUSIONS.has(conclusion)) return 'pass';
  return null;
}

function workflowHistory(repo) {
  const byWorkflow = new Map();
  const commits = nodes(repo.defaultBranchRef?.target?.history);

  for (const commit of commits) {
    const author = commit.author?.user?.login || commit.author?.name || null;
    const suites = [...nodes(commit.checkSuites)].reverse();

    for (const suite of suites) {
      const run = suite.workflowRun;
      const result = runResult(suite.conclusion);
      if (suite.app?.slug !== 'github-actions' || !run?.workflow || suite.status !== 'COMPLETED' || !result) {
        continue;
      }

      const runs = byWorkflow.get(run.workflow.name) || [];
      runs.push({ result, url: run.url, createdAt: run.createdAt, event: run.event || null, author });
      byWorkflow.set(run.workflow.name, runs);
    }
  }

  return [...byWorkflow].map(([workflow, runs]) => ({ workflow, runs }));
}

function summarizeWorkflows(repos, { failStreak = 3 } = {}) {
  const failing = [];
  const recent = [];

  for (const repo of repos) {
    for (const { workflow, runs } of workflowHistory(repo)) {
      const firstPass = runs.findIndex((run) => run.result === 'pass');
      const streak = firstPass === -1 ? runs.length : firstPass;
      if (streak === 0) continue;

      const entry = {
        ...repoMeta(repo),
        branch: repo.defaultBranchRef.name,
        workflow,
        streak,
        streakCapped: firstPass === -1,
        failingSince: runs[streak - 1].createdAt,
        latestRun: runs[0],
        failRate: runs.filter((run) => run.result === 'fail').length / runs.length,
        runs: runs.slice(0, RUN_STRIP_LENGTH),
      };
      (streak >= failStreak ? failing : recent).push(entry);
    }
  }

  failing.sort((a, b) => b.streak - a.streak || a.failingSince.localeCompare(b.failingSince));
  recent.sort((a, b) => b.latestRun.createdAt.localeCompare(a.latestRun.createdAt));
  return { failStreak, failing, recent };
}

function summarizeRenovate(repos, { branchPrefix = 'renovate/', now = new Date() } = {}) {
  const isRenovate = (pr) => pr.headRefName.startsWith(branchPrefix);
  const isOnboarding = (pr) => pr.headRefName === `${branchPrefix}configure`;
  const windowStart = new Date(now.getTime() - RENOVATE_WINDOW_DAYS * 86400000).toISOString();
  const stats = { windowDays: RENOVATE_WINDOW_DAYS, capped: false };
  const tracked = [];
  const onboarding = [];
  const untracked = [];

  for (const repo of repos) {
    const mergedAll = nodes(repo.merged);
    const merged = mergedAll.filter(isRenovate).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
    const lastMerged = merged[0];
    const recentlyMerged = merged.filter((pr) => pr.mergedAt >= windowStart);
    const automerged = recentlyMerged.filter((pr) => pr.mergedBy?.__typename === 'Bot').length;
    if (mergedAll.length >= MERGED_FETCH_LIMIT && mergedAll.every((pr) => pr.mergedAt >= windowStart)) {
      stats.capped = true;
    }

    const openRenovate = nodes(repo.open).filter(isRenovate);
    const open = openRenovate.map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      createdAt: pr.createdAt,
      isDraft: Boolean(pr.isDraft),
      ci: ciState(pr),
    }));

    if (!repo.hasRenovateConfig && !lastMerged && open.length === 0) {
      untracked.push(repoMeta(repo));
      continue;
    }

    if (!repo.hasRenovateConfig && !lastMerged && openRenovate.every(isOnboarding)) {
      onboarding.push({ ...repoMeta(repo), pullRequest: open[0] });
      continue;
    }

    tracked.push({
      ...repoMeta(repo),
      hasConfig: Boolean(repo.hasRenovateConfig),
      lastMerged: lastMerged
        ? { number: lastMerged.number, title: lastMerged.title, url: lastMerged.url, mergedAt: lastMerged.mergedAt }
        : null,
      open,
      recentlyMerged: { automerged, manual: recentlyMerged.length - automerged },
    });
  }

  tracked.sort((a, b) => (a.lastMerged?.mergedAt || '').localeCompare(b.lastMerged?.mergedAt || ''));
  return { branchPrefix, stats, repos: tracked, onboarding, untracked };
}

function ownerOrder(repos, viewer) {
  const owners = [...new Set(repos.map((repo) => repo.nameWithOwner.split('/')[0]))];
  return owners.sort((a, b) => (a === viewer ? -1 : b === viewer ? 1 : a.localeCompare(b)));
}

function buildSnapshot({ viewer, repos, openPullRequests, closedPullRequests, options = {}, now = new Date() }) {
  return {
    generatedAt: now.toISOString(),
    viewer,
    owners: ownerOrder(repos, viewer),
    repoCount: repos.length,
    contributions: buildContributions(openPullRequests, closedPullRequests, viewer),
    workflows: summarizeWorkflows(repos, options),
    renovate: summarizeRenovate(repos, { ...options, now }),
  };
}

export {
  attentionReasons,
  buildContributions,
  buildSnapshot,
  ciState,
  ownerOrder,
  summarizeContribution,
  summarizeRenovate,
  summarizeWorkflows,
  workflowHistory,
};
