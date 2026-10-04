const OWNER_HUES = 8;
const POLL_MS = 20 * 1000;
const STALE_DAYS = 30;
const AGING_DAYS = 7;
const LAG_DAYS = 3;
const DAY_MS = 86400000;

const REASON_LABELS = {
  'ci-failing': 'CI failing',
  'changes-requested': 'Changes requested',
  'awaiting-reply': 'Awaiting your reply',
};

let data = null;
const hiddenOwners = new Set(loadHiddenOwners());

function loadHiddenOwners() {
  try {
    return JSON.parse(localStorage.getItem('hiddenOwners') || '[]');
  } catch {
    return [];
  }
}

function saveHiddenOwners() {
  try {
    localStorage.setItem('hiddenOwners', JSON.stringify([...hiddenOwners]));
  } catch {}
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function ageDays(iso) {
  return (Date.now() - Date.parse(iso)) / DAY_MS;
}

function ago(iso) {
  if (!iso) return '—';
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  const days = seconds / 86400;
  if (days < 14) return `${Math.floor(days)}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

function when(iso) {
  return `<time datetime="${esc(iso)}" title="${esc(iso && new Date(iso).toLocaleString())}">${ago(iso)}</time>`;
}

function ownerClass(owner) {
  const index = data.owners.indexOf(owner);
  return `o${(index < 0 ? 0 : index) % OWNER_HUES}`;
}

const lockIcon =
  '<svg class="lock" viewBox="0 0 16 16" aria-label="private"><path d="M4 7V5a4 4 0 1 1 8 0v2h.5A1.5 1.5 0 0 1 14 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 13.5v-5A1.5 1.5 0 0 1 3.5 7Zm1.5 0h5V5a2.5 2.5 0 0 0-5 0Z"/></svg>';

function ownRepo(meta, className = 'repo') {
  return `<a class="${className}" href="${esc(meta.url)}" title="${esc(meta.repo)}"><span class="owner-dot ${ownerClass(meta.owner)}"></span><span class="name">${esc(meta.name)}</span>${meta.private ? lockIcon : ''}</a>`;
}

function ciDot(ci) {
  const labels = { success: 'CI passing', failure: 'CI failing', pending: 'CI running', none: 'No CI' };
  return `<span class="dot ci-${ci}" title="${labels[ci]}" aria-label="${labels[ci]}"></span>`;
}

function chip(text, tone, title = '') {
  return `<span class="chip ${tone}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
}

function emptyState(text) {
  return `<p class="empty">${esc(text)}</p>`;
}

function contributionRow(pr) {
  const chips = [
    pr.isDraft ? chip('Draft', 'muted') : '',
    ...pr.reasons.map((reason) => chip(REASON_LABELS[reason] || reason, 'alert')),
    pr.state === 'OPEN' ? chip('Open', 'good') : '',
    pr.state === 'MERGED' ? chip('Merged', 'merged') : '',
    pr.state === 'CLOSED' ? chip('Closed', 'muted') : '',
  ].join('');
  const stamp = pr.state === 'OPEN' ? pr.updatedAt : pr.closedAt;
  const avatar = pr.avatarUrl ? `<img class="avatar" src="${esc(pr.avatarUrl)}" alt="" loading="lazy">` : '';

  return `<li class="row">
    ${pr.state === 'OPEN' ? ciDot(pr.ci) : '<span class="dot ci-none"></span>'}
    <div class="row-main">
      <a class="title" href="${esc(pr.url)}">${esc(pr.title)}</a>
      <div class="meta">${avatar}<span class="upstream">${esc(pr.repo)}</span><span class="num">#${pr.number}</span>${chips}</div>
    </div>
    <span class="age">${when(stamp)}</span>
  </li>`;
}

function group(title, items, renderItem, emptyText, tone = '') {
  return `<div class="group ${tone}">
    <h3>${esc(title)} <span class="count">${items.length}</span></h3>
    ${items.length ? `<ul class="rows">${items.map(renderItem).join('')}</ul>` : emptyState(emptyText)}
  </div>`;
}

function renderContributions() {
  const { attention, open, closed } = data.contributions;
  return [
    group('Needs you', attention, contributionRow, 'Nothing waiting on you.', 'attention'),
    group('Open, waiting on others', open, contributionRow, 'No open contributions.'),
    group('Recently closed', closed, contributionRow, 'Nothing closed recently.'),
  ].join('');
}

function runStrip(runs) {
  return `<span class="strip" aria-label="Recent runs, oldest to newest">${[...runs]
    .reverse()
    .map((run) => `<a class="run ${run.result}" href="${esc(run.url)}" title="${esc(run.result)} · ${esc(new Date(run.createdAt).toLocaleString())}"></a>`)
    .join('')}</span>`;
}

function workflowRow(entry) {
  const run = entry.latestRun;
  const streak = `${entry.streakCapped ? '≥' : ''}${entry.streak}× failed`;
  return `<li class="row wf">
    <div class="wf-target">
      ${ownRepo(entry, 'repo repo-title')}
      <a class="wf-name" href="${esc(run.url)}">${esc(entry.workflow)}</a>
    </div>
    <span class="wf-col author" title="Author of the commit the latest run built">${esc(run.author || '—')}</span>
    <span class="wf-col event">${esc(run.event || '—')}</span>
    <span class="wf-col branch">${esc(entry.branch)}</span>
    ${runStrip(entry.runs)}
    <div class="wf-stats">
      <span class="streak">${esc(streak)}</span>
      <span class="since">since ${when(entry.failingSince)}</span>
    </div>
  </li>`;
}

function visible(entries) {
  return entries.filter((entry) => !hiddenOwners.has(entry.owner));
}

function renderWorkflows() {
  const failing = visible(data.workflows.failing);
  const recent = visible(data.workflows.recent);
  const recentBlock = recent.length
    ? `<details class="more"><summary>Recently failed, not yet ${data.workflows.failStreak}× in a row <span class="count">${recent.length}</span></summary>
        <ul class="rows">${recent.map(workflowRow).join('')}</ul></details>`
    : '';

  return `${group(`Failing ${data.workflows.failStreak}× or more in a row`, failing, workflowRow, 'Every default-branch workflow passed on its latest runs.', failing.length ? 'attention' : 'calm')}${recentBlock}`;
}

function isLagging(entry) {
  return entry.open.some((pr) => ageDays(pr.createdAt) > LAG_DAYS);
}

function freshness(iso) {
  if (!iso) return 'stale';
  const days = ageDays(iso);
  if (days >= STALE_DAYS) return 'stale';
  if (days >= AGING_DAYS) return 'aging';
  return 'fresh';
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function healthChips(health) {
  if (!health) return '';
  const { counts } = health;
  const findings = [...health.problems, ...health.warnings];
  return [
    health.configError ? chip('Config error', 'alert', health.configError.title) : '',
    findings.length ? chip(plural(findings.length, 'problem'), 'alert', findings.join('\n')) : '',
    counts.errored ? chip(`${counts.errored} errored`, 'alert') : '',
    counts.blocked ? chip(`${counts.blocked} blocked`, 'warn', 'Edited Renovate branches halt their update group') : '',
    counts.rateLimited ? chip(`${counts.rateLimited} rate-limited`, 'muted') : '',
    counts.awaitingSchedule ? chip(`${counts.awaitingSchedule} scheduled`, 'muted') : '',
    counts.pendingApproval ? chip(`${counts.pendingApproval} awaiting approval`, 'muted') : '',
  ].join('');
}

function healthRows(health) {
  if (!health || health.severity === 'ok') return '';
  const row = (tone, html) => `<li class="sub-row health ${tone}"><span class="dot ci-${tone}"></span><span class="title">${html}</span></li>`;
  return [
    health.configError
      ? row('failure', `<a href="${esc(health.configError.url)}">${esc(health.configError.title)}</a>`)
      : '',
    ...[...health.problems, ...health.warnings].map((text) => row('failure', esc(text))),
    health.counts.errored ? row('failure', `${plural(health.counts.errored, 'branch')} errored`) : '',
    health.counts.blocked
      ? row('pending', `${plural(health.counts.blocked, 'branch')} edited by a human — Renovate stops updating that group until it is reset`)
      : '',
    health.dashboardUrl ? row('none', `<a href="${esc(health.dashboardUrl)}">Open Renovate Dashboard</a>`) : '',
  ].join('');
}

function renovateRow(entry) {
  const tone = freshness(entry.lastMerged?.mergedAt);
  const last = entry.lastMerged
    ? `<span class="last">last <a href="${esc(entry.lastMerged.url)}">${esc(entry.lastMerged.title)}</a></span>`
    : '<span class="last none">no merged update in the last 50 pull requests</span>';
  const count = (ci) => entry.open.filter((pr) => pr.ci === ci).length;
  const green = count('success');
  const red = count('failure');
  const other = entry.open.length - green - red;
  const countTitle = `${green} passing, ${red} failing${other ? `, ${other} running or without CI` : ''}`;
  const counts = entry.open.length
    ? `<span class="${green ? 'n-good' : 'n-zero'}">${green}</span><span class="n-sep">/</span><span class="${red ? 'n-bad' : 'n-zero'}">${red}</span>${other ? `<span class="n-sep">/</span><span class="n-other">${other}</span>` : ''}`
    : '<span class="n-zero">0</span>';
  const head = `
    <span class="age-badge ${tone}">${entry.lastMerged ? ago(entry.lastMerged.mergedAt) : 'never'}</span>
    <div class="row-main">
      ${ownRepo(entry, 'repo repo-title')}
      <div class="meta">${last}${healthChips(entry.health)}${entry.hasConfig ? '' : chip('No config on default branch', 'muted')}</div>
    </div>
    <span class="open-count${entry.open.length ? '' : ' empty'}" title="${esc(entry.open.length ? countTitle : 'No open pull requests')}">${counts}</span>`;

  const health = healthRows(entry.health);
  if (entry.open.length === 0 && !health) {
    return `<li class="row reno">${head}<span class="chevron-space"></span></li>`;
  }

  const prs = entry.open
    .map((pr) => `<li class="sub-row">
      ${ciDot(pr.ci)}
      <a class="title" href="${esc(pr.url)}">${esc(pr.title)}</a>
      <span class="num">#${pr.number}</span>
      <span class="age">${when(pr.createdAt)}</span>
    </li>`)
    .join('');

  return `<li class="reno-item"><details>
    <summary class="row reno">${head}<span class="chevron" aria-hidden="true"></span></summary>
    <ul class="sub-rows">${health}${prs}</ul>
  </details></li>`;
}

function renderRenovate() {
  const repos = visible(data.renovate.repos);
  const untracked = visible(data.renovate.untracked);
  const onboarding = visible(data.renovate.onboarding);
  const onboardingBlock = onboarding.length
    ? `<details class="more"><summary>Onboarding PR not merged <span class="count">${onboarding.length}</span></summary>
        <ul class="rows">${onboarding
          .map((entry) => `<li class="row"><div class="row-main"><a class="title" href="${esc(entry.pullRequest.url)}">${esc(entry.pullRequest.title)}</a>
            <div class="meta">${ownRepo(entry)}</div></div><span class="age">${when(entry.pullRequest.createdAt)}</span></li>`)
          .join('')}</ul></details>`
    : '';
  const untrackedBlock = untracked.length
    ? `<details class="more"><summary>No Renovate activity <span class="count">${untracked.length}</span></summary>
        <div class="repo-cloud">${untracked.map(ownRepo).join('')}</div></details>`
    : '';

  return `${group('Repositories', repos, renovateRow, 'No repositories with Renovate.')}${onboardingBlock}${untrackedBlock}`;
}

function renderKpis() {
  const { attention, open } = data.contributions;
  const red = attention.filter((pr) => pr.ci === 'failure').length;
  const review = attention.filter((pr) => pr.reasons.some((reason) => reason !== 'ci-failing')).length;
  const failing = visible(data.workflows.failing).length;
  const recent = visible(data.workflows.recent).length;

  const repos = visible(data.renovate.repos);
  const sum = (pick) => repos.reduce((total, entry) => total + pick(entry), 0);
  const automerged = sum((entry) => entry.recentlyMerged.automerged);
  const manual = sum((entry) => entry.recentlyMerged.manual);
  const pending = sum((entry) => entry.open.length);
  const autoRate = automerged + manual ? Math.round((automerged / (automerged + manual)) * 100) : null;
  const lagging = repos.filter(isLagging).length;
  const troubled = repos.filter((entry) => entry.health && entry.health.severity !== 'ok').length;

  return `
    <div class="kpi ${attention.length ? 'alert' : 'calm'}">
      <span class="kpi-label">Contributions</span>
      <span class="kpi-value"><span class="${attention.length ? 'bad' : 'good'}">${attention.length}</span><span class="of">/</span><span class="total">${attention.length + open.length}</span></span>
      <span class="kpi-sub">need you / open · ${red} red CI · ${review} to answer</span>
    </div>
    <div class="kpi ${failing ? 'alert' : 'calm'}">
      <span class="kpi-label">Failing workflows</span>
      <span class="kpi-value"><span class="${failing ? 'bad' : 'good'}">${failing}</span></span>
      <span class="kpi-sub">${data.workflows.failStreak}× in a row · ${recent} more failed recently</span>
    </div>
    <div class="kpi ${lagging || troubled ? 'warn' : 'calm'}">
      <span class="kpi-label">Renovate</span>
      <span class="kpi-value"><span class="good">${repos.length - lagging}</span><span class="of">/</span><span class="${lagging ? 'lag' : ''}">${lagging}</span><span class="of">(${pending} open)</span></span>
      <span class="kpi-sub">up to date / PRs open &gt; ${LAG_DAYS}d${troubled ? ` · <span class="sub-alert">${plural(troubled, 'repo')} with Renovate issues</span>` : ''}${autoRate === null ? '' : ` · ${autoRate}% automerged last ${data.renovate.stats.windowDays}d`}</span>
    </div>`;
}

function renderOwners() {
  const chips = data.owners
    .map((owner) => {
      const active = !hiddenOwners.has(owner);
      return `<button type="button" class="owner-filter ${ownerClass(owner)}" data-owner="${esc(owner)}" aria-pressed="${active}">${esc(owner)}</button>`;
    })
    .join('');
  return `<span class="owners-label">Own repositories</span>${chips}`;
}

function render() {
  if (!data) return;
  document.getElementById('kpis').innerHTML = renderKpis();
  document.getElementById('owners').innerHTML = renderOwners();
  document.querySelector('#contributions .panel-body').innerHTML = renderContributions();
  document.querySelector('#workflows .panel-body').innerHTML = renderWorkflows();
  document.querySelector('#renovate .panel-body').innerHTML = renderRenovate();
  document.getElementById('freshness').textContent = `${data.repoCount} repos · updated ${ago(data.generatedAt)} ago`;

  const banner = document.getElementById('banner');
  const problems = [
    data.error ? `Last refresh failed ${ago(data.error.at)} ago: ${data.error.message}. Showing older data.` : null,
    ...(data.ownerErrors || []).map(
      (failure) =>
        `${failure.owner}: ${failure.message} (failing for ${ago(failure.since)}; ${failure.dataFrom ? `showing data from ${ago(failure.dataFrom)} ago` : 'no data yet'}).`,
    ),
  ].filter(Boolean);
  banner.hidden = problems.length === 0;
  banner.textContent = problems.join(' ');
}

async function poll() {
  try {
    const response = await fetch('data.json', { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || response.statusText);
    data = body;
    render();
  } catch (error) {
    const banner = document.getElementById('banner');
    banner.hidden = false;
    banner.textContent = `Could not load data: ${error.message}`;
    if (!data) document.getElementById('freshness').textContent = 'waiting for first refresh…';
  }
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('.owner-filter');
  if (!button) return;
  const { owner } = button.dataset;
  if (hiddenOwners.has(owner)) hiddenOwners.delete(owner);
  else hiddenOwners.add(owner);
  saveHiddenOwners();
  render();
});

poll();
setInterval(poll, POLL_MS);
