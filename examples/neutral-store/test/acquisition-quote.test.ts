import { isOfferQuoteView } from '../client/live-quote.ts';
import { dispatchAction, pendingBindings } from '../host/bindings.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { ACQUISITION_TERMS_CAPABILITY, selectAcquisitionTerms, AcquisitionTermsError } from '@openlup/platform/pricing';
import { createPromotionQuoteAcceptance } from '@openlup/platform/promotions';
import type { PromotionRow } from '@openlup/core/promo';
import { configurations } from '../owned/store.config.ts';
import { createAcquisitionFinancialPolicy } from '../owned/acquisition-policy.ts';
import { composePurchaseCapabilities } from '../host/purchase-composition.ts';
import { createNativeQuoteService } from '../host/quote-composition.ts';
import { pendingAcquisitionRenewal, type AcquisitionPredecessors } from '../host/acquisition-predecessors.ts';
import { validateCart } from '../shared/offer.ts';

const config = Object.values(configurations)[0]!;
const cart = { schemaVersion: 1, configuration: config.id, mode: 'subscription', cadenceDays: config.offer.defaultCadenceDays,
  lines: [{ sku: config.offer.products[0]!.sku, quantity: 1 }] };
const context = { config, actor: { customerRef: null, operatorRef: null }, commandKey: 'fictional-command-0001' };
const payload = { cart, configuration: config.id, country: config.market.country, locale: 'en',
  termsAccepted: true, termsRevision: config.legal.revision, email: 'buyer@example.test', firstName: 'Example',
  lastName: 'Buyer', phone: '00000', line1: '1 Example Lane', postalCode: '00000', city: 'Example' };
const unavailable: AcquisitionPredecessors = {
  eligibility() { throw new Error('eligibility must not run'); }, checkout() { throw new Error('draft must not run'); },
};

for (const capability of [undefined, 'wrong-protocol']) {
  test(`unsupported acquisition caller refuses quote and checkout before effects: ${capability}`, async () => {
    let effects = 0;
    const db = { query: async () => { effects++; throw new Error('no database work expected'); } } as unknown as Pool;
    const quotes = createNativeQuoteService(db, unavailable);
    const input = { ...payload, ...(capability ? { acquisitionCapability: capability } : {}) };
    await assert.rejects(quotes.quote(input,context), (error: unknown) => error instanceof AcquisitionTermsError
      && error.reason === 'acquisition_terms_capability_required');
    const contacts = { ensureContactClient: async () => { effects++; throw new Error('contact must not run'); } };
    const actions = composePurchaseCapabilities(db, contacts as never, undefined, {} as never, { predecessors: unavailable });
    assert.deepEqual(await actions['checkout.create']!(input,context), { ok: false, code: 'acquisition_terms_capability_required' });
    assert.equal(effects,0);
    assert.deepEqual(await dispatchAction(pendingBindings(),'offer.validate',input,context), { ok: false,code: 'acquisition_terms_capability_required' });
    assert.deepEqual(await dispatchAction(pendingBindings(),'checkout.create',input,context), { ok: false,code: 'acquisition_terms_capability_required' });
  });
}

test('cart validation is separate from prices and rejects unknown products without a quote', () => {
  const selected = validateCart(config,cart);
  assert.ok(selected.ok); assert.equal(Object.hasOwn(selected,'quote'),false);
  assert.equal(validateCart(config,{ ...cart,lines: [{ sku: 'UNKNOWN',quantity: 1 }] }).ok,false);
});

test('pending retained-terms integration refuses explicitly rather than reusing paid first-order units', async () => {
  assert.throws(() => pendingAcquisitionRenewal.assertAvailable(),/starter_acquisition_renewal_binding_required/);
  await assert.rejects(pendingAcquisitionRenewal.activate({} as never),/starter_acquisition_renewal_binding_required/);
});

function row(): PromotionRow {
  return { id: 'fictional-acquisition', status: 'active', name: 'First subscription offer', code: null,
    trigger_type: 'automatic', discount_type: 'percentage', discount_value: 24, applies_to_kind: 'order_total',
    applies_to_payload: { cart_mode: 'subscription',acquisitionTerms: { schemaVersion: ACQUISITION_TERMS_CAPABILITY,
      revision: 'fictional-v1', delivery2DiscountBps: 1200 } }, stacking_rule: 'exclusive',eligibility: { first_subscription_purchase: true },
    region_availability: ['ZZ'],valid_from: '2000-01-01T00:00:00.000Z',valid_to: null,
    redemption_limit_global: null,redemption_limit_per_customer: 1,
    ...{ promotion_engine_version: 'promotion-engine.v2',benefit_lane: 'product',benefit_kind: 'target_percentage',
      benefit_value_bps: 2400,benefit_value_minor: null,v2_mirror_of: null } };
}

