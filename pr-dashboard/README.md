# pr-dashboard

Live, single-page dashboard over everything you maintain or contribute to on GitHub:

1. **Contributions**: your open pull requests to other people's projects, split into *Needs you*
   (failing CI, changes requested, or a human spoke after your last push/comment, including
   unresolved review threads), *Open, waiting on others*, and *Recently closed*. **Done** on a
   *Needs you* pull request moves it to *Open* until a human other than you comments, reviews or
   opens a review thread on it again; then it returns to *Needs you* and the flag is dropped.
2. **Subscriptions**: a durable watchlist of upstream issues and discussions you authored or are
   subscribed to, outside your configured owners. Shows unread, unknown-state and *Opened by you*
   badges, and a trash action that removes an item.
3. **Failing workflows**: default-branch GitHub Actions workflows across your own and your
   organizations' repositories whose latest `FAIL_STREAK` runs all failed, with a run strip and
   the date the streak started. Workflows with a shorter red streak sit in a collapsed list.
4. **Renovate**: repositories ranked by their last Renovate commit on the default branch, oldest first, with the
   open Renovate pull requests and their CI state. Pending onboarding PRs and repositories
   without Renovate are listed separately.

These are four tabs, linked by `#contributions`, `#subscriptions`, `#workflows` and `#renovate`.
The URL hash takes precedence over the last tab remembered in browser storage; unknown tabs
fall back to Contributions. Browser back/forward and keyboard tab navigation are supported.
The tab strip and active content share one bordered panel. Repositories are color-coded by
owner; Failing workflows and Renovate always include all configured owners.

## How it works

The server polls GitHub's GraphQL and REST APIs every `REFRESH_INTERVAL_MS` and keeps the latest snapshot
in memory. Visitors only ever read that snapshot from `/data.json`, so the API load is fixed no
matter how many browser tabs are open. Subscription discovery adds bounded REST calls and batched
GraphQL subject-state lookups; cost depends on the discovered threads and available cache entries.

Own repositories are those the token's user owns or reaches as an organization member
(not archived, not forks). Pull requests to those owners are excluded from *Contributions*.
Renovate pull requests are recognised by their head branch prefix, because a self-hosted
Renovate App does not show up as `app/renovate`.

There is no authentication in the app; anyone who reaches it can set *Done* flags and use the
configured account's remove action, which can unsubscribe GitHub notification threads. Protect access at the gateway. On h-cloud, Envoy
Gateway handles OIDC with Authentik.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `GITHUB_TOKENS` | — | Required. JSON object mapping each owner to a token, e.g. `{"my-user":"github_pat_…","my-org":"github_pat_…"}`. The owners listed here are the dashboard's own repositories. |
| `NOTIFICATIONS_TOKEN` | — | Optional classic PAT for the dashboard user's notifications and thread unsubscribes. Without it, Subscriptions shows an unavailable state; the other tabs continue working. |
| `RENOVATE_BOT_LOGIN` | `renovate[bot]` | Author login of Renovate's commits and issues (a self-hosted App is `<app-slug>[bot]`). |
| `PORT` | `3000` | HTTP listen port. |
| `REFRESH_INTERVAL_MS` | `60000` | How often to poll GitHub. |
| `FAIL_STREAK` | `3` | Consecutive failed runs that count as constantly failing. |
| `RENOVATE_BRANCH_PREFIX` | `renovate/` | Head branch prefix of Renovate pull requests. |
| `CLOSED_WINDOW_DAYS` | `30` | How far back Contributions' *Recently closed* reaches. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `STATE_FILE` | — | JSON file that keeps *Done* flags and the Subscriptions watchlist across restarts. Unset keeps them in memory only. |

### Tokens

One fine-grained PAT per owner (a fine-grained token has exactly one resource owner), each with
read-only **Metadata**, **Contents**, **Pull requests** and **Actions** on all repositories. Each
organization must allow fine-grained tokens, and an organization token only sees private
repositories once the organization has approved it.

Fine-grained tokens cannot read check suites or `statusCheckRollup` on private repositories (that
needs the Checks permission, which only GitHub Apps get). Workflow history and the CI state of own
pull requests therefore come from the Actions REST API (`/actions/runs`, Actions: read), requested
with `If-None-Match` so unchanged responses come back as `304` and do not count against the rate
limit. The contribution search and login use the token of the
owner that matches the token's user. An owner whose token fails keeps its last good data and is
named in a banner; the other owners keep refreshing.

