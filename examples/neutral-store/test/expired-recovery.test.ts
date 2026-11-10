import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supportsRecovery } from '../host/expired-recovery.ts';
import type { NativeCheckoutRecoveryOrder } from '@openlup/platform/commerce/server';

test('the application content-loss fence refuses only the unsupported bound starter snapshot', () => {
  const order = (context: unknown) => ({ quoteSnapshot: { quote: { context } } }) as NativeCheckoutRecoveryOrder;
  assert.equal(supportsRecovery(order({ offerVersion: 'sized.v1', starterPack: {} })), false);
  assert.equal(supportsRecovery(order({ offerVersion: 'sized.v1' })), true);
  assert.equal(supportsRecovery(order({ starterPack: {} })), true);
});

import { readFrozenCheckoutEmail } from '../host/checkout-recovery.ts';
import type { CaptureValue } from '../host/private-capture.ts';
const orderId = '11111111-1111-4111-8111-111111111111';
const frozen = { kind: 'checkout-recovery', orderRef: orderId, email: 'original@example.test' };
const capture = (value: CaptureValue) => ({ read: async () => value, writeOnce: async () => { throw new Error('frozen_capture_write_forbidden'); } });
test('re-quote email uses the original immutable capture and canonical order identity', async () => {
  assert.equal(await readFrozenCheckoutEmail(orderId.toUpperCase(), capture(frozen)), frozen.email);
});
test('missing or erased original capture refuses a frozen re-quote', async () => {
  assert.equal(await readFrozenCheckoutEmail(orderId, capture(null)), null);
});
test('corrupt, malformed and foreign original captures refuse a frozen re-quote', async () => {
  assert.equal(await readFrozenCheckoutEmail(orderId, { ...capture(null), read: async () => { throw new Error('corrupt'); } }), null);
  for (const value of [{ ...frozen, email: '' }, { ...frozen, kind: 'later-profile' }, { ...frozen, orderRef: 'foreign' }])
    assert.equal(await readFrozenCheckoutEmail(orderId, capture(value)), null);
});
