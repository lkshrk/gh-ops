const repositoryOwner = process.env.RENOVATE_REPOSITORY_OWNER;

const explicitRepositories = process.env.RENOVATE_REPO_FILTER
  ? process.env.RENOVATE_REPO_FILTER.split(',').map((repo) => repo.trim()).filter(Boolean)
  : [];

const targetRepositories = explicitRepositories.filter(
  (repo) => !repositoryOwner || repo.startsWith(`${repositoryOwner}/`),
);

const dockerUsername = process.env.RENOVATE_DOCKER_USERNAME || process.env.DOCKERHUB_USERNAME;
const dockerPassword = process.env.RENOVATE_DOCKER_PASSWORD || process.env.DOCKERHUB_PASSWORD;
const ghcrUsername = process.env.GHCR_USERNAME;
const ghcrPassword = process.env.GHCR_PASSWORD;

const hostRules = [
  ...(dockerUsername && dockerPassword
    ? [{ hostType: 'docker', matchHost: 'docker.io', username: dockerUsername, password: dockerPassword }]
    : []),
  ...(ghcrUsername && ghcrPassword
    ? [{ hostType: 'docker', matchHost: 'ghcr.io', username: ghcrUsername, password: ghcrPassword }]
    : []),
];

const config = {
  platform: 'github',
  ...(process.env.RENOVATE_TOKEN ? { token: process.env.RENOVATE_TOKEN } : {}),

  // A non-empty RENOVATE_REPO_FILTER pins the run to those repos; otherwise
  // autodiscover every repo the App installation can see. requireConfig skips
  // repos without a Renovate config, so installation scope plus repo-local
  // config are the only gates -- no central allowlist to maintain.
  ...(explicitRepositories.length
    ? { autodiscover: false, repositories: targetRepositories }
    : { autodiscover: true }),

  hostRules,
  onboarding: false,
  requireConfig: 'required',

  dependencyDashboard: true,
  dependencyDashboardTitle: 'Renovate Dashboard',

  prHourlyLimit: 5,
  prConcurrentLimit: 10,

  pruneStaleBranches: true,

  
  timezone: 'Europe/Berlin',
};

module.exports = async () => {
  // Renovate 44.198.2's pending-version check calls a single-file extractor
  // that Bun does not export. Reuse npm's extractor, as Bun already does for
  // package.json extraction. Remove this workaround once upstream fixes Bun.
  // https://github.com/renovatebot/renovate/blob/44.198.2/lib/modules/manager/bun/index.ts
  const { realpathSync } = require('node:fs');
  const { dirname, join } = require('node:path');
  const { pathToFileURL } = require('node:url');

  try {
    const distDir = dirname(realpathSync(process.argv[1]));
    const { getManagers } = await import(pathToFileURL(join(distDir, 'modules/manager/index.js')).href);
    const managers = getManagers();
    const bun = managers.get('bun');
    if (!bun) throw new Error('Bun manager is unavailable');

    if (typeof bun.extractPackageFile !== 'function') {
      const { extractPackageFile } = await import(pathToFileURL(join(distDir, 'modules/manager/npm/extract/index.js')).href);
      if (typeof extractPackageFile !== 'function') throw new Error('npm extractor is unavailable');
      managers.set('bun', { ...bun, extractPackageFile });
    }
  } catch (cause) {
    throw new Error('Cannot apply the central Renovate Bun extractor workaround; review the installed Renovate module layout', { cause });
  }

  return config;
};
