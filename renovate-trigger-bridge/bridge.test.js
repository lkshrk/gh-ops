const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasRenovateTriggerCheckbox,
  resolveTrigger,
  verifyGitHubSignature,
  buildBridgeLogEntry,
} = require('./bridge');

test('detects checked Renovate trigger checkboxes', () => {
  assert.equal(hasRenovateTriggerCheckbox('- [x] run renovate'), true);
  assert.equal(hasRenovateTriggerCheckbox('- [X] trigger renovate'), true);
  assert.equal(hasRenovateTriggerCheckbox('* [x] rerun renovate now'), true);
  assert.equal(hasRenovateTriggerCheckbox('- [ ] run renovate'), false);
  assert.equal(hasRenovateTriggerCheckbox('run renovate'), false);
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

test('ignores unmanaged repositories', () => {
  const trigger = resolveTrigger('issues', {
    action: 'edited',
    repository: { full_name: 'someone/else' },
    issue: { body: '- [x] run renovate' },
  });

  assert.equal(trigger.shouldTrigger, false);
  assert.match(trigger.reason, /not managed/);
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
      pipeline: { number: 15, status: 'pending' },
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
      pipelineNumber: 15,
      pipelineStatus: 'pending',
    },
  );
});
