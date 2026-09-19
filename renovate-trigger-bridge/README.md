# renovate-trigger-bridge

Webhook receiver that fires a GitHub `repository_dispatch` event when a Renovate
dashboard checkbox is checked in a managed repository.

## How it works

The `renovate-master` GitHub App delivers webhook events (Issues, Pull request,
Issue comment) to `/github-webhook`. When the bridge detects a newly-checked
Renovate trigger checkbox it POSTs a `repository_dispatch` to GitHub, which
triggers the `renovate.yml` workflow with `RENOVATE_REPO_FILTER` set to the
source repository.

A GitHub App has a single webhook URL, so the bridge also fans deliveries out to
an in-cluster OpenHands automation service that has no public ingress. Once the
GitHub signature has been verified, every delivery whose event is listed in
`OPENHANDS_FORWARD_EVENTS` is POSTed to `OPENHANDS_EVENTS_URL` with the raw body
unchanged, the original `X-GitHub-Event` and `X-GitHub-Delivery` headers, and an
`X-Hub-Signature-256` computed with `OPENHANDS_WEBHOOK_SECRET`. The forward is
fire-and-forget: it never changes the response to GitHub and never blocks or
fails the `repository_dispatch` path.

`pull_request` deliveries are deduplicated by repository, pull request and head SHA
before forwarding, because each one starts a full review downstream: a branch pushed
twice, or pushed and then commented on, produced three reviews of one commit. A new push
changes the head and is forwarded; `issue_comment` is never deduplicated, so an explicit
`@openhands review` always reaches the agent. The window is in-memory, so a restart costs
at most one duplicate review.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | — | Required. GitHub App webhook secret. |
| `GITHUB_DISPATCH_TOKEN` | — | Required. Fine-grained PAT with Contents write on `lkshrk/gh-ops`. |
| `DISPATCH_REPO` | `lkshrk/gh-ops` | Target repo for `repository_dispatch`. |
| `EVENT_TYPE` | `renovate` | `event_type` sent in the dispatch payload. |
| `PORT` | `3000` | HTTP listen port. |
| `RENOVATE_BRIDGE_DRY_RUN` | `false` | Log but do not dispatch or forward. |
| `OPENHANDS_EVENTS_URL` | — | Forward deliveries to this URL. Unset disables forwarding. |
| `OPENHANDS_WEBHOOK_SECRET` | — | Required when `OPENHANDS_EVENTS_URL` is set. Signs the forwarded body. |
| `OPENHANDS_FORWARD_EVENTS` | `pull_request,issue_comment` | Comma-separated `X-GitHub-Event` allowlist. |
| `OPENHANDS_FORWARD_TIMEOUT_MS` | `5000` | Forward request timeout. |
| `OPENHANDS_HEAD_TTL_MS` | `900000` | Window in which a repeated `pull_request` delivery for one head is dropped. |

## Image

```
ghcr.io/lkshrk/gh-ops/renovate-trigger-bridge:latest
```

Built automatically by `.github/workflows/bridge-image.yml` on push to `main`.

## GitHub App webhook

Point the `renovate-master` App webhook at `https://<bridge-host>/github-webhook`
and subscribe to: **Issues**, **Pull request**, **Issue comment**.

## k8s deployment

Manifests and the SOPS-encrypted secret live in the `lkshrk/h-cloud` repo.
Remove any `WOODPECKER_*` env vars and add `GITHUB_DISPATCH_TOKEN` and
`DISPATCH_REPO` to the secret.
