module.exports = {
  platform: 'forgejo',
  endpoint: 'https://codeberg.org/api/v1',
  token: process.env.RENOVATE_TOKEN,

  autodiscover: true,

  // Strongly recommended once tested:
  // autodiscoverFilter: ['your-user/*', 'your-org/*'],

  onboarding: true,
  requireConfig: 'optional',

  extends: ['config:recommended'],

  dependencyDashboard: true,

  automerge: true,
  automergeType: 'pr',
  platformAutomerge: true,

  hostRules: [
    {
      matchHost: 'api.github.com',
      token: process.env.GITHUB_TOKEN
    },
    {
      matchHost: 'github.com',
      token: process.env.GITHUB_TOKEN,
    },
  ],

  packageRules: [
    {
      matchUpdateTypes: ['patch', 'minor', 'pin', 'digest'],
      groupName: 'minor and patch dependencies',
      automerge: true
    },
    {
      matchUpdateTypes: ['major'],
      automerge: false
    }
  ],

  prHourlyLimit: 20,
  prConcurrentLimit: 10,

  timezone: 'Europe/Berlin'
}
