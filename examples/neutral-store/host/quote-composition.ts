import { resolveThresholdShipping } from '@openlup/platform/shipping';
import type { RenewalRetainedTerms } from '@openlup/platform/subscriptions/contracts';
import { evaluatePromotionAdjustmentsV2 } from '@openlup/core/promo';
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { createPostgresCommerceQuoteCatalogReadPort, canonicalCatalogDraftJson } from '@openlup/platform/catalog';
import { createPostgresCommercePriceAuthorityReadPort } from '@openlup/platform/commerce/server/postgres';
import { createCommercePriceAuthorityPort, createDbBackedCommerceQuotePort, AcquisitionTermsError,
  CommerceQuoteCatalogReadError, ACQUISITION_TERMS_CAPABILITY, projectPublicQuoteSnapshot, acquisitionProjectionFreshness, projectAcquisitionTerms,
  type AcquisitionQuoteRequest, type ResolvedAcquisitionTerms, type CreateQuoteResponse } from '@openlup/platform/pricing';
import { createPostgresCommercePromoDataPort, createQuotePromoDiscounts, createQuotePromotionV2,
  createQuoteAutomaticPromotions, createQuotePromotionCodeAdjustments, createQuoteShippingPromotions,
  createPromotionQuoteAcceptance, type PromotionAcceptanceKeyring } from '@openlup/platform/promotions';
import { createAcquisitionFinancialPolicy } from '../owned/acquisition-policy.ts';
import { isRecord, validateCart, type OfferQuote } from '../shared/offer.ts';
import type { ActionContext } from './bindings.ts';
import type { AcquisitionPredecessors } from './acquisition-predecessors.ts';

interface Request extends AcquisitionQuoteRequest { checkout: Record<string, unknown>; pricingPolicy: typeof pricingPolicy; pricePolicyBasis?: unknown; renewalPolicy?: unknown }
export const pricingPolicy = { offerPolicyVersion: 'commerce.offer-policy.v2', promotionEngineVersion: 'promotion-engine.v2' } as const;
const acceptance = createPromotionQuoteAcceptance<Request>({ projectRequest: request => request });
const digest = (value: unknown) => createHash('sha256').update(canonicalCatalogDraftJson(value)).digest('hex');

export function quoteFailure(error: unknown): string {
  if (error instanceof AcquisitionTermsError) return error.reason;
  if (error instanceof Error && /^(starter_|catalog_|base_price_|subscription_price_|active_price_)/.test(error.message)) return error.message;
  return 'starter_quote_unavailable';
}

