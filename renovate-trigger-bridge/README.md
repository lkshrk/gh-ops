# renovate-trigger-bridge

Webhook receiver that fires a GitHub `repository_dispatch` event when a Renovate
dashboard checkbox is checked in a managed repository.

## How it works

The `renovate-master` GitHub App delivers webhook events (Issues, Pull request,
Issue comment) to `/github-webhook`. When the bridge detects a newly-checked
Renovate trigger checkbox it POSTs a `repository_dispatch` to GitHub, which
triggers the `renovate.yml` workflow with `RENOVATE_REPO_FILTER` set to the
source repository.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | — | Required. GitHub App webhook secret. |
| `GITHUB_DISPATCH_TOKEN` | — | Required. Fine-grained PAT with Actions read+write on `lkshrk/gh-ops`. |
| `DISPATCH_REPO` | `lkshrk/gh-ops` | Target repo for `repository_dispatch`. |
| `EVENT_TYPE` | `renovate` | `event_type` sent in the dispatch payload. |
| `PORT` | `3000` | HTTP listen port. |
| `RENOVATE_BRIDGE_DRY_RUN` | `false` | Log but do not dispatch. |

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
