const webdevHarkeRepositories = [
  'webdev-harke/pfalz-herz',
  'webdev-harke/ISC',
  'webdev-harke/pizzeria-riva',
  'webdev-harke/quintessenz-horst',
  'webdev-harke/portfolio',
];

const routivoRepositories = [
  'routivo/routivo-monorepo',
];

const locNewsRepositories = [
  'loc-news/civora-monorepo',
];

const lkshrkRepositories = [
  'lkshrk/h-cloud',
  'lkshrk/directus-extension-reply-to-mail',
  'lkshrk/linear-ai',
  'lkshrk/d-streamy',
  'lkshrk/rybbit-oidc',
  'lkshrk/omni',
  'lkshrk/better-audio-mixer',
  'lkshrk/skeletoni',
  'lkshrk/civora-backend',
  'lkshrk/civora-spec',
  'lkshrk/signal-cli-seerr-plugin',
  'lkshrk/showcase-frontend',
  'lkshrk/showcase-auth',
  'lkshrk/showcase-api',
  'lkshrk/python-is-awesome',
  'lkshrk/onWB',
  'lkshrk/hammerspoon-ultrawide',
  'lkshrk/civora-web',
  'lkshrk/dotfiles',
  'lkshrk/challenge-demo',
  'lkshrk/Easy-Web-GPG',
  'lkshrk/sonarr-season-reminder',
  'lkshrk/docker-cloudnativepg-timescale',
  'lkshrk/WoW-DragonflightUI',
  'lkshrk/kickstart.nvim',
  'lkshrk/TooltipRealmInfo',
  'lkshrk/home-assistant-openplantbook',
  'lkshrk/homeassistant-plant',
  'lkshrk/hass-core',
];

const managedRepositories = [
  ...webdevHarkeRepositories,
  ...routivoRepositories,
  ...locNewsRepositories,
  ...lkshrkRepositories,
];

const repositoriesForOwner = (() => {
  switch (process.env.RENOVATE_REPOSITORY_OWNER) {
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

const repositoryOwner = process.env.RENOVATE_REPOSITORY_OWNER;
const targetRepositories = explicitRepositories.length
  ? explicitRepositories.filter((repo) => !repositoryOwner || repo.startsWith(`${repositoryOwner}/`))
  : process.env.RENOVATE_RUN_ALL === 'true'
    ? repositoriesForOwner
    : [];

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
