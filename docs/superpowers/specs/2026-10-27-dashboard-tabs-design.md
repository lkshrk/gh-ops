# Maintainer dashboard: tabs + Subscriptions feed

2026-10-27

## Intent

The dashboard is one long scroll of three panels: Contributions, Failing workflows, Renovate.
Split it into four tabs and add a **Subscriptions** tab listing the upstream issues/PRs the user
explicitly subscribed to, so following other people's work does not mean living in the GitHub
notification inbox.

## What the data actually looks like (measured 2026-10-27)

`GET /notifications?all=true` returns **1536** threads. Breakdown:

| reason | count | what it is |
|---|---|---|
| `ci_activity` (CheckSuite) | 1172 | Actions run noise |
| `author` | 203 | own PRs/issues — already on Contributions |
| `state_change` | 123 | own repos, user closed/merged them |
| `mention` | 31 | |
| **`manual`** | **6** | **the Subscribe button: "You subscribed to the thread"** |
| `comment` | 1 | |

`participating=true` drops all CI noise: **364 threads, 8 pages**. The six `manual` threads are all
in other repos, all unread: `moonlight-stream/moonlight-qt`, `kubernetes-sigs/external-dns`,
`kubernetes-sigs/descheduler`, `siderolabs/sbc-raspberrypi` (PR), `zed-industries/zed`
(**Discussion**), `manaflow-ai/cmux`.

The notification payload has no open/closed/merged state — that needs a separate lookup.

## What the spike showed (2026-10-27)

Run against the real inbox, then restored (`PUT .../subscription` → `subscribed: true`, reason `manual`):

| action | thread in `?all=true` | reason | unread | in `?all=false` |
|---|---|---|---|---|
| `DELETE /notifications/threads/{id}/subscription` | **yes, unchanged** | `manual` (stale) | true | yes |
| `DELETE /notifications/threads/{id}` (done) | **yes, unchanged** | unchanged | **false** | no |

Three consequences:

1. **Unsubscribing does not remove the thread from the API feed**, and `reason: manual` survives it, so
   the reason is a *historical* label, not current subscription state. A row would come back on the
   next refresh forever.
2. **"Done" doesn't remove it from `all=true` either** — the only API-visible change is `unread: false`.
   So neither write action can hide a row on its own.
3. Current subscription is still knowable per thread: `GET /notifications/threads/{id}/subscription`
   returns `subscribed: true/false`, and **404 once unsubscribed** (observed). That is the only
   authoritative source.

The sampled inbox's oldest notification activity was 2026-08-28. This does not establish a
subscription creation-age limit: an older subscription with recent activity can appear. Discovery
is limited to threads returned by the notifications API, not an exhaustive subscription inventory.

## Approaches considered

- **A. `manual` only — 6 rows. chosen.** Literal answer to "where did I press Subscribe".
  Small, quiet, and the set is stable.
- **B. `manual` + `mention` + `comment` in other repos — 23 rows, two groups.** More useful as a
  reading list, but it widens "subscribed" into "involved".
- **C. everything human in other repos.** Same rows as B today, drifts into a second inbox and
  overlaps Contributions.

## Decisions

1. **Feed = notification reason `manual`, repos the dashboard does not own, still subscribed.** The
   reason filter isolates hand-subscribed threads from repo-watching noise; "still subscribed" comes
   from the per-thread subscription check (decision 3), because the feed itself keeps returning
   unsubscribed and done threads. The reasons live in one constant (`SUBSCRIPTION_REASONS`), so B is a
   one-word change if A feels too thin. Documented cost of A: a thread later @mentioning you is
   relabelled `mention` by GitHub and leaves the list, so it does **not** reappear after activity — the
   README says so.
2. **One write action: Unsubscribe.** `DELETE /notifications/threads/{id}/subscription` — the real
   unsubscribe, and the only GitHub mutation the dashboard performs. It does not flip `unread` and
   does not touch the inbox (no "done" call). The row disappears on the next refresh because the
   subscription check reports it gone — GitHub is the source of truth, so no suppression list, no extra
   state file, and unsubscribing on github.com is reflected too. Same `notifications` scope, no new
   token permission. GitHub documents that comments or @mentions may trigger future notifications,
   and repository watching can still notify; DELETE is not a permanent ignore/mute operation.
3. **Subscription truth per item.** For each candidate, `GET /notifications/threads/{id}/subscription`
   (404 = gone). One request per item, conditional only when GitHub supplies a validator, capped at `SUBSCRIPTION_LIMIT = 30`
   items per refresh so the shared REST budget (5000/h, also used by Actions runs) cannot drift; beyond
   the cap, oldest-by-update items are dropped from the tab and the panel says so.
4. **State drives the tab, not just decorates it.** Bounded GraphQL batches through the existing
   viewer client give `state` and `closedAt` for every visible subject (Discussion uses `closed`
   and `closedAt`, mapped to OPEN/CLOSED; pull
   requests: OPEN/CLOSED/MERGED). A thread closed **more than 7 days** ago is hidden
   (`CLOSED_GRACE_DAYS = 7`, strictly older than the snapshot time; a merge counts as closed). The
   last week of closed threads stays visible so a wrap-up is still noticeable.
