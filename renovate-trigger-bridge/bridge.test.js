const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasRenovateTriggerCheckbox,
  resolveTrigger,
  verifyGitHubSignature,
  buildBridgeLogEntry,
  createDeliveryDeduper,
  forwardToOpenHands,
  reviewKey,
  triggerDispatch,
} = require('./bridge');

const openhandsBody = Buffer.from('{"action":"opened","number":7}');

function recordingFetch(result = { ok: true, status: 202 }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return result;
  };

  return { calls, fetchImpl };
}

function forwardOptions(overrides = {}) {
  return {
    url: 'http://openhands.ai.svc/events',
    secret: 'openhands-secret',
    dryRun: false,
    log: () => {},
    ...overrides,
  };
}

test('detects checked Renovate trigger checkboxes', () => {
  assert.equal(hasRenovateTriggerCheckbox('- [x] run renovate'), true);
  assert.equal(hasRenovateTriggerCheckbox('- [X] trigger renovate'), true);
  assert.equal(hasRenovateTriggerCheckbox('* [x] rerun renovate now'), true);
  assert.equal(hasRenovateTriggerCheckbox('- [ ] run renovate'), false);
  assert.equal(hasRenovateTriggerCheckbox('run renovate'), false);
});

test('detects checked Renovate Dependency Dashboard marker checkboxes', () => {
  assert.equal(hasRenovateTriggerCheckbox('- [x] <!-- rebase-all-open-prs -->Click to rebase'), true);
  assert.equal(hasRenovateTriggerCheckbox('- [x] <!-- approve-branch=renovate/foo-1.x -->Update foo'), true);
  assert.equal(hasRenovateTriggerCheckbox('- [x] <!-- manual job -->Trigger Renovate run'), true);
  assert.equal(hasRenovateTriggerCheckbox('- [ ] <!-- rebase-all-open-prs -->Click to rebase'), false);
});

test('triggers when one dashboard checkbox is newly checked among others', () => {
  const previous = [
    '- [x] <!-- rebase-branch=renovate/a-1.x -->Update a',
    '- [ ] <!-- rebase-branch=renovate/b-2.x -->Update b',
  ].join('\n');
  const current = [
    '- [x] <!-- rebase-branch=renovate/a-1.x -->Update a',
    '- [x] <!-- rebase-branch=renovate/b-2.x -->Update b',
  ].join('\n');

  const trigger = resolveTrigger('issues', {
    action: 'edited',
    repository: { full_name: 'lkshrk/h-cloud' },
    issue: { body: current },
    changes: { body: { from: previous } },
  });

  assert.equal(trigger.shouldTrigger, true);
});

test('resolves managed issue edit trigger', () => {
  const trigger = resolveTrigger('issues', {
    action: 'edited',
    repository: { full_name: 'lkshrk/h-cloud' },
    issue: { body: '- [x] run renovate' },
  });

  assert.deepEqual(trigger, {
    shouldTrigger: true,
    repository: 'lkshrk/h-cloud',
    reason: 'issues.edited',
  });
});

test('triggers for any repository the App delivers (no allowlist)', () => {
  const trigger = resolveTrigger('issues', {
    action: 'edited',
    repository: { full_name: 'someone/else' },
    issue: { body: '- [x] run renovate' },
  });

  assert.equal(trigger.shouldTrigger, true);
  assert.equal(trigger.repository, 'someone/else');
});

test('ignores unchecked trigger text', () => {
  const trigger = resolveTrigger('pull_request', {
    action: 'edited',
    repository: { full_name: 'lkshrk/h-cloud' },
    pull_request: { body: '- [ ] run renovate' },
  });

  assert.deepEqual(trigger, {
    shouldTrigger: false,
    reason: 'no newly checked Renovate trigger checkbox',
  });
});

test('requires newly checked checkbox for edited bodies when previous body exists', () => {
  const trigger = resolveTrigger('issues', {
    action: 'edited',
    repository: { full_name: 'lkshrk/h-cloud' },
    issue: { body: '- [x] run renovate' },
    changes: { body: { from: '- [x] run renovate\n\nold text' } },
  });

  assert.deepEqual(trigger, {
    shouldTrigger: false,
    reason: 'no newly checked Renovate trigger checkbox',
  });
});

test('triggers when checkbox changes from unchecked to checked', () => {
  const trigger = resolveTrigger('issues', {
    action: 'edited',
    repository: { full_name: 'lkshrk/h-cloud' },
    issue: { body: '- [x] run renovate' },
    changes: { body: { from: '- [ ] run renovate' } },
  });

  assert.deepEqual(trigger, {
    shouldTrigger: true,
    repository: 'lkshrk/h-cloud',
    reason: 'issues.edited',
  });
});

