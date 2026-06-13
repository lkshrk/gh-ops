const apiUrl = (process.env.WOODPECKER_API_URL || 'https://ci.h-cloud.io/api').replace(/\/$/, '');
const token = process.env.WOODPECKER_TOKEN;
const repoSlug = process.env.WOODPECKER_REPO || 'lkshrk/woodpecker-ops';
const cronName = process.env.RENOVATE_CRON_NAME || 'renovate-daily';
const schedule = process.env.RENOVATE_CRON_SCHEDULE || '@daily';
const branch = process.env.RENOVATE_CRON_BRANCH || 'main';
const timezone = process.env.RENOVATE_CRON_TIMEZONE;

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
    const hint = response.status === 404
      ? ' Check WOODPECKER_TOKEN permissions and WOODPECKER_REPO / WOODPECKER_REPO_ID.'
      : '';
    throw new Error(`${options.method || 'GET'} ${path} failed: ${response.status} ${await response.text()}${hint}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function resolveRepoId() {
  if (process.env.WOODPECKER_REPO_ID) {
    return process.env.WOODPECKER_REPO_ID;
  }

  const [owner, name] = repoSlug.split('/');
  if (!owner || !name) {
    throw new Error('WOODPECKER_REPO must be in owner/name format');
  }

  const repo = await request(`/repos/lookup/${owner}/${name}`);
  if (!repo.id) {
    throw new Error(`Woodpecker lookup for ${repoSlug} did not return an id`);
  }

  return repo.id;
}

function asArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  return value && Array.isArray(value.crons) ? value.crons : [];
}

async function main() {
  const repoId = await resolveRepoId();
  const crons = asArray(await request(`/repos/${repoId}/cron`));
  const payload = {
    name: cronName,
    branch,
    schedule,
    enabled: true,
    variables: {
      RENOVATE_RUN_ALL: 'true',
    },
  };
  if (timezone) {
    payload.timezone = timezone;
  }

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
    repoId,
    repo: repoSlug,
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
