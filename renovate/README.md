# Renovate Bot

Central self-hosted Renovate runner for `lkshrk/*` and `webdev-harke/*` GitHub
repositories.

This repo owns execution scope, credentials, shared presets, and Woodpecker run
limits. The first migration wave preserves each target repository's existing
Renovate config 1:1 and only removes old repo-local Renovate pipelines. Shared
presets are available for a later cleanup pass after the central runner is
stable.

## Run Modes

The Woodpecker pipeline runs on:

- cron
- manual trigger

By default it exits without running Renovate. This prevents double runs while
target repositories still have repo-local Renovate pipelines.

For a targeted run, set:

```sh
RENOVATE_REPOSITORIES=lkshrk/example-repo
```

Multiple repositories can be comma-separated.
If the list contains both owners, each Woodpecker step filters the list to the
repositories its owner-scoped token can access.

After old repo-local Renovate pipelines have been removed from target
repositories, set this for a full allowlist run:

```sh
RENOVATE_RUN_ALL=true
```

## Required Secrets

Woodpecker must provide:

- `github_app_id` - GitHub App client id, preferred for JWT issuer, or app id
- `github_app_private_key_b64` - base64-encoded GitHub App private key
- `github_app_installation_id_lkshrk` - installation id for the `lkshrk` account
- `github_app_installation_id_webdev_harke` - installation id for the `webdev-harke` organization
- `docker_user` - Docker Hub username for authenticated image metadata lookups
- `docker_token` - Docker Hub password or access token
- `perso_user` - GitHub username for GHCR image metadata lookups
- `perso_token` - GitHub classic PAT with `read:packages` for GHCR image metadata lookups

The GitHub App should be installed on both owners with access to the managed
repositories. The pipeline exchanges the app credentials for short-lived
installation tokens per owner before running Renovate.

Recommended GitHub App repository permissions:

- Contents: read/write
- Pull requests: read/write
- Issues: read/write
- Commit statuses: read/write
- Metadata: read-only
- Workflows: read/write if Renovate needs to update workflow files

Docker Hub credentials are used by Renovate `hostRules` for `docker.io` to avoid
unauthenticated pull-rate limits during Docker datasource lookups.
The pipeline maps `docker_user` / `docker_token` to both `DOCKERHUB_*` and
`RENOVATE_DOCKER_*` environment variables. Full allowlist runs fail fast if the
Docker Hub credentials are missing.

GHCR credentials are used by Renovate `hostRules` for `ghcr.io`. GitHub Packages
container registry authentication uses a classic PAT with `read:packages`; GitHub
App installation tokens are still used for repository and pull request access,
but not for GHCR package metadata lookups.

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
