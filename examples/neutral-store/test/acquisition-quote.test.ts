import { isOfferQuoteView } from '../client/live-quote.ts';
import { dispatchAction, pendingBindings } from '../host/bindings.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { ACQUISITION_TERMS_CAPABILITY, selectAcquisitionTerms, AcquisitionTermsError, CommerceQuoteError } from '@openlup/platform/pricing';
import { createPromotionQuoteAcceptance } from '@openlup/platform/promotions';
import type { PromotionRow } from '@openlup/core/promo';
import { configurations } from '../owned/store.config.ts';
import { createAcquisitionFinancialPolicy } from '../owned/acquisition-policy.ts';
import { composePurchaseCapabilities } from '../host/purchase-composition.ts';
import { createNativeQuoteService, quoteFailure } from '../host/quote-composition.ts';
import { quoteRefusalCopy, isQuoteRefusalCode } from '../owned/quote-copy.ts';
import { createAcquisitionRenewalBinding, type AcquisitionPredecessors } from '../host/acquisition-predecessors.ts';
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

test('quote failures preserve exact public reasons without exposing arbitrary details', () => {
  for (const reason of ['base_price_not_found', 'subscription_price_policy_not_effective', 'active_price_list_ambiguous']) {
    assert.equal(quoteFailure(new CommerceQuoteError('PRICE_NOT_CONFIGURED', 'private query', { reason, sql: 'private SQL' })), reason);
    assert.ok(isQuoteRefusalCode(reason));
    for (const locale of ['en', 'pl'] as const) assert.ok(quoteRefusalCopy[locale][reason as keyof typeof quoteRefusalCopy.en].length > 20);
  }
  for (const error of [new Error('starter_private_query: secret'), new Error('base_price_private_payload'), new Error('catalog_private_payload'),
    new CommerceQuoteError('PRICE_NOT_CONFIGURED', 'private query', { reason: 'unknown: secret' }),
    new CommerceQuoteError('PRICING_INVARIANT_VIOLATION', 'private query', { reason: 'base_price_not_found' }),
    { code: 'PRICE_NOT_CONFIGURED', details: { reason: 'base_price_not_found' } }]) {
    assert.equal(quoteFailure(error), 'starter_quote_unavailable');
  }
  for (const code of ['host_binding_required', 'purchase_mode_unavailable', 'cadence_unavailable', 'starter_quote_refresh_required',
    'catalog_authority_unavailable', 'starter_acquisition_eligibility_binding_required', 'starter_acquisition_admission_binding_required']) {
    assert.equal(quoteFailure(new Error(code)), code);
  }
  assert.equal(isQuoteRefusalCode('toString'), false);
});

test('mixed-store preview preserves one-time quotes and explains the missing subscription binding', async () => {
  for (const config of Object.values(configurations)) {
    const selected = { ...cart,configuration: config.id,cadenceDays: config.offer.defaultCadenceDays,
      lines: [{ sku: config.offer.products[0]!.sku,quantity: config.offer.minUnits }] };
    const oneTime = await dispatchAction(pendingBindings(), 'offer.validate', { cart: { ...selected,mode: 'one_time',cadenceDays: null } }, { ...context,config });
    assert.ok(oneTime.ok); assert.ok(isOfferQuoteView(oneTime.value));
    assert.equal(oneTime.value.lines[0]!.unitMinor, config.offer.products[0]!.unitPrice.amountMinor);
    assert.deepEqual(await dispatchAction(pendingBindings(), 'offer.validate',
      { cart: selected,acquisitionCapability: ACQUISITION_TERMS_CAPABILITY }, { ...context,config }), { ok: false,code: 'host_binding_required' });
  }
});

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

