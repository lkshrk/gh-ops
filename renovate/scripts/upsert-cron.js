const apiUrl = (process.env.WOODPECKER_API_URL || 'https://ci.h-cloud.io/api').replace(/\/$/, '');
const token = process.env.WOODPECKER_TOKEN;
const repoId = process.env.WOODPECKER_REPO_ID || '13';
const cronName = process.env.RENOVATE_CRON_NAME || 'renovate-daily';
const schedule = process.env.RENOVATE_CRON_SCHEDULE || '@daily';
const branch = process.env.RENOVATE_CRON_BRANCH || 'main';
const timezone = process.env.RENOVATE_CRON_TIMEZONE || 'Europe/Berlin';

if (!token) {
  throw new Error('WOODPECKER_TOKEN is required');
}

const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
};

async function request(path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      ...headers,
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path} failed: ${response.status} ${await response.text()}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function main() {
  const crons = await request(`/repos/${repoId}/cron`);
  const payload = {
    name: cronName,
    branch,
    schedule,
    timezone,
    enabled: true,
    variables: {
      RENOVATE_RUN_ALL: 'true',
    },
  };

  const existing = crons.find((cron) => cron.name === cronName);
  const result = existing
    ? await request(`/repos/${repoId}/cron/${existing.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
    : await request(`/repos/${repoId}/cron`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });

  console.log(JSON.stringify({
    action: existing ? 'updated' : 'created',
    id: result.id,
    name: result.name,
    branch: result.branch,
    schedule: result.schedule,
    timezone: result.timezone,
    variables: result.variables,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
