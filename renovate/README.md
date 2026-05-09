# Renovate Bot

Central self-hosted Renovate runner for Codeberg.

## Token

Requires a Codeberg personal access token from a dedicated bot account.

Recommended scope:

- repo

The bot user must have write access to all repositories Renovate should update.

## Woodpecker secrets

Required secret:

- renovate_token

## Run modes

This pipeline runs on:

- manual trigger
- cron trigger

Recommended cron:

```cron
0 3 */3 * *