5. **Unknown state or unknown subscription keeps the thread.** If either lookup fails, nothing is
   hidden — the panel shows an inline note rather than silently dropping rows it cannot classify.
6. **Discussions are rendered** (one of the six is a Discussion), linking to
   `github.com/<repo>/discussions/<n>`, with `closed` mapped to CLOSED/OPEN.
7. **Tab state lives in the URL hash and `localStorage`** (`#subscriptions`), hash first. This also
   means the OIDC self-heal reload from the session fix returns to the tab you were on.
8. **All four panels render on every poll** and are toggled with `hidden`, so `<details>` open state
   survives tab switches and switching tabs never re-renders.
9. **KPI strip grows to 4 cards** (Contributions, Subscriptions, Failing workflows, Renovate) to
   mirror the tabs. 4 → 2 → 1 columns responsive.
10. **Owner chips stay one element**, moved under the tab bar, shown only for the two tabs they
    filter (Failing workflows, Renovate).
11. **`NOTIFICATIONS_TOKEN`** (recommended: classic PAT, `notifications` scope) is optional and separate from
     `GITHUB_TOKENS`: this client handles notification reads and subscription changes; the existing
     viewer client enriches subjects because a notifications-only credential need not access GraphQL. Absent or
    failing, the tab renders "notifications token not configured" / the error and offers no
    Unsubscribe button, and the rest of the snapshot is unaffected.

## Constraints

- The notifications endpoint documentation recommends classic PATs with `notifications` or `repo`
  scope and excludes fine-grained tokens. OAuth's documented `notifications` scope also grants
  notification and thread-subscription access, consistent with the CLI probe; do not reject a token
  by its prefix or claim classic PATs are the only possible credentials.
- Poll cost is bounded by 10 notification pages, 30 candidate subscription checks, and GraphQL
  batches of six subjects through the viewer client. Notifications use `Last-Modified` /
  `If-Modified-Since`, cache body and pagination links on 304, and respect `X-Poll-Interval`.
  ETags are used only when actually returned; their availability is not guaranteed. The dashboard's
  refresh cycle does not override GitHub's polling interval.
- No auth in the app. Same-origin POST only, as today. Unsubscribe inherits the existing guard, but it
  is a real mutation of the user's GitHub account, so the button appears only when the token exists.
- Notification activity age is not subscription age. Historical discovery remains incomplete.

## Parts (what gets touched)

- `github.js` — `fetchSubscriptions({ excludeOwners, stateClient })`: page `?all=true&per_page=100`
  (cap 10 pages), keep `reason === 'manual'`, drop own-owner repos, dedupe by subject URL, cap at
  `SUBSCRIPTION_LIMIT`; internal subscription checks (`GET .../subscription`, 404 = gone, returns
  `subscribed: true/false`, unknown on lookup failure); viewer-client batched state lookup
  (`issue`/`pullRequest`/`discussion` by number); follow validated Link pagination even on short pages.
  `unsubscribe(threadId)` (`DELETE .../subscription`, accepts empty 204 and throws on failure).
- `dashboard.js` — `summarizeSubscriptions(threads, { now })` → `{ items, unread, hidden }`;
  pure, so filtering (own repos, unsubscribed, closed > 7 d) is testable without network.
- `server.js` — new `subscriptions` phase, its own client from `NOTIFICATIONS_TOKEN`, error captured
  as `subscriptions.error` instead of failing the refresh; `POST /subscriptions/unsubscribe`
  `{ url }` → lookup thread id in the snapshot → `DELETE` → rebuild snapshot and return it, same shape
  as `POST /contributions/done`.
- `index.html` / `app.js` / `style.css` — tab bar, panel toggling, Subscriptions panel with one
  Unsubscribe button per row, 4th KPI card.
- `app.test.js`, `dashboard.test.js` — filter/exclusion/dedupe/closed-grace/state mapping; tab
  selection, hash persistence, counts, unsubscribe button wiring.
- `README.md` — new tab, `NOTIFICATIONS_TOKEN`, `manual` semantics, what Unsubscribe does and does
  not do (it stops notifications; it does not clear the GitHub inbox).
- h-cloud `kubernetes/apps/tools/pr-dashboard/app/helmrelease.yaml` — `NOTIFICATIONS_TOKEN` as
  `secretKeyRef` with `optional: true` so the pod still starts before the key exists.

## Rollout

1. Push gh-ops → image digest bump → deploy. Until a token exists the tab says "notifications token
   not configured" and has no Unsubscribe buttons.
2. Mint a classic PAT with only `notifications`, add it to `pr-dashboard-secret`; Reloader restarts
   the pod; the tab fills with the six threads.

## Verification

- `bun test pr-dashboard/` — existing 39 plus new tests.
- `just flux validate` in h-cloud.
- After deploy: `/data.json` carries `subscriptions.items`; the tab shows the six hand-subscribed
  threads; pressing Unsubscribe on one removes the row within one refresh (≤ 60 s) without a page
  reload, and `GET /notifications/threads/{id}/subscription` afterwards returns 404.