#### Notifications token

`NOTIFICATIONS_TOKEN` is separate from the per-owner fine-grained tokens and should belong to
the same GitHub user as the dashboard viewer. The recommended deployment credential is a
**classic PAT with `notifications` or `repo` scope**. GitHub's
[Notifications API](https://docs.github.com/en/rest/activity/notifications) also supports OAuth
notification credentials with `notifications` or `repo` scope. Listing notifications does not
support fine-grained PATs or GitHub App tokens. Prefer the narrower `notifications` scope for
notification access; `repo` grants broader repository access and is not needed just for this API.
Organization access policies still apply.

Subject state is queried with the existing viewer token from `GITHUB_TOKENS`, not the
notifications token. That token must be able to read the relevant issues and
discussions (including private repository access where needed); inaccessible state is shown as
unknown rather than inferred from notification timestamps. Credential provisioning is a separate
operator step. On h-cloud, the optional `NOTIFICATIONS_TOKEN` key in `pr-dashboard-secret`
supplies this variable.

### Subscriptions watchlist

The tab tracks upstream issues and discussions you authored or are subscribed to, outside the
owners configured in `GITHUB_TOKENS`. Pull requests are excluded; authored ones belong to
Contributions.

- **Discovery.** `/notifications?all=true&participating=true&per_page=100` (read notifications
  included) is filtered to `reason: manual` and `reason: author` issues and discussions; pull
  request notifications are skipped before any subscription check. Open
  issues and discussions you authored are also found by search with the viewer token (up to **50**
  of each, truncation reported), skipping subjects you unsubscribed from or ignore. This is
  notification-based discovery, **not an inventory of every historical subscription**: a
  subscription without an available matching notification cannot be found. Rows found only by
  search have no notification thread.
- **Persistence.** The watchlist lives in `STATE_FILE` next to the *Done* flags and survives
  restarts; unset means memory only. Each item is re-checked directly every cycle, so it stays
  after it is read or drops out of discovery. The file is rewritten only when the watchlist
  changes.
- **Cost per cycle.** Conditional notification page requests, one thread-subscription request
  per discovered issue or discussion, one GraphQL search for authored subjects, and one GraphQL
  lookup per six watched items (title, state, subscription and last comment). Discovery itself
  makes no state lookup.
- **Unread.** An item is unread when someone else acted on it after you last acknowledged it: a
  new comment by another user (the latest comment counts) or a closure. An unread GitHub
  notification newer than your acknowledgement also makes it unread. Your own comments, edits,
  labels and reactions do not. Items stored before this check, and not yet looked up, fall back
  to the subject's last update. Newly discovered items start read unless their notification is
  unread.
- **Order.** Unread first, then latest update (including your own activity).
- **Title click.** Acknowledges the item and never blocks navigation. An open item stays as
  read; a closed item disappears and stays gone.
- **Trash.** Always removes the item. It also unsubscribes the GitHub notification thread
  ([`DELETE /notifications/threads/{thread_id}/subscription`](https://docs.github.com/en/rest/activity/notifications#delete-a-thread-subscription))
  when one exists and the subscription is confirmed. If GitHub fails, the request returns `502`
  and the item stays. Unsubscribing is not mark-read, mark-done or a permanent ignore: GitHub
  can notify again after a comment or @mention, and watching the repository can still produce
  notifications.
- **Removed items.** They stay gone unless a newer manually subscribed notification arrives. A
  closed item you have read is retired the same way. A removed item is forgotten after 180 days
  without being seen.
- **Unknown items.** An item GitHub no longer returns shows **Unknown state** and is retired
  after 14 days of unknown results. A transient lookup failure keeps the last known state.
- **Limits.** Discovery stops at **10 notification pages** or **30 distinct candidate
  subjects**. These limits apply before subscription filtering, so fewer rows may remain; six is
  only the GraphQL lookup batch size, not a display limit. Partial results carry a truncation
  warning.
- **Without `NOTIFICATIONS_TOKEN`** no notification requests are made and the tab is
  unavailable. Discovery errors are isolated to this tab, which retains previous data when
  available and reports the error. Unknown-state warnings and truncation remain visible.

### Renovate health

Repository ordering and the **last Renovate commit** link/age use `committedDate` from the
default branch's **last 100 commits** (including its head). Repositories are ordered by their latest
matching commit, **oldest first**, so those waiting longest for an update appear first. A commit qualifies
when its GitHub-linked author matches `RENOVATE_BOT_LOGIN`, or one of its **first five associated
pull requests** is merged, has `RENOVATE_BRANCH_PREFIX`, and targets this repository's current
default branch. This also recognises human-authored merge/squash commits through their PR.
Open PR heads, unrelated commits, issue activity and PR merge timestamps do not set this date.
The link and age tooltip show the exact commit timestamp.

This is a bounded history scan, not an all-time guarantee. A commit outside that window, an
unlinked author with no qualifying PR association, more than five associations, or unavailable
history can leave the date **unknown**. Repositories without a known commit sort last (ties
sort by repository name). Existing open PR lists, dashboard health and seven-day merge KPIs
continue using their existing sources; merge KPIs still use PR merge dates.

Each repository's open issues by `RENOVATE_BOT_LOGIN` are read. The Dependency Dashboard is parsed
for *Repository Problems*, `[!WARNING]`/`[!CAUTION]` notes, and the *Errored*, *PR Edited
(Blocked)*, *Rate-Limited*, *Awaiting Schedule* and *Pending Approval* sections; an open
"Action Required" issue counts as a configuration error.

## Logging

One JSON object per line; `warn` and `error` go to stderr. A healthy instance logs `listening` and
`first refresh complete`, then stays silent (each refresh is `debug`). Problems are logged with
enough context to act on without reproducing:

| Message | Level | Context |
|---|---|---|
| `owner refresh failed` | error | Owner, failure streak, age of that owner's data still served, and the GitHub error |
| `owner recovered` | info | Failed refresh count for that owner |
| `refresh failed` | error | Failing phase, consecutive failures, failing since, last success, age of the snapshot still served, and the error with GitHub operation, variables, HTTP status, `x-github-request-id`, rate limit, response body, GraphQL error paths, cause and stack |
| `refresh recovered` | info | Failed refresh count and when the outage started |
| `GitHub returned partial data` | warn | GraphQL error paths; repeated identical errors drop to `debug` |
| `GitHub rate limit below 10%` | warn | Once per rate-limit window |
| `refresh took more than half the refresh interval` | warn | Duration and interval |
| `request failed` | error | Method, URL and error |

## Routes

| Route | Description |
|---|---|
| `/` | Dashboard |
| `/data.json` | Latest snapshot; `503` until the first refresh succeeds |
| `POST /contributions/done` | `{"url": "<pull request url>", "done": true\|false}`; returns the updated snapshot. Only same-origin `application/json` requests are accepted |
| `POST /subscriptions/acknowledge` | `{"url": "<visible row url>"}`; marks the item as seen (a closed item is removed) and returns the updated snapshot. Requires same-origin `application/json`. Errors: `405` wrong method, `415` wrong content type, `403` cross-origin, `400` bad body, `404` URL not visible |
| `POST /subscriptions/remove` | `{"url": "<visible row url>"}`; removes the item, unsubscribing its notification thread when one exists and the subscription is confirmed, and returns the updated snapshot. Same requirements and errors as acknowledge, plus `502` when the GitHub unsubscribe fails (the item stays) |
| `/healthz` | Liveness; `bun pr-dashboard/healthcheck.js` probes it from inside the distroless image |

## Development

Runs on [Bun](https://bun.sh) with no dependencies.

```sh
GITHUB_TOKENS="{\"$(gh api user -q .login)\":\"$(gh auth token)\"}" bun pr-dashboard/server.js
bun test pr-dashboard/
```

## Image

```
ghcr.io/lkshrk/gh-ops/pr-dashboard:latest
```

Built by `.github/workflows/pr-dashboard-image.yml` on push to `main`.
After publishing, main builds send an `image-update` repository dispatch to `lkshrk/h-cloud`
with the image's exact digest. Its update-image workflow commits the new pin and Flux deploys it;
no release tag is required. The dispatch uses the existing Renovate GitHub App credentials,
scoped to Contents write on h-cloud. Failed builds do not trigger deployment.
