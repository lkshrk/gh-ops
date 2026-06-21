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

const manualReviewRepositories = [
  'lkshrk/agent-marketplace',
  'lkshrk/homebrew-tap',
  'lkshrk/civora-admin-web',
  'lkshrk/meshcloud_teaser',
  'lkshrk/DecideIt',
  'lkshrk/KAM',
  'lkshrk/llmctl',
  'lkshrk/klausis-cooldown-manager',
  'lkshrk/h-cloud-secrets',
  'lkshrk/lkshrk',
  'lkshrk/Excel_Project_Reporting_Tool',
  'lkshrk/ChallengeMe',
];

const skippedRepositories = [
  // No supported dependency manifests found in recursive tree scan.
  'lkshrk/agent-marketplace',
  'lkshrk/homebrew-tap',
  'lkshrk/meshcloud_teaser',
  'lkshrk/DecideIt',
  'lkshrk/h-cloud-secrets',
  'lkshrk/lkshrk',
  'lkshrk/Excel_Project_Reporting_Tool',
  'lkshrk/ChallengeMe',

  // Empty repositories.
  'lkshrk/civora-admin-web',
  'lkshrk/KAM',
  'lkshrk/llmctl',
  'lkshrk/klausis-cooldown-manager',
];

module.exports = {
  webdevHarkeRepositories,
  routivoRepositories,
  locNewsRepositories,
  lkshrkRepositories,
  managedRepositories,
  manualReviewRepositories,
  skippedRepositories,
};
