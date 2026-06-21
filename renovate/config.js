const {
  webdevHarkeRepositories,
  routivoRepositories,
  locNewsRepositories,
  lkshrkRepositories,
  managedRepositories,
} = require('./repositories');

const repositoryOwner = process.env.RENOVATE_REPOSITORY_OWNER;

const repositoriesForOwner = (() => {
  switch (repositoryOwner) {
    case 'webdev-harke':
      return webdevHarkeRepositories;
    case 'routivo':
      return routivoRepositories;
    case 'loc-news':
      return locNewsRepositories;
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

const ghcrUsername = process.env.GHCR_USERNAME;
const ghcrPassword = process.env.GHCR_PASSWORD;

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
  ...(ghcrUsername && ghcrPassword
    ? [
        {
          hostType: 'docker',
          matchHost: 'ghcr.io',
          username: ghcrUsername,
          password: ghcrPassword,
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
};