test('verifies GitHub webhook signatures', () => {
  const secret = 'test-secret';
  const body = Buffer.from('{"ok":true}');
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

  assert.equal(verifyGitHubSignature(secret, body, signature), true);
  assert.equal(verifyGitHubSignature(secret, body, 'sha256=bad'), false);
});

test('builds structured bridge log entries without secrets or raw bodies', () => {
  assert.deepEqual(
    buildBridgeLogEntry('triggered', {
      delivery: 'delivery-1',
      event: 'issues',
      action: 'edited',
      repository: 'lkshrk/h-cloud',
      reason: 'issues.edited',
      token: 'secret-token',
      rawBody: '- [x] run renovate',
    }),
    {
      component: 'renovate-trigger-bridge',
      outcome: 'triggered',
      delivery: 'delivery-1',
      event: 'issues',
      action: 'edited',
      repository: 'lkshrk/h-cloud',
      reason: 'issues.edited',
    },
  );
});

test('deduplicates GitHub delivery ids until the retention window expires', () => {
  let now = 1000;
  const deduper = createDeliveryDeduper({ ttlMs: 5000, now: () => now });

  assert.equal(deduper.check('delivery-1'), false);
  assert.equal(deduper.check('delivery-1'), true);
  assert.equal(deduper.check('delivery-2'), false);

  now = 7001;

  assert.equal(deduper.check('delivery-1'), false);
});

test('triggerDispatch throws when token is missing', async () => {
  await assert.rejects(
    () => triggerDispatch('lkshrk/h-cloud', { token: undefined }),
    /GITHUB_DISPATCH_TOKEN is required/,
  );
});

