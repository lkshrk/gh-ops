const http = require('node:http');
const {
  buildBridgeLogEntry,
  createDeliveryDeduper,
  resolveTrigger,
  triggerWoodpecker,
  verifyGitHubSignature,
} = require('./bridge');

const port = Number(process.env.PORT || 3000);
const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
const dryRun = process.env.RENOVATE_BRIDGE_DRY_RUN === 'true';
const deliveryDeduper = createDeliveryDeduper({
  ttlMs: Number(process.env.RENOVATE_BRIDGE_DELIVERY_TTL_MS || 60 * 60 * 1000),
});

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
  });
  response.end(JSON.stringify(body));
}

function logBridgeEvent(outcome, details) {
  console.log(JSON.stringify(buildBridgeLogEntry(outcome, details)));
}

async function handleWebhook(request, response) {
  const rawBody = await readBody(request);
  const signature = request.headers['x-hub-signature-256'];
  const event = request.headers['x-github-event'];
  const delivery = request.headers['x-github-delivery'];

  if (!verifyGitHubSignature(webhookSecret, rawBody, signature)) {
    logBridgeEvent('invalid_signature', { delivery, event, reason: 'invalid signature' });
    sendJson(response, 401, { ok: false, error: 'invalid signature' });
    return;
  }

  const payload = JSON.parse(rawBody.toString('utf8'));
  const trigger = resolveTrigger(event, payload);
  const logDetails = {
    delivery,
    event,
    action: payload.action,
    repository: trigger.repository || (payload.repository && payload.repository.full_name),
    reason: trigger.reason,
  };

  if (!trigger.shouldTrigger) {
    logBridgeEvent('ignored', logDetails);
    sendJson(response, 202, {
      ok: true,
      triggered: false,
      reason: trigger.reason,
      delivery,
    });
    return;
  }

  if (deliveryDeduper.check(delivery)) {
    logBridgeEvent('duplicate', logDetails);
    sendJson(response, 202, {
      ok: true,
      triggered: false,
      duplicate: true,
      repository: trigger.repository,
      reason: 'duplicate delivery',
      delivery,
    });
    return;
  }

  if (dryRun) {
    logBridgeEvent('dry_run', logDetails);
    sendJson(response, 202, {
      ok: true,
      triggered: false,
      dryRun: true,
      repository: trigger.repository,
      reason: trigger.reason,
      delivery,
    });
    return;
  }

  const pipeline = await triggerWoodpecker(trigger.repository);
  logBridgeEvent('triggered', { ...logDetails, pipeline });
  sendJson(response, 202, {
    ok: true,
    triggered: true,
    repository: trigger.repository,
    reason: trigger.reason,
    delivery,
    pipeline: {
      number: pipeline.number,
      status: pipeline.status,
      url: pipeline.link || pipeline.url,
    },
  });
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/healthz') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'POST' && request.url === '/github-webhook') {
      await handleWebhook(request, response);
      return;
    }

    sendJson(response, 404, { ok: false, error: 'not found' });
  } catch (error) {
    console.error(JSON.stringify(buildBridgeLogEntry('error', { error: error.message })));
    sendJson(response, 500, { ok: false, error: error.message });
  }
});

server.listen(port, () => {
  console.log(`renovate trigger bridge listening on :${port}`);
});
