import { demoSubscriptionCare } from '../owned/renewal.config.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurations } from '../owned/store.config.ts';
import { assertRenewalConfig, assertSubscriptionCare, careAvailability, saveOfferKind, saveRescheduleTarget, type PortalSubscription } from '../shared/renewal-config.ts';

for (const config of Object.values(configurations)) {
  test(`${config.id}: renewal values are shared and explicit opt-in`, () => {
    assertRenewalConfig(config.renewal);
    assert.equal(config.renewal.enabled, false);
    const changed = structuredClone(config.renewal);
    changed.enabled = true; changed.batchLimit = 3; changed.cadenceSeconds = 120;
    changed.leaseSeconds = 240; changed.recovery.activeGraceSeconds = 600;
    assertRenewalConfig(changed);
  });
  test(`${config.id}: unsafe renewal values refuse rather than coerce`, () => {
    for (const value of [0, 1, 59, 3601, -1, Infinity, 1.5, 2147483648]) {
      const changed = structuredClone(config.renewal);
      changed.leaseSeconds = value;
      assert.throws(() => assertRenewalConfig(changed), /starter_renewal_configuration_invalid/);
    }
  });
}

const now = Date.parse('2026-01-01T12:00:00.000Z');
const row: PortalSubscription = { subscriptionId: 'owned', status: 'active', nextCycleAt: '2026-01-29T12:00:00.000Z',
  editCutoffAt: '2026-01-26T12:00:00.000Z', blocker: null, action: null, payment: { healthState: 'healthy' }, pause: null, winback: null };

test('open recovery preserves pause and cancel while refusing cycle edits and charges', () => {
  const blocked = { ...row, blocker: 'payment_blocked', action: { blockedReason: 'payment_blocked' } };
  for (const action of ['pause', 'cancel'] as const) assert.equal(careAvailability(blocked, action, now), null);
  for (const action of ['skip', 'slide', 'order_now', 'resume'] as const) assert.notEqual(careAvailability(blocked, action, now), null);
});
test('edit-window and method refusals do not hide lifecycle pause', () => {
  for (const changed of [{ ...row, editCutoffAt: '2026-01-01T12:00:00.000Z' }, { ...row, payment: { healthState: 'method_missing' } }, { ...row, blocker: 'cycle_locked' }]) {
    assert.equal(careAvailability(changed, 'pause', now), null);
    assert.notEqual(careAvailability(changed, 'slide', now), null);
    assert.notEqual(careAvailability(changed, 'order_now', now), null);
  }
});
test('resume and reactivation belong to their recorded lifecycle state', () => {
  assert.equal(careAvailability({ ...row, status: 'paused' }, 'resume', now), null);
  assert.equal(careAvailability({ ...row, status: 'cancelled' }, 'reactivate', now), null);
  assert.equal(careAvailability(row, 'reactivate', now), 'not_active');
  assert.equal(careAvailability({ ...row, status: 'paused' }, 'order_now', now), 'not_active');
});
test('reason-driven save offers retain the reference branches', () => {
  assert.equal(saveOfferKind('too_much_product'), 'skip'); assert.equal(saveOfferKind('delivery_issue'), 'reschedule');
  for (const reason of ['too_expensive', 'not_a_good_fit', 'other', 'appended_reason']) assert.equal(saveOfferKind(reason), 'pause');
});
test('reschedule offer postpones the current renewal and clamps to configured bounds', () => {
  const config = demoSubscriptionCare();
  assert.equal(saveRescheduleTarget(row.nextCycleAt, config, new Date(now)), new Date(2026, 1, 12, 12).toISOString());
  assert.equal(saveRescheduleTarget('2026-05-01T12:00:00.000Z', config, new Date(now)), new Date(2026, 2, 2, 12).toISOString());
  config.terms.slideMinDays = 5; config.terms.slideMaxDays = 12; config.rescheduleOfferDays = 2;
  assert.equal(saveRescheduleTarget(null, config, new Date(now)), new Date(2026, 0, 8, 12).toISOString());
});
test('invalid trusted care policy refuses before a scheduled claim', () => {
  assertSubscriptionCare(demoSubscriptionCare());
  for (const value of [0, -1, Infinity, 1.5]) {
    const config = demoSubscriptionCare(); config.terms.pauseDays = value;
    assert.throws(() => assertSubscriptionCare(config), /starter_subscription_care_configuration_invalid/);
  }
  const config = demoSubscriptionCare(); config.terms.slideMinDays = config.terms.slideMaxDays + 1;
  assert.throws(() => assertSubscriptionCare(config), /starter_subscription_care_configuration_invalid/);
});
