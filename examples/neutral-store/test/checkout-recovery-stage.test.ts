import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkoutRecoveryIsFinal } from '../host/paid-mail.ts';

test('recovery subject follows the explicit stage and keeps the hour rule for legacy payloads', () => {
  assert.equal(checkoutRecoveryIsFinal({ reminderHours: 1 }), false);
  assert.equal(checkoutRecoveryIsFinal({ reminderHours: 20 }), true);
  assert.equal(checkoutRecoveryIsFinal({ reminderHours: 2, stage: 'first' }), false);
  assert.equal(checkoutRecoveryIsFinal({ reminderHours: 1, stage: 'last' }), true);
  assert.equal(checkoutRecoveryIsFinal({ reminderHours: 20, stage: 'last' }), true);
});
