import { isOfferQuoteView } from '../client/live-quote.ts';
import { dispatchAction, pendingBindings } from '../host/bindings.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { ACQUISITION_TERMS_CAPABILITY, selectAcquisitionTerms, AcquisitionTermsError, CommerceQuoteError, CommerceQuoteCatalogReadError } from '@openlup/platform/pricing';
import { createPromotionQuoteAcceptance } from '@openlup/platform/promotions';
import type { PromotionRow } from '@openlup/core/promo';
import { createHash } from 'node:crypto';
import { canonicalCatalogDraftJson, type NeutralSkuEnvelopeV1 } from '@openlup/platform/catalog';
import { documentDigest, editorDocuments, verifySizedProductDocument, type MixedProductRead } from '../host/editor-catalogue.ts';
import { configurations } from '../owned/store.config.ts';
import { createAcquisitionFinancialPolicy } from '../owned/acquisition-policy.ts';
import { composePurchaseCapabilities } from '../host/purchase-composition.ts';
import { createNativeQuoteService, quoteDocumentVerifier, quoteFailure } from '../host/quote-composition.ts';
import { quoteRefusalCopy, isQuoteRefusalCode } from '../owned/quote-copy.ts';
import { createAcquisitionRenewalBinding, type AcquisitionPredecessors } from '../host/acquisition-predecessors.ts';
import { isRecord, validateCart } from '../shared/offer.ts';
import { assertConfig } from '../shared/config.ts';
import { range } from '../shared/policy.ts';

const config = Object.values(configurations)[0]!;
const cart = { schemaVersion: 1, configuration: config.id, mode: 'subscription', cadenceDays: config.offer.defaultCadenceDays,
  lines: [{ sku: config.offer.products[0]!.sku, quantity: 1 }] };
const context = { config, actor: { customerRef: null, operatorRef: null }, commandKey: 'fictional-command-0001' };
const payload = { cart, configuration: config.id, country: config.market.country, locale: config.market.defaultLocale,
  termsAccepted: true, termsRevision: config.legal.revision, email: 'buyer@example.test', firstName: 'Example',
  lastName: 'Buyer', phone: '00000', line1: '1 Example Lane', postalCode: '00000', city: 'Example' };
const unavailable: AcquisitionPredecessors = {
  eligibility() { throw new Error('eligibility must not run'); }, checkout() { throw new Error('draft must not run'); },
};

