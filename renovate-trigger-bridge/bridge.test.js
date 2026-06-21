const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasRenovateTriggerCheckbox,
  resolveTrigger,
  verifyGitHubSignature,
  buildBridgeLogEntry,
  createDeliveryDeduper,
  triggerDispatch,
} = require('./bridge');

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
