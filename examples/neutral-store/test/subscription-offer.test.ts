import { MAX_CADENCE_DAYS } from '@openlup/core/subscription';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitsLine, admitsTerms, assertSubscriptionOffer, choices, quantityChoices, set, range,
  type SubscriptionOffer } from '../shared/subscription-offer.ts';

const skus = ['SAMPLE-A', 'SAMPLE-B', 'SAMPLE-A-L', 'EXTRA'];
const rules = (days: SubscriptionOffer['days']) => Object.fromEntries(skus.map(sku => [sku, [{ days,quantities: range(1,99,1) }]]));
const offer = (sized = false): SubscriptionOffer => ({ days: sized ? set(14,21,28) : range(1,90,1),
  checkoutDays: set(14,21,28),preferredDays: set(14,21,28),defaultDays: 14,
  minimumBaseUnits: sized ? 6 : 14,maximumUnits: 1782,maximumBaseLines: 6,maximumAddonLines: 12,
  bySku: rules(sized ? set(14,21,28) : range(1,90,1)) });

// Neutral expression of the owner's donor matrix. Source pointers and limits live in the task record.
// Stock, exclusion, size-group and frozen-price guards remain owned by the public editor ports.
test('donor classic exhaustively expresses 1..90, separate checkout choices and unchanged quantities', () => {
  const classic = offer(); assertSubscriptionOffer(classic,skus);
  assert.deepEqual(choices(classic.checkoutDays!),[14,21,28]);
  for (let days = 0; days <= 91; days++) for (const sku of skus) for (const qty of [0,1,99,100]) {
    assert.equal(admitsLine(classic,sku,days,qty),days >= 1 && days <= 90 && qty >= 1 && qty <= 99,`${sku}/${days}/${qty}`);
  }
  assert.equal(admitsTerms(classic,21,[{ sku: skus[0]!,qty: 9 },{ sku: skus[1]!,qty: 8 }]),true);
  assert.equal(admitsTerms(classic,30,[{ sku: skus[0]!,qty: 15 },{ sku: skus[1]!,qty: 15 }]),true);
  assert.equal(admitsTerms(classic,28,[{ sku: skus[0]!,qty: 13 }]),false);
  assert.equal(admitsTerms(classic,28,[{ sku: skus[0]!,qty: 14 }]),true);
});
test('donor sized admits exact quantities and all eligible sizes independently of defaults or box multiples', () => {
  const sized = offer(true); assertSubscriptionOffer(sized,skus);
  for (const days of [14,21,28,35]) for (const sku of skus) for (const qty of [0,1,99,100]) {
    assert.equal(admitsLine(sized,sku,days,qty),days !== 35 && qty >= 1 && qty <= 99);
  }
  for (const days of [14,21,28]) for (const qty of [6,15,30,45,99]) {
    assert.equal(admitsTerms(sized,days,[{ sku: skus[2]!,qty }]),true);
  }
  assert.equal(admitsTerms(sized,21,[{ sku: skus[0]!,qty: 2 },{ sku: skus[1]!,qty: 4 }]),true);
  assert.equal(admitsTerms(sized,21,[{ sku: skus[0]!,qty: 1 },{ sku: skus[1]!,qty: 4 }]),false);
});
test('set/range rules intersect global admission, refuse missing variants and never infer admission from default', () => {
  const configured = offer(); configured.days = set(28,56); configured.checkoutDays = set(28); configured.preferredDays = set(28,56); configured.defaultDays = 28;
  configured.bySku = { 'SAMPLE-A': [{ days: set(28),quantities: set(1,2) },{ days: set(56),quantities: set(2,4) }],
    'SAMPLE-B': [{ days: set(28,56),quantities: range(2,8,3) }] };
  assertSubscriptionOffer(configured,skus);
  assert.deepEqual(quantityChoices(configured,'SAMPLE-A',56),[2,4]);
  assert.deepEqual(quantityChoices(configured,'SAMPLE-B',28),[2,5,8]);
  for (const [sku,days,qty] of [['SAMPLE-A',14,1],['SAMPLE-A',28,4],['SAMPLE-A-L',28,1],['toString',28,1],['SAMPLE-B',28,3]] as const) {
    assert.equal(admitsLine(configured,sku,days,qty),false);
  }
  assert.equal(admitsTerms(configured,28,[{ sku: 'SAMPLE-A',qty: 2 }],[{ sku: 'EXTRA',qty: 12 }]),false);
});
test('invalid defaults, overlapping cadence rules and malformed or unsupported database domains refuse configuration', () => {
  const invalid = (change: (value: SubscriptionOffer) => void,code = 'starter_subscription_offer_invalid') => {
    const value = offer(); change(value); assert.throws(() => assertSubscriptionOffer(value,skus),new RegExp(code));
  };
  invalid(value => { value.defaultDays = 91; });
  invalid(value => { value.checkoutDays = set(91); });
  invalid(value => { value.days = range(1,90,0); });
  invalid(value => { value.days = set(14,14); });
  invalid(value => { value.bySku = { 'SAMPLE-A': [{ days: set(28),quantities: set(1) },{ days: set(28),quantities: set(2) }] }; });
  invalid(value => { value.bySku = { UNKNOWN: [{ days: set(28),quantities: set(1) }] }; });
  invalid(value => { value.days = range(1,MAX_CADENCE_DAYS+1,1); });
  invalid(value => { value.days = set(0); });
});

for (const days of [1,90,91,MAX_CADENCE_DAYS]) test(`configured subscription offer admits ${days} days`, () => {
  const configured = offer();
  configured.days = configured.checkoutDays = configured.preferredDays = set(days);
  configured.defaultDays = days; configured.bySku = rules(set(days));
  assertSubscriptionOffer(configured,skus);
  assert.equal(admitsLine(configured,skus[0]!,days,1),true);
});