test('quote failures preserve exact public reasons without exposing arbitrary details', () => {
  for (const reason of ['base_price_not_found', 'subscription_price_policy_not_effective', 'active_price_list_ambiguous']) {
    assert.equal(quoteFailure(new CommerceQuoteError('PRICE_NOT_CONFIGURED', 'private query', { reason, sql: 'private SQL' })), reason);
    assert.ok(isQuoteRefusalCode(reason));
    for (const locale of config.market.locales) assert.ok(quoteRefusalCopy[locale][reason as keyof typeof quoteRefusalCopy[typeof locale]].length > 20);
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
    const query = async (sql: string) => {
      if (/pg_advisory|commerce_order_draft_receipts|catalog_admission_requires_quote_authority/.test(sql)) return { rows: [] };
      effects++;
      throw new Error('no effect expected');
    };
    const db = { query, async connect() { return { query, release() {} }; } } as unknown as Pool;
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
  const query = async (sql: string) => {
    if (!sql.trimStart().startsWith('SELECT')) writes++;
    return { rows: [] };
  };
  const db = { query, async connect() { return { query, release() {} }; } } as unknown as Pool;
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

test('fresh offer-only membership refuses before capability, terms, cadence, quote or writes', async () => {
  const calls: string[] = [];
  const query = async (sql: string, values?: unknown[]) => {
    calls.push(sql);
    if (sql.includes('catalog_admission_requires_quote_authority')) {
      assert.deepEqual(values, [cart.lines.map(line => line.sku), '{"offerVersion":"classic"}']);
      return { rows: [{ governed: true }] };
    }
    if (sql.includes('pg_advisory') || sql.includes('commerce_order_draft_receipts')) return { rows: [] };
    throw new Error('A fresh quote cannot be read on this path');
  };
  const db = { query, async connect() { return { query, release() {} }; } } as unknown as Pool;
  const contacts = { async ensureContactClient() { throw new Error('Contact must not be provisioned'); } };
  const actions = composePurchaseCapabilities(db,contacts as never,undefined,{} as never,{ predecessors: unavailable });
  for (const acquisitionCapability of [undefined, 'wrong', ACQUISITION_TERMS_CAPABILITY]) {
    const result = await dispatchAction({ ...pendingBindings(),actions }, 'checkout.create', {
      ...payload, cart: { ...cart, cadenceDays: 35 }, termsRevision: 'stale', acquisitionCapability,
    }, context);
    assert.deepEqual(result, { ok: false, code: 'catalog_admission_quote_authority_required',
      message: 'Governed checkout is unavailable for this selection. Use a supported offer or replay the original request.' });
  }
  assert.equal(calls.length,12);
});

for (const narrowing of ['withdrawn offers', 'lowered quantity and line limits']) {
test(`authenticated completed order read and receipt replay survive ${narrowing} and still compare structural identity`, async () => {
  const { createHash } = await import('node:crypto');
  const { canonicalCatalogDraftJson } = await import('@openlup/platform/catalog');
  const { pricingPolicy } = await import('../host/quote-composition.ts');
  const { starterTermsAdmission } = await import('../host/editor-ports.ts');
  const { demoIdentifier } = await import('../host/editor-catalogue.ts');
  const acceptedCart = { ...cart, lines: config.offer.products.slice(0, 2).map(product => ({ sku: product.sku, quantity: 2 })) };
  assert.ok(validateCart(config, acceptedCart).ok);
  const changed = structuredClone(config);
  if (narrowing === 'withdrawn offers') changed.subscriptionOffers.classic.bySku = {};
  else {
    changed.offer.maxUnits = 1;
    const plan = changed.subscriptionOffers.classic;
    Object.assign(plan, { minimumBaseUnits: 1, checkoutMinimumBaseUnits: 1, maximumUnits: 1, maximumBaseLines: 1, maximumAddonLines: 1 });
    plan.bySku = Object.fromEntries(Object.keys(plan.bySku).map(sku => [sku, [{ days: plan.days, quantities: range(1, 1, 1) }]]));
  }
  assertConfig(changed);
  assert.equal(validateCart(changed, acceptedCart).ok, false);
  const actor = { principalRef: '00000000-0000-4000-8000-000000000001',customerRef: '00000000-0000-4000-8000-000000000002',operatorRef: null };
  const input = { ...payload,cart: acceptedCart,acquisitionCapability: ACQUISITION_TERMS_CAPABILITY };
  const checkout = Object.fromEntries(['configuration','country','termsRevision','firstName','lastName','phone','line1','line2','city','postalCode']
    .map(key => [key,input[key as keyof typeof input] ?? null]).concat([['email',payload.email],['purchaser',actor.customerRef]]));
  const identity = createHash('sha256').update(canonicalCatalogDraftJson({ mode: acceptedCart.mode,cadenceDays: acceptedCart.cadenceDays,
    lines: acceptedCart.lines,promoCodes: [],pricingPolicy,acquisitionCapability: ACQUISITION_TERMS_CAPABILITY,checkout })).digest('hex');
  const money = { amountMinor: 1000,currency: 'XTS' };
  const snapshot = { quote: { lines: [],subtotalGross: money,totalGross: money,discountTotalGross: { ...money,amountMinor: 0 },currency: 'XTS',
    context: { mode: 'subscription',cadenceDays: acceptedCart.cadenceDays,starterRequest: identity } } };
  const storedOrder = { snapshot,completed: true,owned: true,submit: null,fingerprint:'a'.repeat(32),id: '00000000-0000-4000-8000-000000000003',client_id: actor.customerRef,
    status: 'paid',total_amount_minor: 1000,currency_code: 'XTS' };
  let writes = 0;
  let receiptAvailable = true;
  const query = async (sql: string) => {
    if (!sql.trimStart().startsWith('SELECT')) writes++;
    if (sql.includes('SELECT email')) return { rows: [{ email: payload.email }] };
    if (sql.includes('commerce_order_draft_receipts')) return { rows: receiptAvailable ? [storedOrder] : [] };
    if (sql.includes('FROM public.commerce_orders WHERE id=$1')) return { rows: [storedOrder] };
    // isInitialCheckoutOrder's canonical kind fence.
    return { rows: [{ initial_checkout: true }] };
  };
  const db = { query, async connect() { return { query, release() {} }; } } as unknown as Pool;
  const actions = composePurchaseCapabilities(db,{} as never,undefined,{} as never,{ predecessors: unavailable });
  const bindings = { ...pendingBindings(),actions };
  const result = await dispatchAction(bindings,'checkout.create',input,{ ...context,config: changed,actor });
  assert.deepEqual(result,{ ok: true,value: { orderRef: '00000000-0000-4000-8000-000000000003',status: 'paid',total: money },replayed: true });
  const read = await dispatchAction(bindings,'checkout.read',{ orderRef: storedOrder.id },{ ...context,config: changed,actor });
  assert.deepEqual(read,{ ok: true,value: result.ok && result.value });
  const conflict = await dispatchAction(bindings,'checkout.create',{ ...input,cart: { ...acceptedCart,cadenceDays: acceptedCart.cadenceDays! + 1 } },{ ...context,config: changed,actor });
  assert.deepEqual(conflict,{ ok: false,code: 'starter_command_conflict' });
  receiptAvailable = false;
  const fresh = await dispatchAction(bindings,'checkout.create',input,{ ...context,config: changed,actor,commandKey: 'fresh-after-narrowing' });
  assert.deepEqual(fresh,{ ok: false,code: narrowing === 'withdrawn offers' ? 'quantity_invalid' : 'cart_invalid' });
  const terms = { subscriptionId: 'fixture',nominalPlanDays: acceptedCart.cadenceDays!,cadenceDays: acceptedCart.cadenceDays!,
    base: acceptedCart.lines.map(line => ({ sku: line.sku,variantId: demoIdentifier(config,'sku',line.sku),qty: line.quantity })),addons: [] };
  await assert.rejects(async () => starterTermsAdmission(db,changed,'classic')(terms),/subscription_reprice_terms_not_admitted/);
  assert.equal(writes,0);
});
}

test('expired stamped checkout replays the saved pending and completed purchase', async () => {
  const { createHash, randomUUID } = await import('node:crypto');
  const { canonicalCatalogDraftJson } = await import('@openlup/platform/catalog');
  const { pricingPolicy } = await import('../host/quote-composition.ts');
  const digest = (value: unknown) => createHash('sha256').update(canonicalCatalogDraftJson(value)).digest('hex');
  const actor = { ...context.actor, principalRef: '00000000-0000-4000-8000-000000000001',
    customerRef: '00000000-0000-4000-8000-000000000002', requesterKey: 'a'.repeat(64) };
  // A version 4 key has a continuation, so a changed payload is named instead of conflicting.
  const keyed = { ...context, actor, commandKey: randomUUID() as string };
  const key = 'checkout:' + createHash('sha256').update(JSON.stringify([actor.principalRef, keyed.commandKey])).digest('hex');
  const checkout = { configuration: payload.configuration, country: payload.country, termsRevision: payload.termsRevision,
    firstName: payload.firstName, lastName: payload.lastName, phone: payload.phone, line1: payload.line1, line2: null,
    city: payload.city, postalCode: payload.postalCode, email: payload.email, purchaser: actor.customerRef };
  const request = { mode: cart.mode, cadenceDays: cart.cadenceDays, lines: cart.lines, promoCodes: [], pricingPolicy,
    acquisitionCapability: ACQUISITION_TERMS_CAPABILITY, checkout };
  const money = { amountMinor: 1000, currency: config.market.currency };
  const tax = { ...config.purchase.tax, included: true as const, country: config.market.country,
    netAmount: money, vatAmount: { ...money, amountMinor: 0 }, grossAmount: money };
  const acquisitionTerms = selectAcquisitionTerms([row()],'2026-01-01T00:00:00.000Z','ZZ',createAcquisitionFinancialPolicy())!.terms;
  const snapshot = { contractVersion: 'commerce.v0' as const, quote: { currency: money.currency, taxIncluded: true as const, discounts: [],
    lines: [{ ...cart.lines[0]!, productSlug: config.offer.products[0]!.slug, unitPriceGross: money, lineSubtotalGross: money, tax }],
    subtotalGross: money, netTotal: money, taxTotal: tax.vatAmount, discountTotalGross: tax.vatAmount, totalGross: money,
    context: { mode: 'subscription' as const, cadenceDays: cart.cadenceDays, promoCodes: [], starterRequest: digest(request), acquisitionTerms } } };
  const issuer = createPromotionQuoteAcceptance<typeof request & { pricePolicyBasis?: null[] }>({ projectRequest: value => value });
  const keyring = { current: 'fixture-only-acceptance-key-00000000000000' };
  const signed = { request, quote: snapshot.quote, acquisitionTerms, keyring };
  const token = issuer.issuePromotionQuoteAcceptance({ ...signed, now: new Date('2026-01-01T00:00:00.000Z') })!;
  assert.equal(issuer.verifyPromotionQuoteAcceptanceWithOutcome({
    ...signed, token, expectedTotal: money, now: new Date('2026-01-05T00:00:00.000Z'),
  }).reason,'expired');
  const original = { ...payload, acquisitionCapability: ACQUISITION_TERMS_CAPABILITY, expectedTotal: money };
  const scope = { schemaVersion: 1, ownerNamespace: 'starter-demo:' + config.id, clientId: actor.customerRef, actorRef: actor.principalRef,
    lane: 'starter-checkout', requestKey: key, acceptanceTokenDigest: digest(token) };
  const submit = { ...scope, submitDigest: digest(['catalog.checkout-submit.v1', scope, original]) };
  const stored = { id: '00000000-0000-4000-8000-000000000003', client_id: actor.customerRef, owned: true,
    status: 'pending_payment', total_amount_minor: money.amountMinor, currency_code: money.currency, completed: false,
    created_at: '2026-01-01T00:00:00.000Z', snapshot, submit, fingerprint: 'b'.repeat(32) };
  const resumable = ['commerce_register_order_destination','fulfillment_record_stock_current','fulfillment_reserve_purchase_order_items',
    'subscription_declare_provisional_activation','commerce_open_settlement_intent'];
  const effects: string[] = [], unexpected: string[] = [], receiptCalls: unknown[][] = [];
  let stockFailure: unknown;
  let receiptMismatch = false;
  let savedQuoteChecks = 0;
  const query = async (sql: string, args: unknown[] = []) => {
    if (sql.includes('SELECT email')) return { rows: [{ email: payload.email }] };
    if (sql.includes('pg_advisory')) return { rows: [] };
    if (sql.includes('commerce_order_draft_receipts')) return { rows: [stored] };
    if (sql.includes('catalog_admission_replay_order_draft')) {
      receiptCalls.push(args);
      if (receiptMismatch || args[3] !== submit.submitDigest) throw Object.assign(new Error('receipt conflict'), { code: '23505' });
      return { rows: [] };
    }
    if (sql.includes('initial_checkout')) return { rows: [{ initial_checkout: true }] };
    if (sql.includes('FROM public.commerce_orders WHERE id=$1')) return { rows: [stored] };
    if (sql.includes('FROM public.commerce_order_items')) return { rows: [{ id: stored.id, sku_id: stored.id, quantity: 1 }] };
    const step = resumable.find(name => sql.includes(name));
    if (!step) { unexpected.push(sql); throw new Error('Live quote or unexpected effect'); }
    effects.push(step);
    if (step === 'fulfillment_record_stock_current' && stockFailure) throw stockFailure;
    return { rows: [{ result: {}, response: {} }] };
  };
  const db = { query, async connect() { return { query, release() {} }; } } as unknown as Pool;
  const predecessors = { ...unavailable, checkout: () => ({ async createOrderDraft() { assert.fail('Draft already exists'); } }) };
  const renewal = { assertAvailable(saved: unknown) { savedQuoteChecks++; assert.equal(saved,snapshot); },
    async activate() { assert.fail('Purchase has not been paid'); } };
  const issued: string[] = [];
  let issueFailure = false;
  const recovery = { tokens: { async issue(input: { rawToken: string }) {
    if (issueFailure) throw new Error('checkout_recovery_storage_failed');
    issued.push(input.rawToken); return '00000000-0000-4000-8000-000000000009';
  },
    async readExpiry() { return '2099-01-02T00:00:00.000Z'; } }, async deliver() { assert.fail('A repeat never sends mail'); } };
  const metered: unknown[][] = [];
  const limiter = async (...input: unknown[]) => { metered.push(input); return { allowed: true }; };
  const actions = composePurchaseCapabilities(db,{} as never,limiter,recovery as never,{ predecessors, renewal, keyring });
  const replay = (input: Record<string, unknown>, at = keyed) => actions['checkout.create']!(input,at);
  const input = { ...original, quoteAcceptance: token };
  for (const changed of [{ termsAccepted: false }, { quoteAcceptance: token + 'a' }, { expectedTotal: { ...money, amountMinor: 1001 } },
    { cart: { ...cart, cadenceDays: cart.cadenceDays! + 1 } }, { termsRevision: 'different-terms' }]) {
    assert.deepEqual(await replay({ ...input, ...changed }),{ ok: false,code: 'starter_checkout_changed' });
  }
  assert.deepEqual(effects,[]);
  assert.equal(savedQuoteChecks,0);
  assert.equal(receiptCalls.length,0);
  assert.equal(metered.length,5);
  assert.ok(metered.every(([, intent]) => (intent as { contact: { email: string } }).contact.email === `replay:${key}`));
  // A key that is not a version 4 UUID has no continuation and keeps the released conflict.
  assert.deepEqual(await replay(input,{ ...keyed, commandKey: 'fictional-command-0001' }),{ ok: false,code: 'starter_command_conflict' });
  assert.equal(receiptCalls.length,1);
  receiptCalls.length = 0;
  // An equal digest still checks receipt integrity.
  receiptMismatch = true;
  assert.deepEqual(await replay(input),{ ok: false,code: 'starter_command_conflict' });
  receiptMismatch = false;
  receiptCalls.length = 0;
  assert.equal(issued.length,0);
  const withToken = (result: Awaited<ReturnType<typeof replay>>) => {
    assert.ok(result.ok && isRecord(result.value) && typeof result.value.token === 'string', JSON.stringify(result));
    assert.equal(result.value.token, issued.at(-1));
    const { token: _token, ...value } = result.value;
    return { ...result, value };
  };
  const response = { ok: true,value: { orderRef: stored.id,status: stored.status,total: money },replayed: true };
  assert.deepEqual(withToken(await replay(input)),response);
  assert.deepEqual(effects,resumable);
  stored.completed = true;
  assert.deepEqual(withToken(await replay(input)),response);
  assert.deepEqual(effects,resumable);
  // A refreshed acceptance for the same stored terms is the same intent.
  const refreshed = issuer.issuePromotionQuoteAcceptance({ ...signed, request: { ...request, pricePolicyBasis: [null] } })!;
  assert.notEqual(refreshed, token);
  assert.deepEqual(withToken(await replay({ ...input, quoteAcceptance: refreshed })),response);
  assert.deepEqual(effects,resumable);
  assert.equal(issued.length,3);
  assert.deepEqual(receiptCalls,Array.from({ length: 3 }, () => [key, actor.customerRef, scope.lane, submit.submitDigest]));
  assert.equal(savedQuoteChecks,1);
  // A repeat whose link cannot be issued re-reads the order once and changes nothing.
  issueFailure = true;
  assert.deepEqual(await replay(input),{ ok: false,code: 'starter_purchase_unavailable' });
  issueFailure = false;
  assert.deepEqual(effects,resumable);
  stored.completed = false;
  const message = 'fulfillment_stock_current_idempotency_conflict';
  const outcomes = [];
  const expected = [];
  for (const [failure, code] of [
    [Object.assign(new Error(message), { code: '23505', detail: 'openlup:stock_current:replay_conflict' }), 'starter_command_conflict'],
    [Object.assign(new Error(message), { code: '23505' }), 'starter_purchase_unavailable'],
    [{ name: 'FulfillmentStockReplayConflictError', message, code: '23505' }, 'starter_purchase_unavailable'],
  ] as const) {
    stockFailure = failure;
    effects.length = 0;
    outcomes.push(await replay(input));
    expected.push({ ok: false, code });
    assert.deepEqual(effects, resumable.slice(0, 2));
  }
  assert.deepEqual(outcomes, expected);
  assert.deepEqual(unexpected,[]);
});

test('fresh checkout compensates a rejected stock write before reading or reserving order items', async () => {
  const sku = cart.lines[0]!.sku;
  const item = editorDocuments(config).find(entry => entry.document.variants.some(variant => variant.sku === sku))!;
  const variant = item.document.variants.find(entry => entry.sku === sku)!;
  const clientId = '00000000-0000-4000-8000-000000000002', orderId = '00000000-0000-4000-8000-000000000003';
  const listId = '00000000-0000-4000-8000-000000000004', priceId = '00000000-0000-4000-8000-000000000005';
  const actor = { ...context.actor, customerRef: clientId, principalRef: '00000000-0000-4000-8000-000000000001', requesterKey: 'b'.repeat(64) };
  const effects: string[] = [];
  const compensation: unknown[][] = [];
  const never: string[] = [];
  const validFrom = '2000-01-01T00:00:00Z';
  const driver = Object.assign(new Error('fulfillment_stock_current_idempotency_conflict'),
    { code: '23505', detail: 'openlup:stock_current:replay_conflict' });
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.includes('SELECT email')) return { rows: [{ email: payload.email }] };
    if (/pg_advisory|commerce_order_draft_receipts|catalog_admission_requires_quote_authority/u.test(sql)) return { rows: [] };
    if (sql.includes('FROM public.catalog_skus AS sku')) return { rows: [{
      product_id: item.productId, product_slug: item.document.productSlug, primary_sku_id: variant.skuId, current_document_revision_id: item.id,
      sku_id: variant.skuId, sku_product_id: item.productId, sku_code: sku, net_content_unscaled: variant.physical.netWeightG,
      sku_status: 'active', sellable_one_time: true, sellable_subscription: true, is_addon: false, asset_ref: null,
      document_revision_id: item.id, document_product_id: item.productId, document_revision_no: item.document.revisionNo,
      document_schema_id: item.document.schemaVersion, document_ref: item.id, document_source_ref: item.document.sourceRef, document_digest: item.digest,
    }] };
    if (sql.includes('FROM public.catalog_sku_identifiers')) return { rows: [{
      catalog_sku_id: variant.skuId, issuer: variant.physical.issuer, identifier_kind: 'gtin',
      normalized_value: variant.physical.unitGtin, pack_kind: 'unit', quantity: 1, is_primary: true,
    }] };
    if (sql.includes('revision_document_payload')) return { rows: [{
      product_id: item.productId, product_slug: item.document.productSlug, product_status: 'active', current_document_revision_id: item.id,
      revision_id: item.id, revision_product_id: item.productId, revision_no: item.document.revisionNo,
      revision_schema_id: item.document.schemaVersion, revision_document_payload: item.document, revision_digest: item.digest,
    }] };
    if (sql.includes('FROM public.price_lists')) return { rows: [{ id: listId, valid_from: validFrom, valid_to: null }] };
    if (sql.includes('FROM public.price_entries')) return { rows: [{
      id: priceId, price_list_id: listId, variant_id: variant.skuId, mode: 'one_time', min_qty: 1,
      unit_price_minor: 1000, amount_kind: 'gross', valid_from: validFrom, valid_to: null,
    }] };
    if (sql.includes('commerce_promotion_active_definitions')) return { rows: [{ result: [] }] };
    if (sql.includes('commerce_promotion_paid_order_counts')) return { rows: [{ result: { oneTime: 0, subscription: 0 } }] };
    if (sql.includes('commerce_promotion_redemption_counts')) return { rows: [] };
    if (sql.includes('initial_checkout')) return { rows: [{ initial_checkout: true }] };
    if (sql.includes('FROM public.commerce_orders WHERE id=$1')) return { rows: [{
      id: orderId, client_id: clientId, status: 'pending_payment', created_at: validFrom,
    }] };
    if (sql.includes('commerce_register_order_destination')) { effects.push('destination'); return { rows: [{ result: {} }] }; }
    if (sql.includes('fulfillment_record_stock_current')) { effects.push('stock'); throw driver; }
    if (sql.includes('commerce_cancel_abandoned_purchase_checkout')) {
      effects.push('compensation');
      compensation.push(values);
      return { rows: [{ result: { cancelled: true } }] };
    }
    never.push(sql);
    throw new Error('unexpected checkout query');
  };
  const db = { query, async connect() { return { query, release() {} }; } } as unknown as Pool;
  const checkout: AcquisitionPredecessors['checkout'] = () => ({ async createOrderDraft({ idempotencyKey, quoteSnapshot }) {
    effects.push('create');
    return { contractVersion: quoteSnapshot.contractVersion, orderDraft: {
      orderId: `order_${orderId}`, status: 'draft', paymentStatus: 'not_started', idempotencyKey, quoteSnapshot, replayed: false,
    } };
  } });
  const actions = composePurchaseCapabilities(db, {} as never, async () => ({ allowed: true }), {} as never,
    { predecessors: { ...unavailable, checkout } });
  const oneTimeCart = { ...cart, mode: 'one_time', cadenceDays: null };
  const result = await actions['checkout.create']!({ ...payload, cart: oneTimeCart }, { ...context, actor });
  assert.deepEqual(never, []);
  assert.deepEqual(result, { ok: false, code: 'starter_command_conflict' });
  assert.deepEqual(effects, ['create', 'destination', 'stock', 'compensation']);
  assert.equal(compensation.length, 1);
  assert.deepEqual(compensation[0]?.slice(1, 3), [orderId, 'checkout_failed_before_dispatch']);
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

function exactCatalogRefusal(refusal: { code: string; path?: string; fix?: string }) {
  return (error: unknown) => {
    assert.ok(error instanceof Error);
    const proto = Object.getPrototypeOf(error);
    if ('path' in refusal) {
      assert.deepStrictEqual(Reflect.ownKeys(proto), ['constructor']);
      assert.equal(proto.constructor.name, 'MixedProductDocumentError');
      assert.equal(Object.getPrototypeOf(proto), CommerceQuoteCatalogReadError.prototype);
    } else {
      assert.equal(proto, CommerceQuoteCatalogReadError.prototype);
    }
    const actual = Object.fromEntries(Reflect.ownKeys(error)
      .filter(key => key !== 'stack')
      .map(key => [key, Reflect.get(error, key)]));
    assert.deepStrictEqual(actual, { message: refusal.code, name: 'CommerceQuoteCatalogReadError', ...refusal });
    return true;
  };
}

function documentFixture() {
  const config = Object.values(configurations)[0]!;
  const { id: revisionId, document: gramDocument } = editorDocuments(config)[0]!;
  const gram = gramDocument.variants[0]!;
  const sibling = { ...gram, skuId: 'f0000000-0000-4000-8000-000000000001', sku: 'LIQUID',
    physical: { netContent: { dimension: 'volume' as const, unit: 'openlup:ml', unscaled: '295735295625', scale: 12 },
      issuer: 'example:gtin', unitGtin: '5901234123457' } };
  const document = { ...gramDocument, variants: [gram, sibling] };
  const documentRevision = { id: revisionId, digest: documentDigest(document), productId: document.productId,
    schemaId: document.schemaVersion, revisionNo: document.revisionNo, sourceRef: document.sourceRef, documentRef: 'example:document' };
  const envelope: NeutralSkuEnvelopeV1 = { contractVersion: 'catalog.foundation.v1',
    product: { id: document.productId, slug: document.productSlug, primarySkuId: gram.skuId },
    sku: { id: gram.skuId, productId: document.productId, code: gram.sku, isAddon: false, assetRef: null,
      netContent: { unscaled: gram.physical.netWeightG, scale: 0, unit: 'openlup:g' },
      sellability: { status: 'active', subscription: true, oneTime: true } },
    documentRevision, identifiers: [{ issuer: gram.physical.issuer, normalizedValue: gram.physical.unitGtin,
      isPrimary: true, kind: 'gtin', packKind: 'unit', packQuantity: 1 }] };
  const operation = {};
  const mixed: MixedProductRead & { primaryUnitGtin: typeof gram.physical } = {
    operation, primaryUnitGtin: gram.physical,
    evidence: { operation, productId: document.productId, documentRevisionId: revisionId, documentDigest: documentRevision.digest,
      siblings: [{ skuId: sibling.skuId, sku: sibling.sku, netContent: structuredClone(sibling.physical.netContent),
        primaryUnitGtin: { issuer: sibling.physical.issuer, unitGtin: sibling.physical.unitGtin }, issuingDraft: {
        draftId: 'f0000000-0000-4000-8000-000000000002', revision: 1, commandKey: 'example:bottle', fingerprint: 'a'.repeat(64),
      } }] },
  };
  const quote = quoteDocumentVerifier(document.schemaVersion);
  const sized = (value: unknown, read?: typeof mixed) => verifySizedProductDocument(value, document.schemaVersion, {
    skuId: gram.skuId, sku: gram.sku, productId: document.productId, netWeightG: gram.physical.netWeightG,
    documentRevisionId: revisionId, documentDigest: documentRevision.digest,
  }, read);
  return { gram, gramDocument, sibling, document, documentRevision, envelope, mixed, quote, sized };
}

test('quote and sized verify the same mixed document for its gram selection', async () => {
  const { gram, document, envelope, mixed, quote, sized } = documentFixture();
  await quote(document, envelope, mixed);
  assert.deepEqual(sized(document, mixed), gram);
  const refusal = exactCatalogRefusal({ code: 'catalog_document_schema_invalid' });
  await assert.rejects(quote(document, envelope), refusal);
  assert.throws(() => sized(document), refusal);
});

type Fixture = ReturnType<typeof documentFixture>;
const badEvidence: Record<string, (fixture: Fixture) => void> = {
  operation: ({ mixed }) => { mixed.evidence.operation = {}; },
  product: ({ mixed }) => { mixed.evidence.productId = 'other'; },
  revision: ({ mixed }) => { mixed.evidence.documentRevisionId = 'other'; },
  id: ({ mixed }) => { mixed.evidence.siblings[0]!.skuId = 'other'; },
  code: ({ mixed }) => { mixed.evidence.siblings[0]!.sku = 'OTHER'; },
  duplicateId: ({ mixed }) => { mixed.evidence.siblings = [...mixed.evidence.siblings, { ...mixed.evidence.siblings[0]! }]; },
  duplicateCode: ({ sibling, document, documentRevision, mixed }) => {
    const skuId = 'f0000000-0000-4000-8000-000000000003';
    document.variants.push({ ...sibling, skuId });
    mixed.evidence.siblings = [...mixed.evidence.siblings, { ...mixed.evidence.siblings[0]!, skuId }];
    mixed.evidence.documentDigest = documentRevision.digest = documentDigest(document);
  },
  malformedRow: ({ mixed }) => { Reflect.deleteProperty(mixed.evidence.siblings[0]!, 'skuId'); },
  missing: ({ mixed }) => { mixed.evidence.siblings = []; },
  extra: ({ mixed }) => { mixed.evidence.siblings = [...mixed.evidence.siblings, { ...mixed.evidence.siblings[0]!, skuId: 'other', sku: 'OTHER' }]; },
  term: ({ mixed }) => { mixed.evidence.siblings[0]!.netContent.unscaled = '295735295626'; },
  gtin: ({ mixed }) => { mixed.evidence.siblings[0]!.primaryUnitGtin.unitGtin = '5901234123464'; },
  issuer: ({ mixed }) => { mixed.evidence.siblings[0]!.primaryUnitGtin.issuer = 'example:other'; },
  openArm: ({ sibling, document, documentRevision, mixed }) => {
    Object.assign(sibling.physical, { netWeightG: 1 });
    mixed.evidence.documentDigest = documentRevision.digest = documentDigest(document);
  },
};
for (const [name, mutate] of Object.entries(badEvidence)) test(`quote and sized refuse mixed document ${name}`, async () => {
  const fixture = documentFixture();
  mutate(fixture);
  const { document, envelope, mixed, quote, sized } = fixture;
  const refusal = exactCatalogRefusal({ code: 'catalog_document_schema_invalid', path: 'documentRevision',
    fix: 'Recover the admitted document and its revision.' });
  await assert.rejects(quote(document, envelope, mixed), refusal);
  assert.throws(() => sized(document, mixed), refusal);
});

test('application_document_path_is_byte_identical', async () => {
  const { gram, gramDocument, sibling, document, documentRevision, envelope, mixed, quote, sized } = documentFixture();
  Object.assign(sibling.physical, { extra: true });
  const digestRefusal = exactCatalogRefusal({ code: 'catalog_document_digest_mismatch', path: 'documentRevision.digest',
    fix: 'Replay the original document bytes and digest.' });
  await assert.rejects(quote(document, envelope, mixed), digestRefusal);
  assert.throws(() => sized(document, mixed), digestRefusal);
  const malformed = { ...gramDocument, variants: [{ ...gram, demandPerUnit: 0 }] };
  const legacySchemaRefusal = exactCatalogRefusal({ code: 'catalog_document_schema_invalid' });
  await assert.rejects(quote(malformed, envelope), legacySchemaRefusal);
  assert.throws(() => sized(malformed), legacySchemaRefusal);
  await assert.rejects(quote(gramDocument, envelope), exactCatalogRefusal({ code: 'catalog_document_digest_mismatch' }));
  assert.throws(() => sized(gramDocument), /subscription_reprice_sized_catalog_facts_unreadable/u);
  documentRevision.digest = documentDigest(gramDocument);
  await quote(gramDocument, envelope);
  assert.deepEqual(sized(gramDocument), gram);
});

test('published identity precedes digest and damage can be restored from retained evidence', async () => {
  const { quote, envelope } = documentFixture();
  const ref = envelope.documentRevision;
  ref.schemaId = 'fixture:product@1';
  const retained = { schemaId: ref.schemaId, documentRef: ref.documentRef, productSlug: envelope.product.slug,
    revisionNo: ref.revisionNo, authored: { names: ['Léon', '雪'], flags: [true, null] } };
  const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
  const saved = canonicalCatalogDraftJson(retained);
  ref.digest = hash(saved);
  const refusal = (digest: boolean) => (error: unknown) => {
    assert.ok(error instanceof CommerceQuoteCatalogReadError);
    assert.equal(Object.getPrototypeOf(error), CommerceQuoteCatalogReadError.prototype);
    assert.deepEqual(Reflect.ownKeys(error).filter(key => key !== 'stack'),
      ['message', 'code', 'name', 'path', 'observed', 'causeText', 'fix', 'recheck']);
    const code = digest ? 'catalog_document_digest_mismatch' : 'catalog_document_schema_invalid';
    assert.equal(error.message, code);
    assert.deepEqual(Object.fromEntries(Object.entries(error)), {
      code, name: 'CommerceQuoteCatalogReadError', path: digest ? 'documentRevision.digest' : 'documentRevision',
      observed: digest ? 'The canonical document has a different digest.' : 'The published document identity or encoding is invalid.',
      causeText: 'The stored document does not match the admitted revision.',
      fix: 'Restore the admitted revision from a verified backup.', recheck: 'Repeat the original quote.',
    });
    return true;
  };
  await quote(JSON.parse(saved), envelope);
  for (const replacement of [
    { schemaId: 'another' }, { productSlug: 'another' }, { revisionNo: 0 }, { revisionNo: ref.revisionNo + 1 },
    { revisionNo: 2_147_483_648 }, { documentRef: null }, { documentRef: 'wrong-but-hashed' },
  ]) {
    const damaged = { ...retained, ...replacement };
    ref.digest = hash(canonicalCatalogDraftJson(damaged));
    await assert.rejects(quote(damaged, envelope), refusal(false));
    ref.digest = '0'.repeat(64);
    await assert.rejects(quote(damaged, envelope), refusal(false));
  }
  ref.digest = hash(saved);
  await assert.rejects(quote({ ...retained, authored: { flags: [] } }, envelope), refusal(true));
  await quote(JSON.parse(saved), envelope);

  const emptyArray = (depth: number) => Array.from({ length: depth - 1 }).reduce<unknown>(inner => [inner], []);
  const withinDepth = { ...retained, authored: emptyArray(47) };
  ref.digest = hash(canonicalCatalogDraftJson(withinDepth));
  await quote(withinDepth, envelope);
  await assert.rejects(quote({ ...retained, authored: emptyArray(48) }, envelope), refusal(false));
  for (const authored of [Infinity, -0, { value: '\u0000' }, { value: '\ud800' }])
    await assert.rejects(quote({ ...retained, authored }, envelope), refusal(false));

  const empty = canonicalCatalogDraftJson({ ...retained, authored: '' });
  for (const bytes of [1_048_576, 1_048_577]) {
    const padding = bytes - Buffer.byteLength(empty, 'utf8');
    const value = 'é'.repeat(Math.floor(padding / 2)) + 'a'.repeat(padding % 2);
    const exact = canonicalCatalogDraftJson({ ...retained, authored: 'PLACEHOLDER' }).replace('PLACEHOLDER', value);
    assert.equal(Buffer.byteLength(exact, 'utf8'), bytes);
    ref.digest = hash(exact);
    if (bytes === 1_048_576) await quote(JSON.parse(exact), envelope);
    else await assert.rejects(quote(JSON.parse(exact), envelope), refusal(false));
  }
});
