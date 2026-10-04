const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE']);
const PASSED_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL']);
const REPLY_REVIEW_STATES = new Set(['COMMENTED', 'CHANGES_REQUESTED']);
const RUN_STRIP_LENGTH = 10;
const RENOVATE_WINDOW_DAYS = 7;
const MERGED_FETCH_LIMIT = 50;

function nodes(connection) {
  return ((connection && connection.nodes) || []).filter(Boolean);
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
  const runs = [...(repo.actionRuns?.defaultBranch || [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  for (const run of runs) {
    const result = runResult(run.conclusion);
    if (run.status !== 'completed' || !result) continue;

    const history = byWorkflow.get(run.workflow) || [];
    history.push({ result, url: run.url, createdAt: run.createdAt, event: run.event, author: run.author });
    byWorkflow.set(run.workflow, history);
  }

  return [...byWorkflow].map(([workflow, history]) => ({ workflow, runs: history }));
}

function runsCiState(runs, sha) {
  const latestByWorkflow = new Map();
  for (const run of runs) {
    if (run.headSha !== sha) continue;
    const seen = latestByWorkflow.get(run.workflow);
    if (!seen || run.createdAt > seen.createdAt) latestByWorkflow.set(run.workflow, run);
  }

  const latest = [...latestByWorkflow.values()];
  if (latest.some((run) => FAILED_CONCLUSIONS.has(run.conclusion))) return 'failure';
  if (latest.some((run) => run.status !== 'completed')) return 'pending';
  if (latest.some((run) => PASSED_CONCLUSIONS.has(run.conclusion))) return 'success';
  return 'none';
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

const DASHBOARD_SECTIONS = {
  Errored: 'errored',
  'PR Edited (Blocked)': 'blocked',
  'Rate-Limited': 'rateLimited',
  'Awaiting Schedule': 'awaitingSchedule',
  'Pending Approval': 'pendingApproval',
  'Pending Status Checks': 'pendingChecks',
};
const BULK_ACTION = /<!-- (create-all-|rebase-all-|approve-all-|unlimit-all-|retry-all-)/;
const ALERT_START = /^>\s*\[!(WARNING|CAUTION)\]/;

function parseRenovateDashboard(body) {
  const result = { problems: [], warnings: [], counts: {} };
  let section = null;
  let alert = null;

  for (const line of String(body || '').split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      section = heading[1];
      alert = null;
      continue;
    }

    if (ALERT_START.test(line)) {
      alert = [];
      result.warnings.push(alert);
      continue;
    }
    if (alert && line.startsWith('>')) {
      const text = line.replace(/^>\s?/, '').trim();
      if (text) alert.push(text);
      continue;
    }
    alert = null;

    const item = line.match(/^\s*-\s+(.*)$/);
    if (!item) continue;
    if (section === 'Repository Problems') {
      result.problems.push(item[1].replace(/^⚠️\s*/, '').trim());
    } else if (DASHBOARD_SECTIONS[section] && !BULK_ACTION.test(item[1])) {
      const key = DASHBOARD_SECTIONS[section];
      result.counts[key] = (result.counts[key] || 0) + 1;
    }
  }

  result.warnings = result.warnings.map((lines) => lines.join(' ')).filter(Boolean);
  return result;
}

function renovateHealth(repo) {
  const issues = nodes(repo.renovateIssues);
  const dashboard = issues.find((issue) => /renovate dashboard|dependency dashboard/i.test(issue.title));
  const configIssue = issues.find((issue) => /action required/i.test(issue.title));
  if (!dashboard && !configIssue) return null;

  const parsed = parseRenovateDashboard(dashboard?.body);
  const severity =
    configIssue || parsed.problems.length || parsed.warnings.length || parsed.counts.errored
      ? 'error'
      : parsed.counts.blocked
        ? 'warn'
        : 'ok';

  return {
    severity,
    dashboardUrl: dashboard?.url || null,
    configError: configIssue ? { title: configIssue.title, url: configIssue.url } : null,
    problems: parsed.problems,
    warnings: parsed.warnings,
    counts: parsed.counts,
  };
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
      ci: ciState(pr) !== 'none' ? ciState(pr) : runsCiState(repo.actionRuns?.recent || [], pr.headRefOid),
    }));

    const health = renovateHealth(repo);

    if (!repo.hasRenovateConfig && !lastMerged && open.length === 0 && !health) {
      untracked.push(repoMeta(repo));
      continue;
    }

    if (!repo.hasRenovateConfig && !lastMerged && openRenovate.length > 0 && openRenovate.every(isOnboarding)) {
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
      health,
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
  runsCiState,
  parseRenovateDashboard,
  renovateHealth,
  buildContributions,
  buildSnapshot,
  ciState,
  ownerOrder,
  summarizeContribution,
  summarizeRenovate,
  summarizeWorkflows,
  workflowHistory,
};
