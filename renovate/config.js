const {
  managedRepositories,
} = require('./repositories');

const targetRepositories = process.env.RENOVATE_REPOSITORIES
  ? process.env.RENOVATE_REPOSITORIES.split(',').map((repo) => repo.trim()).filter(Boolean)
  : process.env.RENOVATE_RUN_ALL === 'true'
    ? managedRepositories
    : [];

const hostRules = [
  ...(process.env.DOCKERHUB_USERNAME && process.env.DOCKERHUB_PASSWORD
    ? [
        {
          hostType: 'docker',
          matchHost: 'docker.io',
          username: process.env.DOCKERHUB_USERNAME,
          password: process.env.DOCKERHUB_PASSWORD,
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
