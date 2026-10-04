# pr-dashboard

Live, single-page dashboard over everything you maintain or contribute to on GitHub:

1. **Contributions**: your open pull requests to other people's projects, split into *Needs you*
   (failing CI, changes requested, or a human spoke after your last push/comment, including
   unresolved review threads), *Open, waiting on others*, and *Recently closed*.
2. **Failing workflows**: default-branch GitHub Actions workflows across your own and your
   organizations' repositories whose latest `FAIL_STREAK` runs all failed, with a run strip and
   the date the streak started. Workflows with a shorter red streak sit in a collapsed list.
3. **Renovate**: repositories ranked by their oldest last-merged Renovate pull request, with the
   open Renovate pull requests and their CI state. Pending onboarding PRs and repositories
   without Renovate are listed separately.

Repositories are color-coded by owner; owner chips filter sections 2 and 3, and the selection is
remembered per browser.

## How it works

The server polls the GitHub GraphQL API every `REFRESH_INTERVAL_MS` and keeps the latest snapshot
in memory. Visitors only ever read that snapshot from `/data.json`, so the API load is fixed no
matter how many tabs are open. A refresh costs roughly 40 GraphQL points.

Own repositories are those the token's user owns or reaches as an organization member
(not archived, not forks). Pull requests to those owners are excluded from *Contributions*.
Renovate pull requests are recognised by their head branch prefix, because a self-hosted
Renovate App does not show up as `app/renovate`.

There is no authentication in the app. Put it behind a forward-auth proxy (Authentik on h-cloud).

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `GITHUB_TOKEN` | — | Required. Token for the user whose dashboard this is. |
| `PORT` | `3000` | HTTP listen port. |
| `REFRESH_INTERVAL_MS` | `60000` | How often to poll GitHub. |
| `FAIL_STREAK` | `3` | Consecutive failed runs that count as constantly failing. |
| `RENOVATE_BRANCH_PREFIX` | `renovate/` | Head branch prefix of Renovate pull requests. |
| `CLOSED_WINDOW_DAYS` | `30` | How far back *Recently closed* reaches. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |

### Token

A fine-grained PAT on the user account with read-only **Metadata**, **Contents**,
**Pull requests** and **Actions** on all repositories. Organization repositories need the
organization to allow fine-grained tokens; otherwise use a classic PAT with `repo` and
`read:org`. Contributions to public repositories need no extra scope.

## Logging

One JSON object per line; `warn` and `error` go to stderr. A healthy instance logs `listening` and
`first refresh complete`, then stays silent (each refresh is `debug`). Problems are logged with
enough context to act on without reproducing:

| Message | Level | Context |
|---|---|---|
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
| `/healthz` | Liveness |

## Development

Runs on [Bun](https://bun.sh) with no dependencies.

```sh
GITHUB_TOKEN=$(gh auth token) bun pr-dashboard/server.js
bun test pr-dashboard/
```

## Image

```
ghcr.io/lkshrk/gh-ops/pr-dashboard:latest
```

Built by `.github/workflows/pr-dashboard-image.yml` on push to `main`.
