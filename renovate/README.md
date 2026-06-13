# Renovate Bot

Central self-hosted Renovate runner for `lkshrk/*` and `webdev-harke/*` GitHub
repositories.

This repo owns execution scope, credentials, shared presets, and Woodpecker run
limits. Individual repositories should keep only a small `.renovaterc.json5`
that extends the right shared preset and records repo-specific exceptions.

## Run Modes

The Woodpecker pipeline runs on:

- cron
- manual trigger

By default it runs every repository listed in `repositories.js`.

For a targeted run, set:

```sh
RENOVATE_REPOSITORIES=lkshrk/example-repo
```

Multiple repositories can be comma-separated.

## Required Secret

Woodpecker must provide:

- `renovate_token` - GitHub token or GitHub App installation token with write access to managed repositories

The token must be able to read repository contents, create branches, create pull
requests, update issues, and read check status for repositories in the allowlist.

## Repository Scope

Managed repositories are listed in `repositories.js`.

The first managed scope includes:

- active `webdev-harke/*` app repositories
- active `lkshrk/*` app/library repositories
- `lkshrk/h-cloud` as the GitOps repository

Repos in `manualReviewRepositories` are intentionally not part of the runner yet.
Each one must be inspected and either migrated to a shared preset or documented
as intentionally skipped. Repos in `skippedRepositories` were inspected and had
no supported dependency manifests or no Git tree at the time of migration.

## Shared Presets

Use these repo-local configs:

```json5
{
  extends: ["github>lkshrk/woodpecker-ops//renovate/presets/app-library.json5"]
}
```

```json5
{
  extends: ["github>lkshrk/woodpecker-ops//renovate/presets/web-app.json5"]
}
```

```json5
{
  extends: ["github>lkshrk/woodpecker-ops//renovate/presets/gitops.json5"]
}
```

## Policy

- patch, minor, pin, and digest updates may automerge after checks pass
- major updates require Dependency Dashboard approval before automerge
- no global `ignoreTests`
- repo-specific exceptions stay in the target repo config

## Future GitHub App Bridge

After cron/manual runners are stable, add a GitHub App bridge that receives
Dependency Dashboard, Renovate PR, label, and completed-check events and
triggers targeted Woodpecker runs with `RENOVATE_REPOSITORIES=owner/repo`.
