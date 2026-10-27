# Dashboard Tabs and Subscriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four persistent dashboard tabs, a manual-subscription feed, seven-day closed-item filtering, and Unsubscribe.

**Architecture:** Keep Bun and the dependency-free browser client. Fetch notifications separately from owner data, verify each candidate's subscription and subject state, and include a subscriptions section in the existing snapshot. Resolve unsubscribe targets from server-held rows rather than accepting arbitrary GitHub API URLs.

**Tech Stack:** Bun, JavaScript, GitHub REST/GraphQL, HTML/CSS, Flux YAML.

**Spec:** `docs/superpowers/specs/2026-10-27-dashboard-tabs-design.md`

## Global Constraints

- Preserve the existing uncommitted session-expiry fix in gh-ops and h-cloud.
- Four tabs in order: Contributions, Subscriptions, Failing workflows, Renovate.
- Only `manual` notifications in other owners' repositories; include issues, PRs and discussions.
- `SUBSCRIPTION_LIMIT = 30`; at most 10 notification pages per refresh, with explicit truncation messaging.
- Hide CLOSED/MERGED items only when their closure is strictly more than seven days old. Keep unknown state with a warning.
- Optional `NOTIFICATIONS_TOKEN`; failures must not prevent the other dashboard sections updating.
- Unsubscribe changes the subscription only, never notification read/done state. No live mutation tests without separate authorization.
- Changes to cluster configuration go through Git; do not mutate secrets or deploy directly.

## Review Focus

- Notification pages may be smaller than requested: follow Link pagination, not array length.
- A subscription or subject lookup may fail independently: distinguish 404 subscription absence from transient failures and keep unknown rows.
- A successful unsubscribe may race an in-flight refresh: a stale result must not restore the removed row.
- Closed items can be reopened, have missing closure dates, or sit exactly on the cutoff: hide only proven old closures.
- Browser storage can throw, hashes can be invalid, and authentication can reload the tab: preserve usable navigation and avoid mutation retries.

---

### Task 1: Fetch and normalize subscriptions

**Files:** Modify `pr-dashboard/github.js`, `pr-dashboard/dashboard.js`; create `pr-dashboard/subscriptions.test.js`.

**Interfaces:**
- Client `fetchSubscriptions({ excludeOwners, stateClient })` returns `{ threads, warnings, truncated }`.
- Normalized threads carry `id`, `url`, `repo`, `owner`, `number`, `title`, `type`, `unread`, `updatedAt`, `subscribed` (boolean/null), `state`, `closedAt`, `mergedAt`.
- Export `summarizeSubscriptions(threads, { now = new Date() } = {})` returning `{ items, unread, hidden }`.
- Client `unsubscribe(threadId)` resolves after successful DELETE and invalidates that subscription's cached response.

- [ ] Check current GitHub documentation through Context7 and official references for pagination, conditional notification requests, Discussion closure fields, and required token permissions. Use the existing viewer client for subject lookups if a notifications-only token cannot read those fields. Correct unsupported design assumptions before implementation; do not treat notification activity age as subscription creation age.
- [ ] Add mocked-fetch tests: two short pages linked by Link are both consumed; only manual, non-owned supported subjects survive; duplicate subjects collapse; caps set `truncated`; subscription 404 removes while 403/5xx keeps unknown with a warning. Assert no requests follow unvalidated external subject URLs.
- [ ] Add pure summary tests at a fixed `now`: closure at exactly seven days stays; seven days plus one millisecond disappears; merged PR uses closure/merge date; reopened OPEN and unknown-date items stay; unread count includes only visible rows.
- [ ] Run `bun test pr-dashboard/subscriptions.test.js` and confirm failures identify missing behavior.
- [ ] Implement bounded discovery, subscription checks, batched subject enrichment and the pure summary using the existing client error/cache patterns. Use documented conditional headers and obey `X-Poll-Interval`; do not promise unsupported ETag behavior. Validate numeric thread IDs for unsubscribe, accept 204 without JSON parsing, and propagate failed DELETE.
- [ ] Run `bun test pr-dashboard/subscriptions.test.js`; require all tests passing.
- [ ] Review the scoped diff and commit only this task's files if committing is authorized.

### Task 2: Snapshot integration and unsubscribe route

**Files:** Modify `pr-dashboard/server.js`, `pr-dashboard/dashboard.js`; create `pr-dashboard/subscriptions-server.test.js`.

