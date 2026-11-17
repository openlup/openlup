import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { PromotionRow } from '@openlup/core/promo';
import { createDbBackedCommerceQuotePort, ACQUISITION_TERMS_CAPABILITY,
  type AcquisitionQuoteRequest, type QuoteShippingPromotionInput } from '@openlup/platform/pricing';
import { createQuotePromoDiscounts, createQuotePromotionV2,
  createQuoteAutomaticPromotions, createQuotePromotionCodeAdjustments,
  type QuoteShippingPromotionsDeps, type CommercePromoDataPort } from '@openlup/platform/promotions';
import { configurations } from '../owned/store.config.ts';
import { createAcquisitionFinancialPolicy } from '../owned/acquisition-policy.ts';
import { createQuoteShipping as shipping } from '../owned/quote-shipping.ts';
import { pricingPolicy, projectQuote } from '../host/quote-composition.ts';
import type { StoreConfig } from '../shared/config.ts';

// Synthetic offline facts; real package promotion and money algorithms run below.
const atTime = '2000-01-02T00:00:00.000Z';
function promotions(config: StoreConfig, kind: 'none' | 'product' | 'shipping' | 'acquisition'): PromotionRow[] {
  if (kind === 'none') return [];
  return [{ id: `fixture-${kind}`, name: kind, status: 'active', code: null, trigger_type: 'automatic',
    discount_type: kind === 'shipping' ? 'free_shipping' : 'percentage', discount_value: kind === 'acquisition' ? 24 : 10,
    applies_to_kind: 'order_total', stacking_rule: 'exclusive', eligibility: kind === 'acquisition' ? { first_subscription_purchase: true } : {},
    applies_to_payload: kind === 'acquisition' ? { cart_mode: 'subscription', acquisitionTerms: {
      schemaVersion: ACQUISITION_TERMS_CAPABILITY, revision: 'fixture-v1', delivery2DiscountBps: 1200 } } : {},
    region_availability: [config.market.country], valid_from: config.quote.policy.effectiveFrom, valid_to: null,
    redemption_limit_global: null, redemption_limit_per_customer: kind === 'acquisition' ? 1 : null,
    ...{ promotion_engine_version: 'promotion-engine.v2', benefit_lane: kind === 'shipping' ? 'shipping' : 'product',
      benefit_kind: kind === 'shipping' ? 'free_shipping' : 'target_percentage',
      benefit_value_bps: kind === 'acquisition' ? 2400 : 1000, benefit_value_minor: null, v2_mirror_of: null } }];
}

function dependencies(config: StoreConfig, rows: PromotionRow[], read = () => {}) {
  const promoDataPort: CommercePromoDataPort = {
    listActivePromotions: async () => { read(); return rows; },
    countPaidOrders: async () => { read(); return 0; },
    countPaidOrdersByMode: async () => { read(); return { oneTime: 0, subscription: 0 }; },
    redemptionCounts: async () => { read(); return new Map(); },
    deviceFirstOrderRedeemed: async () => { read(); return false; },
  };
  const acquisition = { financialPolicy: createAcquisitionFinancialPolicy(), capability: (input: AcquisitionQuoteRequest) => input.acquisitionCapability };
  const promotionCustomerSemantic = () => undefined;
  const promo = createQuotePromoDiscounts({ acquisition, promotionCustomerSemantic });
  const v2 = createQuotePromotionV2({ ...promo, acquisition, promotionCustomerSemantic,
    minimumProductPayableMinor: config.quote.acquisition.minimumProductPayableMinor });
  const automatic = createQuoteAutomaticPromotions<AcquisitionQuoteRequest>({ ...promo, ...v2, acquisition, resolveEmailEligibility: () => true });
  const codes = createQuotePromotionCodeAdjustments({ minimumProductPayableMinor: config.quote.acquisition.minimumProductPayableMinor });
  return { ...automatic, ...codes, promoDataPort };
}

function request(mode: 'one_time' | 'subscription'): AcquisitionQuoteRequest {
  return { mode, cadenceDays: mode === 'subscription' ? 28 : null, lines: [{ sku: 'ITEM', quantity: 1 }],
    promoCodes: [], acquisitionCapability: ACQUISITION_TERMS_CAPABILITY };
}

function quote<Request extends AcquisitionQuoteRequest>(config: StoreConfig, deps: QuoteShippingPromotionsDeps<Request>, unitPriceMinor: number,
  hook = shipping(config, deps)) {
  const tax = { included: true as const, country: config.market.country, ...config.purchase.tax };
  return createDbBackedCommerceQuotePort({
    taxProfile: tax, supportedTaxProfiles: [tax], regionCode: config.market.country, currency: config.market.currency,
    now: () => atTime, isStrictD1Quote: false, hasPromotionCodePort: false,
    quoteCatalogReadPort: { listQuoteCatalogItems: async () => [{ skuId: 'sku', skuCode: 'ITEM', variantId: 'variant',
      productSlug: 'item', netWeightG: 100, isAddon: false, sellability: { oneTime: true, subscription: true },
      documentRevision: { id: null, digest: null } }] },
    pricingResolverPort: { resolvePrice: async input => ({ variantId: input.variantId, mode: input.mode,
      currency: config.market.currency, unitPriceMinor, priceEntryId: 'price', priceListId: 'list', amountKind: 'gross',
      resolvedAt: atTime, matchedMinQty: 1 }) },
    lineContext: () => ({}), quoteContext: (input: Request) => () => ({ mode: input.mode, cadenceDays: input.cadenceDays ?? null, promoCodes: input.promoCodes }),
    ...deps, ...hook,
  });
}

