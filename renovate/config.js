const {
  managedRepositories,
} = require('./repositories');

const targetRepositories = process.env.RENOVATE_REPOSITORIES
  ? process.env.RENOVATE_REPOSITORIES.split(',').map((repo) => repo.trim()).filter(Boolean)
  : managedRepositories;

module.exports = {
  platform: 'github',
  ...(process.env.RENOVATE_TOKEN ? { token: process.env.RENOVATE_TOKEN } : {}),

  repositories: targetRepositories,
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
