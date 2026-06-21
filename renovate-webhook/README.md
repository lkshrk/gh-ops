# Renovate Webhook

Cloudflare Worker that turns Renovate Dependency Dashboard / PR checkbox clicks
into an instant Renovate run, replacing the old k8s trigger bridge.

```
renovate-master App webhook
  -> Worker (verify signature, detect newly-checked box)
  -> POST repos/lkshrk/gh-ops/dispatches { event_type: renovate, client_payload.repositories: owner/repo }
  -> Renovate workflow runs that one repo
```

The Worker only receives events for repos the App is installed on, so no
allowlist is needed. For `edited` events it compares the previous body so an
already-checked box is not retriggered by unrelated edits.

## Triggers

A checked checkbox line in an issue body, PR body, or issue comment:

```md
- [x] run renovate
```

plus Renovate's own dashboard/PR checkboxes (checked box + `<!-- marker -->`).

## Deploy

```sh
cd renovate-webhook
wrangler deploy
wrangler secret put WEBHOOK_SECRET   # GitHub App webhook secret
wrangler secret put DISPATCH_TOKEN   # fine-grained PAT, Actions: read/write on lkshrk/gh-ops
```

Then in the `renovate-master` App settings set the webhook:

- Webhook URL: `https://renovate-webhook.<subdomain>.workers.dev/`
- Secret: same value as `WEBHOOK_SECRET`
- Active: on
- Subscribe to: Issues, Pull requests, Issue comments

`https://renovate-webhook.<subdomain>.workers.dev/healthz` returns `ok`.

## Token

`DISPATCH_TOKEN` is a fine-grained PAT scoped to `lkshrk/gh-ops` with
**Actions: read and write** (needed to create a `repository_dispatch`). It does
not need access to the managed repos — those are reached by the App token inside
the workflow.