test('retained-terms binding refuses incomplete accepted quotes before native writes', async () => {
  let writes = 0;
  const binding = createAcquisitionRenewalBinding({ query: async () => { writes++; } } as unknown as Pool);
  assert.throws(() => binding.assertAvailable(),/starter_quote_refresh_required/);
  await assert.rejects(binding.activate({} as never),/starter_quote_refresh_required/);
  assert.equal(writes,0);
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


test('configured native shipping reaches the installed graph rather than an interim refusal', async () => {
  const changed = structuredClone(config); changed.offer.shippingMinor = 640;
  let reads = 0;
  const db = { query: async () => { reads++; throw new Error('synthetic_database_boundary'); } } as unknown as Pool;
  const quotes = createNativeQuoteService(db,unavailable);
  await assert.rejects(quotes.quote({ cart: { ...cart,mode: 'one_time',cadenceDays: null } },{ ...context,config: changed }),/catalog_authority_unavailable/);
  assert.ok(reads > 0);
});

test('forged fresh cadence/SKU/quantity refuse quote and checkout with zero writes', async () => {
  let writes = 0;
  const db = { query: async (sql: string) => {
    if (!sql.trimStart().startsWith('SELECT')) writes++;
    return { rows: [] };
  } } as unknown as Pool;
  const quotes = createNativeQuoteService(db,unavailable);
  const actions = composePurchaseCapabilities(db,{} as never,undefined,{} as never,{ predecessors: unavailable });
  const bindings = { ...pendingBindings(),actions };
  for (const [selected,code] of [
    [{ ...cart,cadenceDays: 35 },'cadence_unavailable'],
    [{ ...cart,lines: [{ sku: 'UNKNOWN',quantity: 1 }] },'unknown_sku'],
    [{ ...cart,lines: [{ sku: cart.lines[0]!.sku,quantity: 13 }] },'quantity_invalid'],
  ] as const) {
    const input = { ...payload,cart: selected,acquisitionCapability: ACQUISITION_TERMS_CAPABILITY };
    await assert.rejects(quotes.quote(input,context),{ message: code });
    const result = await dispatchAction(bindings,'checkout.create',input,context);
    assert.deepEqual(result,{ ok: false,code });
  }
  assert.equal(writes,0);
});

test('authenticated completed checkout replay survives withdrawn offers and still compares structural identity', async () => {
  const { createHash } = await import('node:crypto');
  const { canonicalCatalogDraftJson } = await import('@openlup/platform/catalog');
  const { pricingPolicy } = await import('../host/quote-composition.ts');
  const { starterTermsAdmission } = await import('../host/editor-ports.ts');
  const { demoIdentifier } = await import('../host/editor-catalogue.ts');
  const changed = structuredClone(config);
  changed.subscriptionOffers.classic.bySku = {};
  const actor = { principalRef: '00000000-0000-4000-8000-000000000001',customerRef: '00000000-0000-4000-8000-000000000002',operatorRef: null };
  const input = { ...payload,acquisitionCapability: ACQUISITION_TERMS_CAPABILITY };
  const checkout = Object.fromEntries(['configuration','country','termsRevision','firstName','lastName','phone','line1','line2','city','postalCode']
    .map(key => [key,input[key as keyof typeof input] ?? null]).concat([['email',payload.email],['purchaser',actor.customerRef]]));
  const identity = createHash('sha256').update(canonicalCatalogDraftJson({ mode: cart.mode,cadenceDays: cart.cadenceDays,
    lines: cart.lines,promoCodes: [],pricingPolicy,acquisitionCapability: ACQUISITION_TERMS_CAPABILITY,checkout })).digest('hex');
  const money = { amountMinor: 1000,currency: 'XTS' };
  const snapshot = { quote: { lines: [],subtotalGross: money,totalGross: money,discountTotalGross: { ...money,amountMinor: 0 },currency: 'XTS',
    context: { mode: 'subscription',cadenceDays: 28,starterRequest: identity } } };
  let writes = 0;
  const db = { query: async (sql: string) => {
    if (!sql.trimStart().startsWith('SELECT')) writes++;
    if (sql.includes('SELECT email')) return { rows: [{ email: payload.email }] };
    if (sql.includes('commerce_order_draft_receipts')) return { rows: [{ snapshot,completed: true,id: '00000000-0000-4000-8000-000000000003',status: 'paid',total_amount_minor: 1000,currency_code: 'XTS' }] };
    // isInitialCheckoutOrder's canonical kind fence.
    return { rows: [{ initial_checkout: true }] };
  } } as unknown as Pool;
  const actions = composePurchaseCapabilities(db,{} as never,undefined,{} as never,{ predecessors: unavailable });
  const bindings = { ...pendingBindings(),actions };
  const result = await dispatchAction(bindings,'checkout.create',input,{ ...context,config: changed,actor });
  assert.deepEqual(result,{ ok: true,value: { orderRef: '00000000-0000-4000-8000-000000000003',status: 'paid',total: money },replayed: true });
  const conflict = await dispatchAction(bindings,'checkout.create',{ ...input,cart: { ...cart,cadenceDays: 56 } },{ ...context,config: changed,actor });
  assert.deepEqual(conflict,{ ok: false,code: 'starter_command_conflict' });
  const terms = { subscriptionId: 'fixture',nominalPlanDays: 28,cadenceDays: 28,
    base: [{ sku: cart.lines[0]!.sku,variantId: demoIdentifier(config,'sku',cart.lines[0]!.sku),qty: 6 }],addons: [] };
  await assert.rejects(async () => starterTermsAdmission(db,changed,'classic')(terms),/subscription_reprice_terms_not_admitted/);
  assert.equal(writes,0);
});

test('full-result admission covers exact/frozen unchanged base and add-ons, identity and installed-minimum drift', async () => {
  const { starterTermsAdmission } = await import('../host/editor-ports.ts');
  const { demoIdentifier } = await import('../host/editor-catalogue.ts');
  const { set, range } = await import('../shared/subscription-offer.ts');
  const configured = structuredClone(config);
  for (const plan of Object.values(configured.subscriptionOffers)) {
    plan.days = set(28,56); plan.defaultDays = 28;
    plan.bySku = Object.fromEntries(configured.subscriptionEditing.catalogue.map(product => [product.sku,[{ days: plan.days,quantities: range(1,99,1) }]]));
  }
  const sku = configured.offer.products[0]!.sku, extra = `${sku}-EXTRA`;
  const line = (sku: string,qty: number) => ({ sku,qty,variantId: demoIdentifier(configured,'sku',sku) });
  let minimum = String(configured.subscriptionOffers.classic.minimumBaseUnits),writes = 0;
  const db = { query: async (sql: string) => {
    if (!sql.trimStart().startsWith('SELECT')) writes++;
    return { rows: [{ value_text: minimum }] };
  } } as unknown as Pool;
  const terms = { subscriptionId: 'fixture',nominalPlanDays: 28,cadenceDays: 28,base: [line(sku,6)],addons: [line(extra,2)] };
  for (const mode of ['classic','sized'] as const) {
    const admit = starterTermsAdmission(db,configured,mode);
    await admit(terms);
    configured.subscriptionOffers[mode].bySku = { [sku]: [{ days: set(28,56),quantities: set(6) }],
      [extra]: [{ days: set(28,56),quantities: set(2) }] };
    for (const invalid of [{ ...terms,cadenceDays: 35 },{ ...terms,nominalPlanDays: 35 },
      { ...terms,base: [line(sku,7)] },{ ...terms,addons: [line(extra,3)] },
      { ...terms,base: [{ ...line(sku,6),variantId: demoIdentifier(configured,'sku','OTHER') }] }]) {
      await assert.rejects(async () => admit(invalid),/subscription_reprice_terms_not_admitted/);
    }
    minimum = '5'; await assert.rejects(async () => admit(terms),/subscription_reprice_terms_not_admitted/);
    minimum = String(configured.subscriptionOffers.classic.minimumBaseUnits);
  }
  assert.equal(writes,0);
});
