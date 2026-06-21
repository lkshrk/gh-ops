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

module.exports = {
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

  gitAuthor: 'Renovate Bot <bot@renovateapp.com>',
  dependencyDashboard: true,
  dependencyDashboardTitle: 'Renovate Dashboard',

  prHourlyLimit: 5,
  prConcurrentLimit: 10,
  timezone: 'Europe/Berlin',
};