test('configured standalone policy refuses damaged metadata, overlaps and ineffective history', () => {
  const policy = createAcquisitionFinancialPolicy(); const offer = row(); const at = '2026-01-01T00:00:00.000Z';
  const selected = selectAcquisitionTerms([offer],at,'ZZ',policy)!;
  assert.equal(selected.kind,'v2_standalone'); assert.equal(selected.terms.delivery2DiscountBps,1200);
  const corrupt = structuredClone(offer); corrupt.applies_to_payload.acquisitionTerms = {};
  assert.throws(() => selectAcquisitionTerms([corrupt],at,'ZZ',policy),/acquisition_terms_invalid/);
  assert.throws(() => selectAcquisitionTerms([offer,{ ...offer,id: 'other' }],at,'ZZ',policy),/acquisition_terms_ambiguous/);
  assert.throws(() => selectAcquisitionTerms([{ ...offer,valid_from: '2999-01-01T00:00:00.000Z' }],at,'ZZ',policy),/acquisition_terms_not_effective/);
});

test('acceptance binds request, current money, policy, second promise and delivery terms at equal totals', () => {
  const helper = createPromotionQuoteAcceptance<{ promoCodes: string[]; cart: unknown; pricingPolicy: string }>({ projectRequest: value => value });
  const terms = selectAcquisitionTerms([row()],'2026-01-01T00:00:00.000Z','ZZ',createAcquisitionFinancialPolicy())!.terms;
  const money = { amountMinor: 760,currency: 'XTS' };
  const quote = { currency: 'XTS',taxIncluded: true as const,lines: [],discounts: [],subtotalGross: money,
    discountTotalGross: { ...money,amountMinor: 0 },totalGross: money,netTotal: money,taxTotal: { ...money,amountMinor: 0 },
    context: { mode: 'subscription' as const,promoCodes: [],pricingPolicy: { offerPolicyVersion: 'commerce.offer-policy.v2',promotionEngineVersion: 'promotion-engine.v2' } } };
  const keyring = { current: 'fixture-only-acceptance-key-00000000000000' };
  const request = { promoCodes: [],cart,pricingPolicy: 'commerce.offer-policy.v2' };
  const shippingTerms = { version: 'shipping-threshold.v1' as const,currency: 'XTS',flatMinor: 0,freeThresholdMinor: 0 };
  const input = { request,quote,acquisitionTerms: terms,shippingTerms,keyring,now: new Date('2026-01-01T00:00:00.000Z') };
  const token = helper.issuePromotionQuoteAcceptance(input)!;
  const accepted = { ...input,token,expectedTotal: money };
  assert.equal(helper.verifyPromotionQuoteAcceptance(accepted),true);
  assert.equal(helper.verifyPromotionQuoteAcceptance({ ...accepted,acquisitionTerms: { ...terms,delivery2DiscountBps: 1300 } }),false);
  assert.equal(helper.verifyPromotionQuoteAcceptance({ ...accepted,shippingTerms: { ...shippingTerms,freeThresholdMinor: 1 } }),false);
  assert.equal(helper.verifyPromotionQuoteAcceptance({ ...accepted,request: { ...request,cart: { ...cart,cadenceDays: 14 } } }),false);
  assert.equal(helper.verifyPromotionQuoteAcceptance({ ...accepted,quote: { ...quote,totalGross: { ...money,amountMinor: 759 } } }),false);
  assert.equal(helper.verifyPromotionQuoteAcceptance({ ...accepted,request: { ...request,pricingPolicy: 'commerce.offer-policy.v1' } }),false);
});


test('damaged quote projections withhold amounts rather than displaying zero or free shipping', () => {
  const view = { lines: [{ sku: 'EXAMPLE',quantity: 1,baseUnitMinor: 1000,unitMinor: 950,lineMinor: 950 }],
    subtotalMinor: 950,discountMinor: 190,modeDiscountMinor: 50,shippingMinor: 0,totalMinor: 760,
    currency: 'XTS',mode: 'subscription',cadenceDays: 28 };
  assert.equal(isOfferQuoteView(view),true);
  for (const damaged of [{ ...view,shippingMinor: undefined },{ ...view,totalMinor: 0 },
    { ...view,lines: [{ ...view.lines[0],unitMinor: undefined }] },{ ...view,subtotalMinor: NaN }]) {
    assert.equal(isOfferQuoteView(damaged),false);
  }
});


test('the zero-shipping interim refuses nonzero native initial charges instead of silently displaying free shipping', async () => {
  const changed = structuredClone(config); changed.offer.shippingMinor = 640;
  const db = { query: async () => { throw new Error('no reads expected'); } } as unknown as Pool;
  const quotes = createNativeQuoteService(db,unavailable);
  await assert.rejects(quotes.quote({ ...payload,acquisitionCapability: ACQUISITION_TERMS_CAPABILITY },{ ...context,config: changed }),/starter_initial_shipping_unsupported/);
});