test('default shipping quote bytes, threshold, promotions and retained terms are unchanged', async () => {
  for (const config of Object.values(configurations)) {
    const transcript = [];
    for (const mode of ['one_time', 'subscription'] as const) {
      for (const amount of [999, 1000, 1001]) {
        const snapshot = await quote(config, dependencies(config, []), amount).createServerAuthoritativeQuote(request(mode), { pricingPolicy });
        assert.equal(snapshot.quote.totalGross.amountMinor, amount + (amount < 1000 ? 640 : 0));
        assert.deepEqual(snapshot.quote.context.shippingTerms, { version: 'shipping-threshold.v1', currency: config.market.currency,
          flatMinor: config.offer.shippingMinor, freeThresholdMinor: config.offer.freeShippingFromMinor });
        transcript.push(snapshot);
      }
    }
    for (const kind of ['product', 'shipping', 'acquisition'] as const) {
      const snapshot = await quote(config, dependencies(config, promotions(config, kind)), kind === 'shipping' ? 900 : 1100)
        .createServerAuthoritativeQuote(request(kind === 'acquisition' ? 'subscription' : 'one_time'), { pricingPolicy });
      assert.ok(snapshot.quote.discounts.length > 0);
      assert.equal(snapshot.quote.totalGross.amountMinor, kind === 'product' ? 1630 : kind === 'shipping' ? 900 : 1476);
      if (kind === 'acquisition') {
        assert.equal(snapshot.quote.context.acquisitionTerms?.delivery2DiscountBps, 1200);
        assert.equal(projectQuote(snapshot, config.quote.acquisition.minimumProductPayableMinor).secondTotalMinor, 1608);
      }
      transcript.push(snapshot);
    }
    // Hash JSON.stringify bytes, including ordering, omitted fields, all money and terms.
    assert.equal(createHash('sha256').update(JSON.stringify(transcript)).digest('hex'), '0528bd19da3dcb2e0f589904e23330148f3d831e2c96b77966d42406d2a65fd5');
  }
});

interface DestinationRequest extends AcquisitionQuoteRequest { checkout: Record<string, unknown> }
function offlineShipping(config: StoreConfig, deps: QuoteShippingPromotionsDeps<DestinationRequest>, io: { carrier: number }) {
  // An application binds this resolver inside its owned factory. Country admission
  // precedes the offline carrier and all promotion ports, including database reads.
  const resolver = async (input: QuoteShippingPromotionInput<DestinationRequest>) => {
    if (input.request.checkout.country !== config.market.country) throw new Error('fixture_country_unsupported');
    io.carrier++;
    const rateMinor = 720;
    return shipping({ ...config, offer: { ...config.offer, shippingMinor: rateMinor } }, deps)
      .resolveQuoteShippingPromotions(input);
  };
  return shipping(config, deps, resolver);
}

test('owned offline adapter rate reaches both quote totals and retains promotion and shipping terms', async () => {
  const config = Object.values(configurations)[0]!;
  for (const mode of ['one_time', 'subscription'] as const) {
    let reads = 0;
    const io = { carrier: 0 };
    const deps = dependencies(config, promotions(config, 'product'), () => { reads++; });
    const hook = offlineShipping(config, deps, io);
    const port = quote<DestinationRequest>(config, deps, 1100, hook);
    const snapshot = await port.createServerAuthoritativeQuote({ ...request(mode), checkout: { country: config.market.country } }, { pricingPolicy });
    assert.equal(snapshot.quote.shippingGross?.amountMinor, 720);
    assert.equal(snapshot.quote.discountTotalGross.amountMinor, 110);
    assert.equal(snapshot.quote.totalGross.amountMinor, 1710);
    assert.equal(snapshot.quote.context.shippingTerms?.flatMinor, 720);
    assert.equal(snapshot.quote.context.shippingTerms?.freeThresholdMinor, 1000);
    assert.equal(io.carrier, 1);
    assert.ok(reads > 0);
  }
});

test('unsupported country refuses at the owned resolver boundary with zero carrier or data-port I/O', async () => {
  const config = Object.values(configurations)[0]!;
  let reads = 0;
  const io = { carrier: 0 };
  const hook = offlineShipping(config, dependencies(config, [], () => { reads++; }), io);
  for (const mode of ['one_time', 'subscription'] as const) {
    await assert.rejects(hook.resolveQuoteShippingPromotions({ request: { ...request(mode), checkout: { country: 'UNSUPPORTED' } },
      options: { pricingPolicy }, regionCode: config.market.country, currency: config.market.currency,
      referenceProductMinor: 1100, subtotalGrossMinor: 1100, atTime }), /fixture_country_unsupported/);
  }
  assert.equal(reads, 0);
  assert.equal(io.carrier, 0);
});
