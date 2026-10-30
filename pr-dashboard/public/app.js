const OWNER_HUES = 8;
const POLL_MS = 20 * 1000;
const REAUTH_COOLDOWN_MS = 30 * 1000;
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
let mutationVersion = 0;
let mutationQueue = Promise.resolve();
const TABS = ['contributions', 'subscriptions', 'workflows', 'renovate'];
const pendingRemovals = new Set();

function initialTab() {
  if (location.hash) return location.hash.slice(1);
  try {
    return localStorage.getItem('dashboardTab');
  } catch {
    return null;
  }
}

function selectTab(value, navigate = false) {
  const selected = TABS.includes(value) ? value : 'contributions';
  if (document.activeElement?.closest('[role="tab"]')) document.getElementById(`tab-${selected}`).focus();
  for (const id of TABS) {
    const panel = document.getElementById(id);
    const tab = document.getElementById(`tab-${id}`);
    const active = id === selected;
    if (!active && panel.contains(document.activeElement)) document.getElementById(`tab-${selected}`).focus();
    panel.hidden = !active;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  try {
    localStorage.setItem('dashboardTab', selected);
  } catch {}
  if (navigate && location.hash !== `#${selected}`) history.pushState(null, '', `#${selected}`);
  return selected;
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

function doneControl(pr) {
  if (pr.done) {
    return `<button type="button" class="done-toggle undo" data-url="${esc(pr.url)}" data-done="false" title="Move back to Needs you">Undo</button>`;
  }
  if (pr.state !== 'OPEN' || !pr.reasons?.length) return '';
  return `<button type="button" class="done-toggle" data-url="${esc(pr.url)}" data-done="true" title="Move to Open until someone gives new feedback">Done</button>`;
}

function contributionRow(pr) {
  const chips = [
    pr.isDraft ? chip('Draft', 'muted') : '',
    pr.done ? chip('Handled', 'good', 'Marked done; returns to Needs you on new feedback') : '',
    ...pr.reasons.map((reason) => chip(REASON_LABELS[reason] || reason, pr.done ? 'muted' : 'alert')),
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
    ${doneControl(pr)}
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

function subscriptionRow(item) {
  const type = { Issue: 'Issue', PullRequest: 'Pull request', Discussion: 'Discussion' }[item.type] || item.type || 'Unknown type';
  const state = { OPEN: 'State: Open', CLOSED: 'State: Closed', MERGED: 'State: Merged' }[item.state] || 'Unknown state';
  const label = item.id && item.subscribed === true && data.subscriptions.canUnsubscribe ? 'Remove from watchlist and unsubscribe' : 'Remove from watchlist';
  return `<li class="row">
    <div class="row-main">
      <a class="title" href="${esc(item.url)}">${esc(item.title)}</a>
      <div class="meta"><span class="upstream">${esc(item.repo)}</span><span class="num">#${esc(item.number)}</span>
        ${chip(type, 'muted')}${chip(state, item.state === 'MERGED' ? 'merged' : item.state === 'OPEN' ? 'good' : 'muted')}
        ${item.authored ? chip('Opened by you', 'muted') : ''}${item.unread ? chip('Unread', 'warn') : ''}${item.subscribed == null ? chip('Unknown subscription', 'warn') : ''}
      </div>
    </div>
    <button type="button" class="remove" data-url="${esc(item.url)}" aria-label="${label}" title="${label}"${pendingRemovals.has(item.url) ? ' disabled' : ''}><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9h6.6L12 4M6.5 7v3.5M9.5 7v3.5"/></svg></button>
    <span class="age">${when(item.updatedAt)}</span>
  </li>`;
}

function renderSubscriptions() {
  const subscriptions = data.subscriptions;
  if (!subscriptions) return emptyState('Subscriptions unavailable.');
  const { items, error, warnings, truncated, canUnsubscribe } = subscriptions;
  return [
    !canUnsubscribe && !error ? emptyState('Subscriptions unavailable: notifications access is not configured.') : '',
    error ? `<p class="subscription-notice" role="status">${esc(error)}${items.length ? ' · Showing previously fetched subscriptions.' : ''}</p>` : '',
    ...(warnings || []).map((warning) => `<p class="subscription-notice">${esc(warning)}</p>`),
    truncated ? '<p class="subscription-notice">Results truncated: only part of your subscriptions could be fetched.</p>' : '',
    items.length ? `<ul class="rows">${items.map(subscriptionRow).join('')}</ul>` : canUnsubscribe && !error ? emptyState('No manual subscriptions to show.') : '',
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

function renderWorkflows() {
  const { failing, recent } = data.workflows;
  const recentBlock = recent.length
    ? `<details class="more" open><summary>Recently failed, not yet ${data.workflows.failStreak}× in a row <span class="count">${recent.length}</span></summary>
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
  const tone = freshness(entry.lastCommit?.committedDate);
  const commitTitle = entry.lastCommit ? `Last Renovate commit: ${entry.lastCommit.committedDate}` : 'Last Renovate commit unknown; history may be limited or unavailable';
  const last = entry.lastCommit
    ? `<span class="last">last Renovate commit <a href="${esc(entry.lastCommit.url)}" title="${esc(commitTitle)}">${esc(entry.lastCommit.title)}</a></span>`
    : '<span class="last none">no known Renovate commit in the last 100 default-branch commits</span>';
  const count = (ci) => entry.open.filter((pr) => pr.ci === ci).length;
  const green = count('success');
  const red = count('failure');
  const other = entry.open.length - green - red;
  const countTitle = `${green} passing, ${red} failing${other ? `, ${other} running or without CI` : ''}`;
  const counts = entry.open.length
    ? `<span class="${green ? 'n-good' : 'n-zero'}">${green}</span><span class="n-sep">/</span><span class="${red ? 'n-bad' : 'n-zero'}">${red}</span>${other ? `<span class="n-sep">/</span><span class="n-other">${other}</span>` : ''}`
    : '<span class="n-zero">0</span>';
  const head = `
    <span class="age-badge ${tone}" title="${esc(commitTitle)}">${entry.lastCommit ? ago(entry.lastCommit.committedDate) : 'unknown'}</span>
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
  const { repos, untracked, onboarding } = data.renovate;
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
  const failing = data.workflows.failing.length;
  const recent = data.workflows.recent.length;

  const repos = data.renovate.repos;
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
    <div class="kpi ${data.subscriptions?.error || !data.subscriptions?.canUnsubscribe ? 'warn' : 'calm'}">
      <span class="kpi-label">Subscriptions</span>
      <span class="kpi-value">${data.subscriptions?.items.length ?? 0}</span>
      <span class="kpi-sub">${data.subscriptions?.unread ?? 0} unread · ${data.subscriptions?.canUnsubscribe ? 'manual subscriptions' : 'unavailable'}</span>
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

function render() {
  if (!data) return;
  document.getElementById('kpis').innerHTML = renderKpis();
  document.querySelector('#contributions .panel-body').innerHTML = renderContributions();
  document.querySelector('#subscriptions .panel-body').innerHTML = renderSubscriptions();
  document.querySelector('#workflows .panel-body').innerHTML = renderWorkflows();
  document.querySelector('#renovate .panel-body').innerHTML = renderRenovate();
  const counts = {
    contributions: Object.values(data.contributions).reduce((total, items) => total + items.length, 0),
    subscriptions: data.subscriptions?.items.length ?? 0,
    workflows: data.workflows.failing.length + data.workflows.recent.length,
    renovate: data.renovate.repos.length + data.renovate.onboarding.length + data.renovate.untracked.length,
  };
  for (const id of TABS) document.getElementById(`count-${id}`).textContent = counts[id];
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

// Once the gateway's session cookies expire it answers with a redirect to its login flow. A fetch
// can never complete that flow, so an open tab would poll against a redirect forever until it is
// reloaded by hand. Only a top-level navigation renews the session; done while the tab is in the
// background it signs back in silently, and the dashboard is live again when it is next looked at.
function reauthenticate() {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem('reauthenticatedAt') || 0);
  } catch {}
  if (Date.now() - last < REAUTH_COOLDOWN_MS) return false;
  try {
    sessionStorage.setItem('reauthenticatedAt', String(Date.now()));
  } catch {}
  location.reload();
  return true;
}

async function load(request, mutation = false) {
  const version = mutationVersion;
  const response = await request;
  // A manual redirect is reported as an opaque redirect instead of failing the fetch, which is the
  // only signal that the request reached the gateway but was sent to the login flow.
  if (response.type === 'opaqueredirect') {
    if (!reauthenticate()) throw new Error('session expired, reload to sign in again');
    throw new Error('session expired, signing in again');
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || response.statusText);
  // A successful mutation invalidates polls already fetching or parsing older snapshots.
  if (mutation) mutationVersion++;
  else if (version !== mutationVersion) return;
  data = body;
  render();
}

function mutate(url, body) {
  // Serialize requests through rendering so an older mutation snapshot cannot restore rows.
  const pending = mutationQueue.then(() => load(fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
  }), true));
  mutationQueue = pending.catch(() => {});
  return pending;
}

async function setDone(button) {
  button.disabled = true;
  try {
    await mutate('contributions/done', { url: button.dataset.url, done: button.dataset.done === 'true' });
  } catch (error) {
    button.disabled = false;
    const banner = document.getElementById('banner');
    banner.hidden = false;
    banner.textContent = `Could not update the pull request: ${error.message}`;
  }
}

async function poll() {
  try {
    await load(fetch('data.json', { cache: 'no-store', redirect: 'manual' }));
  } catch (error) {
    const banner = document.getElementById('banner');
    banner.hidden = false;
    banner.textContent = `Could not load data: ${error.message}`;
    if (!data) document.getElementById('freshness').textContent = 'waiting for first refresh…';
  }
}

async function removeWatched(button) {
  const { url } = button.dataset;
  if (button.disabled || pendingRemovals.has(url)) return;
  pendingRemovals.add(url);
  button.disabled = true;
  try {
    await mutate('subscriptions/remove', { url });
  } catch (error) {
    button.disabled = false;
    const banner = document.getElementById('banner');
    banner.hidden = false;
    banner.textContent = `Could not remove: ${error.message}`;
  } finally {
    pendingRemovals.delete(url);
    for (const control of document.querySelectorAll('.remove')) {
      control.disabled = pendingRemovals.has(control.dataset.url);
    }
  }
}

function acknowledgeOpened(link) {
  const url = link.getAttribute('href');
  const request = fetch('subscriptions/acknowledge', {
    method: 'POST',
    keepalive: true,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const items = data?.subscriptions?.items;
  const item = items?.find((candidate) => candidate.url === url);
  if (item && (item.unread || item.state === 'CLOSED' || item.state === 'MERGED')) {
    const closed = item.state === 'CLOSED' || item.state === 'MERGED';
    const next = closed ? items.filter((candidate) => candidate !== item) : items.map((candidate) => (candidate === item ? { ...item, unread: false } : candidate));
    data = { ...data, subscriptions: { ...data.subscriptions, items: next, unread: next.filter((candidate) => candidate.unread).length } };
    render();
  }
  const settled = request.then((response) => (response.ok && response.type !== 'opaqueredirect' ? response : Promise.reject(new Error('not acknowledged'))));
  mutationQueue = mutationQueue.then(() => load(settled, true)).catch(() => {});
}

document.addEventListener('click', (event) => {
  const tab = event.target.closest('[role="tab"]');
  if (tab) {
    selectTab(tab.dataset.tab, true);
    return;
  }
  const title = event.target.closest('#subscriptions a.title');
  if (title) {
    acknowledgeOpened(title);
    return;
  }
  const removal = event.target.closest('.remove');
  if (removal) {
    removeWatched(removal);
    return;
  }
  const toggle = event.target.closest('.done-toggle');
  if (toggle) {
    setDone(toggle);
    return;
  }
});

document.addEventListener('auxclick', (event) => {
  const title = event.button === 1 ? event.target.closest('#subscriptions a.title') : null;
  if (title) acknowledgeOpened(title);
});

document.addEventListener('keydown', (event) => {
  const tab = event.target.closest('[role="tab"]');
  if (!tab) return;
  const index = TABS.indexOf(tab.dataset.tab);
  const next = { ArrowRight: (index + 1) % TABS.length, ArrowLeft: (index + TABS.length - 1) % TABS.length, Home: 0, End: TABS.length - 1 }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  selectTab(TABS[next], true);
  document.getElementById(`tab-${TABS[next]}`).focus();
});
addEventListener('hashchange', () => selectTab(location.hash.slice(1)));
const initialSelection = selectTab(initialTab());
if (!location.hash) history.replaceState(null, '', `#${initialSelection}`);
poll();
setInterval(poll, POLL_MS);