export function createNativeQuoteService(db: Pool, predecessors: AcquisitionPredecessors, keyring?: PromotionAcceptanceKeyring) {
  async function quote(payload: Record<string, unknown>, context: ActionContext, replay?: CreateQuoteResponse, atTime = new Date().toISOString()) {
    const config = context.config;
    const selected = validateCart(config, payload.cart);
    if (!selected.ok) throw new Error(selected.issues[0]!.code);
    if (selected.cart.mode === 'subscription' && payload.acquisitionCapability !== ACQUISITION_TERMS_CAPABILITY) {
      throw new AcquisitionTermsError('acquisition_terms_capability_required');
    }
    if (payload.promoCodes !== undefined && (!Array.isArray(payload.promoCodes) || payload.promoCodes.length)) throw new Error('starter_promotion_codes_unsupported');
    const email = context.actor.customerRef
      ? (await db.query('SELECT email FROM public.clients WHERE id=$1 AND principal_id=$2', [context.actor.customerRef,context.actor.principalRef])).rows[0]?.email
      : typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : null;
    const request: Request = { mode: selected.cart.mode, cadenceDays: selected.cart.cadenceDays,
      lines: selected.cart.lines, promoCodes: [], pricingPolicy,
      ...(payload.acquisitionCapability === ACQUISITION_TERMS_CAPABILITY ? { acquisitionCapability: ACQUISITION_TERMS_CAPABILITY } : {}),
      checkout: Object.fromEntries(['configuration','country','termsRevision','firstName','lastName','phone','line1','line2','city','postalCode']
        .map(key => [key,payload[key] ?? null]).concat([['email',email],['purchaser',context.actor.customerRef]])) };
    const requestIdentity = digest(request);
    if (replay) {
      if ((replay.quote.context as { starterRequest?: string } | undefined)?.starterRequest !== requestIdentity) throw new Error('starter_command_conflict');
      return { request, snapshot: replay, token: null, terms: (replay.quote.context as { acquisitionTerms?: ResolvedAcquisitionTerms }).acquisitionTerms,
        projection: projectQuote(replay, config.quote.acquisition.minimumProductPayableMinor) };
    }
    const eligibility = selected.cart.mode === 'subscription' && email !== null
      ? await predecessors.eligibility(db).resolve(email) : { clientId: context.actor.customerRef };
    const financialPolicy = createAcquisitionFinancialPolicy();
    const acquisition = { financialPolicy, capability: (input: AcquisitionQuoteRequest) => input.acquisitionCapability };
    const promotionCustomerSemantic = () => undefined;
    const promo = createQuotePromoDiscounts({ acquisition, promotionCustomerSemantic });
    const v2 = createQuotePromotionV2({ ...promo, acquisition, promotionCustomerSemantic,
      minimumProductPayableMinor: config.quote.acquisition.minimumProductPayableMinor });
    const automatic = createQuoteAutomaticPromotions<Request>({ ...promo, ...v2, acquisition, resolveEmailEligibility: () => typeof email === 'string' && email.length > 0 });
    const codes = createQuotePromotionCodeAdjustments({ minimumProductPayableMinor: config.quote.acquisition.minimumProductPayableMinor });
    const shipping = createQuoteShippingPromotions({ ...automatic, ...codes,
      promoDataPort: createPostgresCommercePromoDataPort(db),
      commerceSettingsPort: { getShippingSettings: async () => ({ legacyFlatMinor: 0, policy: { version: 'shipping-policy.v1',
        current: { enabled: true, flatMinor: config.offer.shippingMinor, freeThresholdMinor: config.offer.freeShippingFromMinor,
          effectiveFrom: config.quote.policy.effectiveFrom } } }) } });
    const taxProfile = { included: true as const, country: config.market.country, ...config.purchase.tax };
    const port = createDbBackedCommerceQuotePort<Request, import('@openlup/platform/pricing').CommerceQuoteCatalogItem, Record<string, never>,
      { mode: Request['mode']; cadenceDays: number | null; promoCodes: string[]; starterRequest: string; acquisitionCapability?: typeof ACQUISITION_TERMS_CAPABILITY; starterRenewalTerms?: RenewalRetainedTerms }>({
      quoteCatalogReadPort: createPostgresCommerceQuoteCatalogReadPort(db, { verifyDocument: async (input,envelope) => {
        if (!isRecord(input) || input.schemaVersion !== config.quote.document.schemaId
          || input.schemaVersion !== envelope.documentRevision.schemaId || Object.keys(input).length !== 7
          || typeof input.productId !== 'string' || input.productId.toLowerCase() !== envelope.product.id.toLowerCase()
          || typeof input.skuId !== 'string' || input.skuId.toLowerCase() !== envelope.sku.id.toLowerCase()
          || input.productSlug !== envelope.product.slug || input.revisionNo !== envelope.documentRevision.revisionNo
          || input.sourceRef !== envelope.documentRevision.sourceRef || !isRecord(input.physical)
          || input.physical.netWeightG !== envelope.sku.netContent.unscaled
          || !envelope.identifiers.some(identifier => identifier.isPrimary && identifier.kind === 'gtin'
            && identifier.issuer === (input.physical as Record<string,unknown>).issuer
            && identifier.normalizedValue === (input.physical as Record<string,unknown>).unitGtin)) throw new CommerceQuoteCatalogReadError('catalog_document_schema_invalid');
        if (digest(input) !== envelope.documentRevision.digest) throw new CommerceQuoteCatalogReadError('catalog_document_digest_mismatch');
      } }),
      isStrictD1Quote: true, commercePriceAuthorityPort: createCommercePriceAuthorityPort(createPostgresCommercePriceAuthorityReadPort(db)),
      taxProfile, supportedTaxProfiles: [taxProfile], regionCode: config.market.country, currency: config.market.currency,
      now: () => atTime, hasPromotionCodePort: false, lineContext: () => ({}),
      quoteContext: input => () => ({ mode: input.mode, cadenceDays: input.cadenceDays ?? null, promoCodes: input.promoCodes, starterRequest: requestIdentity,
        ...(input.acquisitionCapability ? { acquisitionCapability: input.acquisitionCapability } : {}) }),
      ...automatic, ...codes, ...shipping,
    });
    const snapshot = await port.createServerAuthoritativeQuote(request, { clientId: eligibility.clientId, pricingPolicy });
    const terms = snapshot.quote.context.acquisitionTerms;
    if (terms) {
      const view = projectQuote(snapshot, config.quote.acquisition.minimumProductPayableMinor);
      if (view.secondTotalMinor === undefined) throw new Error('starter_quote_refresh_required');
      const linePricing = snapshot.quote.lines.map(line => ({ sku: line.sku, quantity: line.quantity,
        unitAmountMinor: line.unitPriceGross.amountMinor, isAddon: false, quoteLine: { ...line } }));
      snapshot.quote.context.starterRenewalTerms = { version: 'native.renewal-terms.v1', linePricing,
        shippingTerms: snapshot.quote.context.shippingTerms,
        minimumPayableMinor: config.quote.acquisition.minimumProductPayableMinor,
        normalCadenceDays: [config.quote.acquisition.graduationCadenceDays],
        starterPack: { schemaVersion: '1', starterIntervalDays: selected.cart.cadenceDays!, basisTemplateVersion: 1,
          delivery2: { discountBps: terms.delivery2DiscountBps, basisSubtotalMinor: snapshot.quote.subtotalGross.amountMinor,
            discountMinor: snapshot.quote.subtotalGross.amountMinor - secondProductTotal(snapshot, config.quote.acquisition.minimumProductPayableMinor)! },
          graduation: { cadenceDays: config.quote.acquisition.graduationCadenceDays,
            lines: linePricing.map((line, index) => ({ sku: line.sku, qty: line.quantity, sortOrder: index,
              isAddon: line.isAddon, quoteLine: line.quoteLine })) } } };
    }
    const retained = snapshot.quote.context.starterRenewalTerms;
    const acceptedRequest = { ...request, ...(retained ? { renewalPolicy: { minimumPayableMinor: retained.minimumPayableMinor,
      normalCadenceDays: retained.normalCadenceDays, starterIntervalDays: retained.starterPack!.starterIntervalDays,
      graduationCadenceDays: retained.starterPack!.graduation.cadenceDays, delivery2: retained.starterPack!.delivery2 } } : {}), pricePolicyBasis: snapshot.quote.lines.map(line => {
      const facts = line.catalogFacts;
      return facts?.version === 'catalog_facts_v2' ? { sku: line.sku, policyRevisionId: facts.policyRevisionId, policyDigest: facts.policyDigest } : null;
    }) };
    const token = terms ? acceptance.issuePromotionQuoteAcceptance({ request: acceptedRequest, quote: snapshot.quote, acquisitionTerms: terms,
      ...(snapshot.quote.context.shippingTerms ? { shippingTerms: snapshot.quote.context.shippingTerms } : {}),
      keyring: requireKeyring(keyring) }) : null;
    return { request: acceptedRequest, snapshot, token, terms, projection: projectQuote(snapshot, config.quote.acquisition.minimumProductPayableMinor) };
  }
  return { quote, verify(observed: Awaited<ReturnType<typeof quote>>, payload: Record<string, unknown>) {
    if (!observed.terms) return;
    const shippingTerms = (observed.snapshot.quote.context as { shippingTerms?: import('@openlup/platform/shipping').ShippingTerms } | undefined)?.shippingTerms;
    if (typeof payload.quoteAcceptance !== 'string' || !isRecord(payload.expectedTotal)
      || typeof payload.expectedTotal.amountMinor !== 'number' || typeof payload.expectedTotal.currency !== 'string'
      || !acceptance.verifyPromotionQuoteAcceptance({ token: payload.quoteAcceptance, request: observed.request,
        quote: observed.snapshot.quote, acquisitionTerms: observed.terms,
        ...(shippingTerms ? { shippingTerms } : {}),
        expectedTotal: { amountMinor: payload.expectedTotal.amountMinor, currency: payload.expectedTotal.currency }, keyring: requireKeyring(keyring) })) {
      throw new Error('starter_quote_refresh_required');
    }
  }, public(observed: Awaited<ReturnType<typeof quote>>) {
    const projected = projectPublicQuoteSnapshot(observed.snapshot);
    if (projected.quote.context) {
      const context = { ...projected.quote.context } as typeof projected.quote.context & { starterRenewalTerms?: RenewalRetainedTerms };
      delete context.starterRenewalTerms;
      projected.quote.context = context;
    }
    return { ...observed.projection, quote: projected, quoteAcceptance: observed.token,
      ...(observed.terms ? acquisitionProjectionFreshness(projectAcquisitionTerms(observed.terms),new Date().toISOString()) : {}),
      expectedTotal: observed.snapshot.quote.totalGross };
  } };
}

