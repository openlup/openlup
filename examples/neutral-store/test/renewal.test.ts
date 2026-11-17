import { demoSubscriptionCare } from '../owned/renewal.config.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertConfig } from '../shared/config.ts';
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
  const expected = { too_much_product: 'skip', delivery_issue: 'reschedule', too_expensive: 'pause', not_a_good_fit: 'pause', other: 'pause' };
  for (const config of Object.values(configurations)) {
    assertConfig(config);
    assert.deepEqual(config.renewal.subscriptionCare.retentionReasons, Object.keys(expected));
    for (const [reason, kind] of Object.entries(expected)) assert.equal(saveOfferKind(reason, config.renewal.subscriptionCare), kind);
    for (const reason of ['appended_reason', 'toString', '__proto__']) assert.equal(saveOfferKind(reason, config.renewal.subscriptionCare), 'pause');
  }
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

test('owned donor retention data selects skip, reschedule and the fallback without changing reason identity', () => {
  const config = structuredClone(Object.values(configurations)[0]!);
  const retention = { offerByReason: { too_much_food: 'skip', too_much_product: 'skip', delivery_issue: 'reschedule' }, defaultOffer: 'pause' } as const;
  config.renewal.subscriptionCare.retentionReasons = ['too_much_food', ...config.renewal.subscriptionCare.retentionReasons];
  config.renewal.subscriptionCare.retention = retention;
  assertConfig(config);
  for (const [reason, kind] of Object.entries(retention.offerByReason)) assert.equal(saveOfferKind(reason, config.renewal.subscriptionCare), kind);
  assert.equal(saveOfferKind('too_expensive', config.renewal.subscriptionCare), 'pause');
  config.renewal.subscriptionCare.retention = { offerByReason: { other: 'reschedule' }, defaultOffer: 'skip' };
  assertConfig(config);
  assert.equal(saveOfferKind('other', config.renewal.subscriptionCare), 'reschedule');
  assert.equal(saveOfferKind('too_expensive', config.renewal.subscriptionCare), 'skip');
});
test('startup refuses unknown retention reason keys and offer kinds with the named code', () => {
  for (const retention of [
    { offerByReason: { unknown_reason: 'skip' }, defaultOffer: 'pause' },
    { offerByReason: { other: 'discount' }, defaultOffer: 'pause' },
    { offerByReason: {}, defaultOffer: 'discount' },
    { offerByReason: null, defaultOffer: 'pause' },
    null,
  ]) {
    const config = structuredClone(Object.values(configurations)[0]!);
    config.renewal.subscriptionCare.retention = retention as unknown as typeof config.renewal.subscriptionCare.retention;
    assert.throws(() => assertConfig(config), { message: 'starter_retention_configuration_invalid' });
  }
});
test('startup accepts three retry rungs and refuses budgets inconsistent with SQL attempt four', () => {
  for (const ladder of [[24, 48], [24, 48, 72, 96]]) {
    const config = structuredClone(Object.values(configurations)[0]!);
    config.renewal.retryBackoffHours = ladder;
    assert.throws(() => assertConfig(config), { message: 'starter_database_retry_budget' });
  }
  const config = structuredClone(Object.values(configurations)[0]!);
  config.renewal.retryBackoffHours = [24, 72, 168];
  assert.doesNotThrow(() => assertConfig(config));
});