**Interfaces:** Snapshot `subscriptions` has `{ items, unread, hidden, warnings, truncated, error, canUnsubscribe }`; defaults to an empty unavailable section when no token exists. `POST /subscriptions/unsubscribe` accepts `{ url }` and returns the updated full snapshot.

- [ ] Add tests proving absent/failing notifications credentials do not block owner/contribution refreshes; failed unsubscribe retains the row; successful unsubscribe removes it immediately; unknown URLs, non-JSON and cross-site calls cannot trigger GitHub mutation.
- [ ] Add a deferred-refresh test: start fetch, unsubscribe successfully, resolve stale fetch, and assert the row remains absent. Use a refresh generation/version guard, not a permanent suppression store.
- [ ] Run `bun test pr-dashboard/subscriptions-server.test.js` and confirm the expected failures.
- [ ] Integrate the optional client and isolated subscriptions error state. Resolve URL to an eligible current snapshot row, apply existing request guards, invalidate cached subscription state after DELETE, remove the row and rebuild. Expose only the minimum test seam needed; avoid starting a real authenticated server in tests.
- [ ] Run `bun test pr-dashboard/`; require all existing and new tests passing.
- [ ] Review the scoped diff and commit only this task's files if committing is authorized.

### Task 3: Four tabs and subscription controls

**Files:** Modify `pr-dashboard/public/index.html`, `pr-dashboard/public/app.js`, `pr-dashboard/public/style.css`, `pr-dashboard/app.test.js`.

**Interfaces:** Tab IDs/hash values `contributions`, `subscriptions`, `workflows`, `renovate`. Active hash overrides stored selection; invalid input falls back to Contributions. Consume Task 2's snapshot without changing existing Done controls.

- [ ] Add tests for hash/storage precedence, invalid hash, throwing storage, back/forward navigation, owner-filter visibility, selected-panel counts, subscription row escaping and unavailable/error states.
- [ ] Test Unsubscribe sends one same-origin JSON POST, disables during the request, preserves the row and shows an error on failure, and renders the returned snapshot on success. Preserve `redirect: 'manual'` authentication recovery without replaying mutations.
- [ ] Run `bun test pr-dashboard/app.test.js` and confirm expected failures.
- [ ] Implement keyboard-accessible tabs and four panels, count badges, the fourth KPI, 4/2/1 responsive KPI columns and one shared owner-filter bar visible only on workflows/renovate. Ensure author CSS cannot override hidden panels. Tab switching only toggles visibility; it must not re-render or close expanded details. Preserve tab selection on polls and reloads.
- [ ] Render subscription type/state/unread/age metadata and Unsubscribe controls; show configured errors, lookup warnings and truncation explicitly. Reuse current styles and escaping.
- [ ] Run `bun test pr-dashboard/`; inspect the UI with fixture snapshots at desktop/mobile widths using available browser tooling, including keyboard navigation and an expanded Renovate row across tab switches. Report any unavailable browser verification.
- [ ] Review the scoped diff and commit only this task's files if committing is authorized.

### Task 4: Configuration, documentation and final review

**Files:** Modify `pr-dashboard/README.md`; in h-cloud modify `kubernetes/apps/tools/pr-dashboard/app/helmrelease.yaml` and the dashboard documentation in `README.md` (add a concise entry if absent).

- [ ] Document all four tabs, manual-notification discovery limitations, actual token requirements, seven-day closure filtering, optional-token behavior, API route and Unsubscribe semantics. Avoid claiming every historical subscription is discoverable or exactly six rows will remain after filtering.
- [ ] Add `NOTIFICATIONS_TOKEN` from `pr-dashboard-secret` with `optional: true`. Do not extract or persist the CLI token; credential provisioning remains a separate user step.
- [ ] Run `bun test pr-dashboard/` and `git diff --check` in gh-ops. Run `just flux validate` and `git diff --check` in h-cloud, preserving actual command exit status and separating existing skips from new failures.
- [ ] Request one independent review focused on pagination, permissions, stale-refresh races, unsubscribe target validation, cutoff semantics and tab accessibility. Fix actionable findings and rerun only affected checks.
- [ ] Report changed files, verification evidence, credential/deployment prerequisites and actual commit/deployment status. No additional live notification mutations for verification.
