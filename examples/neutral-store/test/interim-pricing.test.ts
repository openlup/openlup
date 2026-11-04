import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurations } from '../owned/store.config.ts';
import { assertConfig } from '../shared/config.ts';
import { evaluateOffer } from '../shared/offer.ts';
import { buildDemoSeed } from '../owned/demo-seed.ts';

// Characterization of the reference adopter's per-unit floor-to-quantum behavior.
test('1499 at five percent with quantum ten resolves to 1420 before quantity', () => {
  const config = structuredClone(Object.values(configurations)[0]!);
  config.offer.products[0]!.unitPrice.amountMinor = 1499;
  config.offer.subscriptionDiscountBps = 500;
  config.offer.subscriptionRoundingQuantumMinor = 10;
  const quote = evaluateOffer(config, { schemaVersion: 1, configuration: config.id, mode: 'subscription',
    cadenceDays: config.offer.defaultCadenceDays, lines: [{ sku: config.offer.products[0]!.sku, quantity: 3 }] });
  assert.ok(quote.ok);
  assert.equal(quote.quote.lines[0]!.unitMinor, 1420);
  assert.equal(quote.quote.subtotalMinor, 4260);
  assert.equal(quote.quote.discountMinor, 0);
  assert.equal(quote.quote.modeDiscountMinor, 237);
});

for (const original of Object.values(configurations)) test(`${original.id}: owned price values, quantum and shipping change without managed edits`, () => {
  const config = structuredClone(original);
  config.offer.products[0]!.unitPrice.amountMinor = 1499;
  config.offer.subscriptionDiscountBps = 700;
  config.offer.subscriptionRoundingQuantumMinor = 25;
  config.offer.shippingMinor = 900; config.offer.freeShippingFromMinor = 9000;
  config.purchase.inputLimits = { text: 80, postalCode: 20, email: 180, name: 40, phone: 24 };
  config.purchase.reservationMinutes = 15;
  config.purchase.stock.quantities[config.offer.products[0]!.sku] = 27;
  config.purchase.stock.providerRef = 'changed-stock-source'; config.purchase.stock.syncRunId = 'changed-stock-revision';
  config.purchase.stock.collectedAt = '2020-01-01T00:00:00Z'; config.purchase.stock.staleAfter = '2990-01-01T00:00:00Z';
  config.purchase.tax = { vatRateBps: 1000, category: 'demo_reduced', legalBasis: 'Fictional changed demonstration' };
  config.purchase.sandbox = { dunningTemplateSlug: 'demo-refusal', recoveryTemplateSlug: 'demo-recovery', recoveryUrlPath: '/demo-repair' };
  assertConfig(config);
  const cart = { schemaVersion: 1, configuration: config.id, mode: 'subscription', cadenceDays: config.offer.defaultCadenceDays,
    lines: [{ sku: config.offer.products[0]!.sku, quantity: 2 }] };
  const result = evaluateOffer(config, cart);
  assert.ok(result.ok); assert.equal(result.quote.lines[0]!.unitMinor, 1375);
  assert.equal(result.quote.shippingMinor, 900); assert.equal(result.quote.totalMinor, 3650);
  const one = evaluateOffer(config, { ...cart, mode: 'one_time', cadenceDays: null });
  assert.ok(one.ok); assert.equal(one.quote.lines[0]!.unitMinor, 1499);
  const seed = buildDemoSeed(config);
  const sku = seed.skus[0]!;
  assert.equal(seed.prices.find(row => row.variant_id === sku.id && row.mode === 'subscription')!.unit_price_minor, 1375);
  assert.equal(seed.prices.find(row => row.variant_id === sku.id && row.mode === 'one_time')!.unit_price_minor, 1499);
});

for (const value of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) test(`invalid configured rounding quantum refuses: ${value}`, () => {
  const config = structuredClone(Object.values(configurations)[0]!);
  config.offer.subscriptionRoundingQuantumMinor = value;
  assert.throws(() => assertConfig(config), /starter_offer_invalid/);
});

test('invalid stock bounds, quantities, input limits and hold lifetime refuse', () => {
  for (const mutate of [
    (config: typeof configurations[string]) => { config.purchase.stock.staleAfter = config.purchase.stock.collectedAt; },
    (config: typeof configurations[string]) => { config.purchase.stock.quantities[config.offer.products[0]!.sku] = -1; },
    (config: typeof configurations[string]) => { config.purchase.inputLimits.text = 0; },
    (config: typeof configurations[string]) => { config.purchase.reservationMinutes = 0; },
    (config: typeof configurations[string]) => { config.purchase.tax.vatRateBps = -1; },
    (config: typeof configurations[string]) => { config.purchase.sandbox.recoveryUrlPath = 'https://example.test'; },
  ]) {
    const config = structuredClone(Object.values(configurations)[0]!); mutate(config);
    assert.throws(() => assertConfig(config), /starter_purchase_configuration_invalid/);
  }
});


test('nonzero renewal shipping refuses while the native contract requires zero', () => {
  const config = structuredClone(Object.values(configurations)[0]!);
  config.offer.renewalShippingMinor = 300;
  assert.throws(() => assertConfig(config), /starter_renewal_shipping_unsupported/);
});
