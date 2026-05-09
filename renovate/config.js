module.exports = {
  platform: 'gitea',
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

  packageRules: [
    {
      matchUpdateTypes: ['patch', 'minor', 'pin', 'digest'],
      automerge: true
    },
    {
      matchUpdateTypes: ['major'],
      automerge: false
    }
  ],

  prHourlyLimit: 4,
  prConcurrentLimit: 10,

  timezone: 'Europe/Berlin'
}
