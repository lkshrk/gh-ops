module.exports = {
  platform: 'github',
  token: process.env.RENOVATE_TOKEN,

  autodiscover: true,
  autodiscoverFilter: [
    'lkshrk/civora-backend',
    'lkshrk/civora-web',
    'lkshrk/civora-spec',
  ],

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
