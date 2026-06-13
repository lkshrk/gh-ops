const {
  webdevHarkeRepositories,
  lkshrkRepositories,
  managedRepositories,
} = require('./repositories');

const repositoryOwner = process.env.RENOVATE_REPOSITORY_OWNER;

const repositoriesForOwner = (() => {
  switch (repositoryOwner) {
    case 'webdev-harke':
      return webdevHarkeRepositories;
    case 'lkshrk':
      return lkshrkRepositories;
    default:
      return managedRepositories;
  }
})();

const explicitRepositories = process.env.RENOVATE_REPOSITORIES
  ? process.env.RENOVATE_REPOSITORIES.split(',').map((repo) => repo.trim()).filter(Boolean)
  : [];

const targetRepositories = explicitRepositories.length
  ? explicitRepositories.filter((repo) => !repositoryOwner || repo.startsWith(`${repositoryOwner}/`))
  : process.env.RENOVATE_RUN_ALL === 'true'
    ? repositoriesForOwner
    : [];

const dockerUsername =
  process.env.RENOVATE_DOCKER_USERNAME ||
  process.env.DOCKERHUB_USERNAME ||
  process.env.DOCKER_USER;
const dockerPassword =
  process.env.RENOVATE_DOCKER_PASSWORD ||
  process.env.DOCKERHUB_PASSWORD ||
  process.env.DOCKER_TOKEN;

const hostRules = [
  ...(dockerUsername && dockerPassword
    ? [
        {
          hostType: 'docker',
          matchHost: 'docker.io',
          username: dockerUsername,
          password: dockerPassword,
        },
      ]
    : []),
];

module.exports = {
  platform: 'github',
  ...(process.env.RENOVATE_TOKEN ? { token: process.env.RENOVATE_TOKEN } : {}),

  repositories: targetRepositories,
  hostRules,
  onboarding: false,
  requireConfig: 'required',

  gitAuthor: 'Renovate Bot <bot@renovateapp.com>',
  dependencyDashboard: true,
  dependencyDashboardTitle: 'Renovate Dashboard',

  prHourlyLimit: 5,
  prConcurrentLimit: 10,
  timezone: 'Europe/Berlin',

  // Repository behavior belongs in repo-local config via shared presets.
  // This central file owns execution scope, credentials, and run limits.
};