function requireKeyring(keyring?: PromotionAcceptanceKeyring) {
  if (!keyring || keyring.current.length < 32) throw new Error('starter_quote_acceptance_key_required');
  return keyring;
}
function secondProductTotal(snapshot: CreateQuoteResponse, minimumProductPayableMinor: number): number | undefined {
  const quote = snapshot.quote;
  const terms = (quote.context as { acquisitionTerms?: ResolvedAcquisitionTerms } | undefined)?.acquisitionTerms;
  const referenceProductMinor = quote.lines.reduce((sum,line) => sum + (line.catalogFacts?.baseUnitAmountMinor ?? line.unitPriceGross.amountMinor) * line.quantity,0);
  const second = terms ? evaluatePromotionAdjustmentsV2({ purchaseScope: 'subscription_initial',referenceProductMinor,
    currentProductMinor: quote.subtotalGross.amountMinor,shippingMinor: 0,minimumProductPayableMinor }, [{
      promotionId: terms.sourcePromotionId,name: 'Second delivery',source: 'automatic',scopes: ['subscription_initial'],
      kind: 'target_percentage',lane: 'product',valueBps: terms.delivery2DiscountBps }]) : null;
  const retained = (quote.context as { starterRenewalTerms?: RenewalRetainedTerms } | undefined)?.starterRenewalTerms;
  const saved = retained?.starterPack?.delivery2;
  return saved ? saved.basisSubtotalMinor - saved.discountMinor : second ? quote.subtotalGross.amountMinor - second.adjustments.reduce((sum,item) => sum + item.amountOffMinor,0) : undefined;
}

