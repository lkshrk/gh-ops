const crypto = require('node:crypto');

const installationId = process.argv[2] || process.env.GITHUB_APP_INSTALLATION_ID;
const appId = process.env.GITHUB_APP_ID;
const privateKey =
  process.env.GITHUB_APP_PRIVATE_KEY ||
  (process.env.GITHUB_APP_PRIVATE_KEY_B64
    ? Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY_B64, 'base64').toString('utf8')
    : '');

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function createJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: now - 60,
    exp: now + 540,
    iss: appId,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(unsigned)
    .sign(privateKey);

  return `${unsigned}.${base64url(signature)}`;
}

async function main() {
  if (!appId) {
    throw new Error('GITHUB_APP_ID is required');
  }
  if (!privateKey) {
    throw new Error('GITHUB_APP_PRIVATE_KEY_B64 or GITHUB_APP_PRIVATE_KEY is required');
  }
  if (!installationId) {
    throw new Error('GitHub App installation id is required');
  }

  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${createJwt()}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'woodpecker-ops-renovate',
      },
    },
  );

  if (!response.ok) {
    throw new Error(`GitHub App token request failed: ${response.status} ${await response.text()}`);
  }

  const body = await response.json();
  if (!body.token) {
    throw new Error('GitHub App token response did not contain a token');
  }

  process.stdout.write(body.token);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