test('triggerDispatch sends correct payload and returns status on 204', async () => {
  const calls = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 204 };
  };

  try {
    const result = await triggerDispatch('lkshrk/h-cloud', {
      token: 'test-token',
      dispatchRepo: 'lkshrk/gh-ops',
      eventType: 'renovate',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.github.com/repos/lkshrk/gh-ops/dispatches');
    assert.equal(calls[0].init.method, 'POST');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.event_type, 'renovate');
    assert.equal(body.client_payload.repositories, 'lkshrk/h-cloud');
    assert.deepEqual(result, { status: 204 });
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('triggerDispatch throws on non-ok response', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => 'Forbidden' });

  try {
    await assert.rejects(
      () => triggerDispatch('lkshrk/h-cloud', { token: 'test-token' }),
      /dispatch failed: 403/,
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('forwards the delivery to OpenHands wrapped in a payload envelope with an HMAC signature', async () => {
  const { calls, fetchImpl } = recordingFetch();

  const result = await forwardToOpenHands({
    event: 'pull_request',
    delivery: 'delivery-42',
    action: 'opened',
    rawBody: openhandsBody,
    options: forwardOptions({ fetch: fetchImpl }),
  });

  assert.deepEqual(result, { forwarded: true, status: 202 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://openhands.ai.svc/events');
  assert.equal(calls[0].init.method, 'POST');
  const envelope = JSON.stringify({ payload: JSON.parse(openhandsBody) });
  assert.equal(calls[0].init.body, envelope);

  const headers = calls[0].init.headers;
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers['X-GitHub-Event'], 'pull_request');
  assert.equal(headers['X-GitHub-Delivery'], 'delivery-42');
  assert.equal(
    headers['X-Hub-Signature-256'],
    `sha256=${crypto.createHmac('sha256', 'openhands-secret').update(envelope).digest('hex')}`,
  );
  assert.ok(calls[0].init.signal);
});

test('forwards only the configured events', async () => {
  const issues = recordingFetch();
  const ignored = await forwardToOpenHands({
    event: 'issues',
    delivery: 'delivery-1',
    action: 'edited',
    rawBody: openhandsBody,
    options: forwardOptions({ fetch: issues.fetchImpl }),
  });

  assert.deepEqual(ignored, { forwarded: false, reason: 'event issues not forwarded' });
  assert.equal(issues.calls.length, 0);

  const comment = recordingFetch();
  await forwardToOpenHands({
    event: 'issue_comment',
    delivery: 'delivery-2',
    action: 'created',
    rawBody: openhandsBody,
    options: forwardOptions({ fetch: comment.fetchImpl }),
  });

  assert.equal(comment.calls.length, 1);

  const custom = recordingFetch();
  await forwardToOpenHands({
    event: 'issues',
    delivery: 'delivery-3',
    action: 'edited',
    rawBody: openhandsBody,
    options: forwardOptions({ fetch: custom.fetchImpl, events: 'issues, push' }),
  });

  assert.equal(custom.calls.length, 1);
  assert.equal(custom.calls[0].init.headers['X-GitHub-Event'], 'issues');
});

test('swallows OpenHands forwarding failures and leaves the renovate path intact', async () => {
  const logged = [];
  const result = await forwardToOpenHands({
    event: 'pull_request',
    delivery: 'delivery-9',
    action: 'opened',
    rawBody: openhandsBody,
    options: forwardOptions({
      fetch: async () => {
        throw new Error('connect ECONNREFUSED');
      },
      log: (outcome, details) => logged.push({ outcome, details }),
    }),
  });

  assert.deepEqual(result, { forwarded: false, error: 'connect ECONNREFUSED' });
  assert.equal(logged[0].outcome, 'openhands_forward_failed');
  assert.equal(logged[0].details.delivery, 'delivery-9');

  const trigger = resolveTrigger('issues', {
    action: 'edited',
    repository: { full_name: 'lkshrk/h-cloud' },
    issue: { body: '- [x] run renovate' },
  });

  assert.equal(trigger.shouldTrigger, true);
});

test('skips OpenHands forwarding in dry run and when no url is configured', async () => {
  const dry = recordingFetch();
  const logged = [];
  const dryResult = await forwardToOpenHands({
    event: 'pull_request',
    delivery: 'delivery-10',
    action: 'opened',
    rawBody: openhandsBody,
    options: forwardOptions({
      fetch: dry.fetchImpl,
      dryRun: true,
      log: (outcome, details) => logged.push({ outcome, details }),
    }),
  });

  assert.deepEqual(dryResult, { forwarded: false, reason: 'dry run' });
  assert.equal(dry.calls.length, 0);
  assert.equal(logged[0].outcome, 'openhands_dry_run');

  const disabled = recordingFetch();
  const disabledResult = await forwardToOpenHands({
    event: 'pull_request',
    delivery: 'delivery-11',
    action: 'opened',
    rawBody: openhandsBody,
    options: forwardOptions({ fetch: disabled.fetchImpl, url: '' }),
  });

  assert.deepEqual(disabledResult, { forwarded: false, reason: 'openhands forwarding disabled' });
  assert.equal(disabled.calls.length, 0);
});

test('drops a second pull_request delivery for the same head', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const deduper = createDeliveryDeduper({ ttlMs: 60000 });
  const body = Buffer.from(
    JSON.stringify({
      action: 'synchronize',
      repository: { full_name: 'lkshrk/auto-code-env' },
      pull_request: { number: 112, head: { sha: 'd6ec0df' } },
    }),
  );
  const options = {
    url: 'https://openhands.example/events',
    secret: 'secret',
    events: ['pull_request'],
    dryRun: false,
    log: () => {},
    fetch: fetchImpl,
    deduper,
  };

  const first = await forwardToOpenHands({ event: 'pull_request', delivery: 'a', rawBody: body, options });
  const second = await forwardToOpenHands({ event: 'pull_request', delivery: 'b', rawBody: body, options });

  assert.equal(first.forwarded, true);
  assert.equal(second.forwarded, false);
  assert.equal(second.reason, 'duplicate head');
  assert.equal(calls.length, 1);
});

test('forwards a new head and never deduplicates comment deliveries', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const deduper = createDeliveryDeduper({ ttlMs: 60000 });
  const options = {
    url: 'https://openhands.example/events',
    secret: 'secret',
    events: ['pull_request', 'issue_comment'],
    dryRun: false,
    log: () => {},
    fetch: fetchImpl,
    deduper,
  };
  const pullBody = (sha) =>
    Buffer.from(
      JSON.stringify({
        action: 'synchronize',
        repository: { full_name: 'lkshrk/auto-code-env' },
        pull_request: { number: 112, head: { sha } },
      }),
    );
  const commentBody = Buffer.from(
    JSON.stringify({
      action: 'created',
      repository: { full_name: 'lkshrk/auto-code-env' },
      issue: { number: 112 },
      comment: { body: '@openhands review' },
    }),
  );

  await forwardToOpenHands({ event: 'pull_request', delivery: 'a', rawBody: pullBody('d6ec0df'), options });
  await forwardToOpenHands({ event: 'pull_request', delivery: 'b', rawBody: pullBody('3f7f2a9'), options });
  await forwardToOpenHands({ event: 'issue_comment', delivery: 'c', rawBody: commentBody, options });
  await forwardToOpenHands({ event: 'issue_comment', delivery: 'd', rawBody: commentBody, options });

  assert.equal(calls.length, 4);
});

test('builds a review key only from a pull request payload', () => {
  assert.equal(
    reviewKey('pull_request', {
      repository: { full_name: 'o/r' },
      pull_request: { number: 5, head: { sha: 'abc' } },
    }),
    'pull_request:o/r#5@abc',
  );
  assert.equal(reviewKey('issue_comment', { repository: { full_name: 'o/r' }, issue: { number: 5 } }), null);
  assert.equal(reviewKey('pull_request', { repository: { full_name: 'o/r' } }), null);
});