export function projectQuote(snapshot: CreateQuoteResponse, minimumProductPayableMinor: number): OfferQuote & { acquisitionTerms?: ResolvedAcquisitionTerms; secondTotalMinor?: number } {
  const quote = snapshot.quote;
  const terms = (quote.context as { acquisitionTerms?: ResolvedAcquisitionTerms } | undefined)?.acquisitionTerms;
  const product = secondProductTotal(snapshot, minimumProductPayableMinor);
  const shipping = (quote.context as { shippingTerms?: import('@openlup/platform/shipping').ShippingTerms } | undefined)?.shippingTerms;
  const secondTotalMinor = product === undefined ? undefined : product + (shipping ? resolveThresholdShipping(shipping, product).grossMinor : 0);
  return { lines: quote.lines.map(line => ({ sku: line.sku, quantity: line.quantity, unitMinor: line.unitPriceGross.amountMinor,
    lineMinor: line.lineSubtotalGross.amountMinor,
    baseUnitMinor: line.catalogFacts?.baseUnitAmountMinor ?? line.unitPriceGross.amountMinor })),
    subtotalMinor: quote.subtotalGross.amountMinor, discountMinor: quote.discountTotalGross.amountMinor,
    modeDiscountMinor: quote.lines.reduce((sum,line) => sum - (line.pricingComponents ?? [])
      .filter(component => component.componentType === 'mode_discount').reduce((total,component) => total + component.amountMinor,0),0),
    shippingMinor: (quote.shippingGross?.amountMinor ?? 0) - (quote.shippingDiscountGross?.amountMinor ?? 0),
    totalMinor: quote.totalGross.amountMinor, currency: quote.currency, mode: quote.context!.mode, cadenceDays: quote.context!.cadenceDays ?? null,
    ...(terms && secondTotalMinor !== undefined ? { acquisitionTerms: terms, secondTotalMinor } : {}) };
}
