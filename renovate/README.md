# Renovate Bot

Central self-hosted Renovate runner for `lkshrk/*`, `webdev-harke/*`,
`routivo/*`, and `loc-news/*` GitHub repositories.

This repo owns execution scope, credentials, shared presets, and run limits.
Renovate runs from a single GitHub Actions workflow
(`.github/workflows/renovate.yml`); `config.js` owns scope and credentials.

## How It Runs

The workflow fans out over owners with a matrix. Each owner job mints an
owner-scoped GitHub App installation token via
[`actions/create-github-app-token`](https://github.com/actions/create-github-app-token)
(the `owner` input selects the installation — no per-owner installation ids)
and runs [`renovatebot/github-action`](https://github.com/renovatebot/github-action)
with `config.js`.

Triggers:

- **`schedule`** — every 2 hours, autodiscover run per owner. Dependency
  Dashboard checkboxes (rebase, approve, etc.) are honoured on the next run.
- **`workflow_dispatch`** — manual run. Leave `repositories` blank to autodiscover,
  or pass a comma-separated `owner/repo` list for a targeted run.
- **`repository_dispatch`** (`type: renovate`) — programmatic trigger. Pass
  `client_payload.repositories` for a targeted run.

The dispatch/input value reaches `config.js` as `RENOVATE_REPO_FILTER`: when
non-empty each owner job pins to the repos it can access, otherwise it
autodiscovers every repo its App installation can see.

### Targeted Run

Manual, via the Actions UI (`workflow_dispatch` input `repositories`):

```text
lkshrk/example-repo,webdev-harke/another-repo
```

Programmatic, via `repository_dispatch`:

```sh
gh api repos/lkshrk/gh-ops/dispatches \
  -f event_type=renovate \
  -f 'client_payload[repositories]=lkshrk/example-repo'
```

### Instant Dashboard-Checkbox Triggers

A workflow in this repo cannot observe issue/PR events in other repositories, so
checkbox clicks are handled instantly by the k8s bridge in
`../renovate-trigger-bridge/`: it receives the `renovate-master` App webhook and fires
the `repository_dispatch` above for the source `owner/repo`. The 2-hour schedule
is the fallback.

## Required Secrets

Configure as GitHub Actions repository secrets:

- `RENOVATE_APP_ID` — GitHub App id (or client id)
- `RENOVATE_APP_PRIVATE_KEY` — GitHub App private key, raw PEM
- `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` — Docker Hub creds for `docker.io`
  `hostRules` (avoid unauthenticated pull-rate limits during datasource lookups)
- `GHCR_USERNAME` / `GHCR_TOKEN` — GitHub username + classic PAT with
  `read:packages` for `ghcr.io` `hostRules`

The GitHub App must be installed on every managed owner with access to the
managed repositories. GHCR metadata lookups need a classic PAT; App installation
tokens cover repository and pull-request access but not GHCR package metadata.

Recommended GitHub App repository permissions:

- Contents: read/write
- Pull requests: read/write
- Issues: read/write
- Commit statuses: read/write
- Metadata: read-only
- Workflows: read/write if Renovate needs to update workflow files

## Repository Scope

There is no central allowlist. Each owner job runs `autodiscover`, so Renovate
acts on every repo the App installation can see, gated by two things:

1. **App installation scope** — install `renovate-master` on the repos (or "All
   repositories") you want in scope per owner.
2. **Repo-local config** — `requireConfig: required` + `onboarding: false` skip
   any repo without a Renovate config (`disabled-no-config`), so only repos that
   extend a shared preset actually get PRs.

A non-empty `RENOVATE_REPO_FILTER` (the `workflow_dispatch` / `repository_dispatch`
input) pins a run to specific repos and disables autodiscover.

`config.js` is self-contained: the action mounts only that file into the
container, so it must not `require` sibling files.

### Bun Extractor Workaround

The central config exports an async factory that repairs a missing Bun
single-file extractor before Renovate starts processing repositories. Renovate
44.198.2 calls this extractor during pending-version checks, but its Bun manager
does not export it, causing `Could not re-extract the packageFile after updating
it` for valid manifests.

The factory adds npm's extractor to Bun's manager registry entry and preserves
all existing Bun hooks. It leaves an upstream-provided extractor untouched.
Release-age checks remain enabled. This applies to every repository processed
by this runner; no repository-local preset change is needed.

This workaround uses Renovate's internal module layout, resolved relative to
its running entrypoint. An incompatible layout fails startup with a specific
error. Remove the workaround once the deployed Renovate version exports Bun's
single-file extractor upstream.

Run the integration checks against an installed Renovate package:

```sh
RENOVATE_TEST_DIST_DIR=/path/to/node_modules/renovate/dist \
  node --test renovate/config.test.js
```

The tests use Renovate's real config loader and manager dispatcher, including
the missing-extractor case, preservation of an upstream fix, and layout errors.

## Shared Presets

Use these repo-local configs:

```json5
{ extends: ["github>lkshrk/gh-ops//renovate/presets/app-library.json5"] }
```

```json5
{ extends: ["github>lkshrk/gh-ops//renovate/presets/web-app.json5"] }
```

```json5
{ extends: ["github>lkshrk/gh-ops//renovate/presets/gitops.json5"] }
```

All three include `github-actions.json5` followed by `groups.json5`, which keeps
Node.js, Bun, Playwright and SvelteKit (Kit, adapters, vite-plugin-svelte,
Svelte) together across workflows, Dockerfiles and package files: one branch per
group, with majors on a separate `major-` branch as usual. Repo-local groups that match these packages override them, because local rules
apply last.

Repos with a standalone config add `github-actions.json5`
to their `extends`; repos that only want action and runner updates use:

```json5
{
  extends: ["github>lkshrk/gh-ops//renovate/presets/github-actions.json5"],
  enabledManagers: ["github-actions", "custom.regex"],
}
```

Such repos get no runtime groups, so a Node.js or Bun minor in a workflow joins
the "github actions" group. Add `groups.json5` after `github-actions.json5` to
keep runtimes separate.

Repos whose CI is trusted to gate major updates add `automerge-major.json5`
after their base preset:

```json5
{
  extends: [
    "github>lkshrk/gh-ops//renovate/presets/app-library.json5",
    "github>lkshrk/gh-ops//renovate/presets/automerge-major.json5",
  ],
}
```

## Policy

- patch, minor, pin, and digest updates may automerge after checks pass
- major updates require Dependency Dashboard approval before automerge
- GitHub Actions and runner images (including Blacksmith `blacksmith-*-ubuntu-*`
  labels) update at any time regardless of the repo schedule; non-majors are
  grouped into one PR, majors open their own PR without approval and never
  automerge
- `automerge-major.json5` opts a repo into automerging all majors, GitHub
  Actions included, without approval once checks pass
- no global `ignoreTests`
- repo-specific exceptions stay in the target repo config
