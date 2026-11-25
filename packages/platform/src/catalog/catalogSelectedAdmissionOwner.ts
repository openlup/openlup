import { postgresTimestampTzToRfc3339, type PgQueryExecutor } from "../data/index.js";
import { createCommercePriceAuthorityPort, createDbBackedCommerceQuotePort, toGrossMinor, type CommercePriceAuthorityReadPort,
  type CommerceQuoteCatalogItem, type CommerceTaxProfile, type QuoteShippingPromotionInput, type QuoteShippingPromotionResult } from "../pricing/index.js";
import { readAdmissionIssues } from "./catalogAdmissionIssueRead.js";
import { buildSelectedSubscriptionOwnerQuote, selectedSubscriptionQuoteSchema, type SelectedSubscriptionOwnerInput as OwnerInput, type SelectedSubscriptionQuote } from "./catalogOwnerQuoteSubscription.js";
import { digestText, refuseSelected, type SelectedOriginal } from "./catalogSelectedAdmissionWrite.js";
import { createPostgresCommerceQuoteCatalogReadPort, type PostgresCommerceQuoteCatalogReadOptions } from "./commerceQuoteCatalogRead.js";
import { canonicalCatalogDraftJson as canonical } from "./contracts/draft.js";
import { z } from "./validation.js";

export type OwnerRequest = OwnerInput["request"] & { purpose: "offer-review"; mode: "subscription"; promoCodes: [] };
export type SelectedProfile = {
  identity: Pick<SelectedOriginal, "ownerNamespace" | "merchantRef" | "installationRef" | "configuration" | "offer">;
  offerSelector: string; country: string; currency: string; termsRevision: string;
  cadenceDays: readonly number[]; minimumUnits: number; maximumUnits: number;
  skuIds: readonly [string, string]; skuCodes: readonly [string, string];
  skuRevisionId: string; priceListId: string; sourceOrdinal: 1 | 2;
  // Installed quote authority excludes open promotion, family and claim-capacity reads.
  authority?: {
    pricingPolicy: OwnerInput["quote"]["quote"]["context"]["pricingPolicy"];
    tax: CommerceTaxProfile; verifyDocument: PostgresCommerceQuoteCatalogReadOptions["verifyDocument"];
    priceRead(db: PgQueryExecutor): CommercePriceAuthorityReadPort;
    secondShipping(terms: NonNullable<QuoteShippingPromotionResult["shippingTerms"]>, productMinor: number): number;
    phase: OwnerInput["phase"]; destination: NonNullable<OwnerInput["decisions"]["destination"]> | null;
    retention: { minimumPayableMinor: number; normalCadenceDays: number[]; graduationCadenceDays: number; basisTemplateVersion: number };
    evaluate(input: QuoteShippingPromotionInput<OwnerRequest>): Promise<{
      result: QuoteShippingPromotionResult & { acquisitionTerms: NonNullable<QuoteShippingPromotionResult["acquisitionTerms"]> };
      decisions: Omit<OwnerInput["decisions"], "destination">;
      secondProductMinor: number;
    }>;
  };
};

export function ownerRequest(original: SelectedOriginal, offerSelector: string): OwnerRequest {
  const { selection, actorRef, clientId, ownerNamespace, configuration, contact, consent } = original;
  return { ...selection, principalRef: actorRef, clientId, ownerNamespace, purpose: "offer-review", promoCodes: [], offerSelector,
    checkout: { ...contact, configuration, termsRevision: consent.termsRevision, line2: contact.line2 ?? null } };
}

const zoned = z.iso.datetime({ offset: true });
const discountKeys = new Set(["promotionId", "appliesTo", "amountOffMinor", "reasonCode", "code", "label", "customerSemantic"]);
export function selectedInstant(raw: string) {
  const source = postgresTimestampTzToRfc3339(raw);
  if (!zoned.safeParse(source).success || !Number.isFinite(Date.parse(source))) return refuseSelected("membership");
  return new Date(source).toISOString();
}

function normalizeWindow(from: string, to: string | null) {
  const start = selectedInstant(from), end = to === null ? null : selectedInstant(to);
  if (end !== null && end <= start) return refuseSelected("membership");
  return { validFrom: start, validTo: end };
}

export async function evaluateSelectedAdmissionOwner(db: PgQueryExecutor, profile: SelectedProfile, request: OwnerRequest, atTime: string) {
  const { authority, country: regionCode, currency, priceListId, sourceOrdinal, skuIds, skuRevisionId } = profile;
  if (!authority) return refuseSelected("line");
  if (!profile.identity.offer) return refuseSelected("membership");
  const membership = await readAdmissionIssues(db, profile.identity.offer.version, skuIds[sourceOrdinal - 1]!, skuRevisionId, sourceOrdinal);
  const legacyOffer = await db.query(
    "SELECT public.catalog_admission_requires_quote_authority($1::text[],$2::text) AS governed",
    [[request.lines[2 - sourceOrdinal]!.sku], profile.identity.offer.version]);
  if (legacyOffer.rows.length !== 1 || legacyOffer.rows[0]?.governed !== false) return refuseSelected("line");
  const catalog = await createPostgresCommerceQuoteCatalogReadPort(db, authority).listQuoteCatalogItems();
  const items = skuIds.map((skuId, index) => catalog.find(item => item.skuId === skuId && item.skuCode === request.lines[index]!.sku));
  const lineBindings: OwnerInput["lineBindings"] = items.map((item, index) => {
    if (!item?.sellability.subscription) return refuseSelected("line");
    const line = { sourceOrdinal: index + 1, skuId: item.skuId, skuCode: item.skuCode, mode: "subscription" as const,
      quantity: request.lines[index]!.quantity, role: item.isAddon ? "addon" as const : "core" as const };
    return index + 1 === sourceOrdinal ? { ...line, source: "fresh", skuRevisionId } : { ...line, source: "legacy" };
  });
  const priceScope = { priceListId, regionCode, currency, channel: "D2C" as const };
  const read = authority.priceRead(db);
  const price = createCommercePriceAuthorityPort(read);
  const lists = (await read.listPriceLists(priceScope)).map(row => ({ priceListId: row.value, ...normalizeWindow(row.validFrom, row.validTo) }));
  const policyHistory = (await read.listSubscriptionPolicyHistory(priceScope)).map(row => row.value) as OwnerInput["policyHistory"];
  const results: NonNullable<OwnerInput["price"]>["results"] = [];
  const selectors: NonNullable<OwnerInput["price"]>["selectors"] = [];
  for (const [index, variantId] of skuIds.entries()) {
    const selected = await price.resolvePrice({ ...priceScope, variantId, atTime, mode: "subscription" });
    if (selected.kind === "one_time" || selected.base.priceListId !== priceListId) return refuseSelected("price");
    const base = { ...selected.base, mode: "one_time" as const, matchedMinQty: 1 as const };
    const resolved = selected.kind === "subscription_policy" ? selected.base : selected.legacyResolved;
    const gross = toGrossMinor({ ...resolved, unitPriceMinor: selected.unitPriceMinor }, authority.tax.vatRateBps);
    if (gross * request.lines[index]!.quantity > 2_147_483_647) return refuseSelected("price");
    if (selected.base.mode !== "one_time" || selected.base.matchedMinQty !== 1 || resolved.matchedMinQty !== 1) return refuseSelected("price");
    if (selected.kind === "subscription_legacy") {
      if (selected.legacyResolved.mode !== "subscription") return refuseSelected("price");
      results.push({ ...selected, base, legacyResolved: { ...selected.legacyResolved, mode: "subscription", matchedMinQty: 1 } });
    } else results.push({ ...selected, base });
    for (const row of [...await read.listExactBaseEntries({ variantId, priceListId }), ...await read.listExactLegacySubscriptionEntries({ variantId, priceListId })]) {
      const range = normalizeWindow(row.validFrom, row.validTo);
      const { mode, matchedMinQty } = row.value;
      if (mode === "any" || matchedMinQty !== 1) return refuseSelected("price");
      const value = { ...row.value, mode, matchedMinQty: 1 as const, resolvedAt: range.validFrom };
      const declaringRef = value.priceEntryId;
      const selector = { sourceOrdinal: index + 1, selectorKey: [priceListId, variantId, value.mode, 1, declaringRef].join(":"), declaringRef, value, ...range };
      const roles = [...(declaringRef === selected.base.priceEntryId ? ["base" as const] : []),
        ...(declaringRef === resolved.priceEntryId ? ["actual" as const] : [])];
      for (const role of roles) selectors.push({ ...selector, role, outcome: "selected" });
      if (!roles.length) selectors.push({ ...selector, role: "comparison", outcome: "rejected" });
    }
  }
  let evaluation: Awaited<ReturnType<NonNullable<SelectedProfile["authority"]>["evaluate"]>> | undefined;
  const quotePort = createDbBackedCommerceQuotePort<OwnerRequest, CommerceQuoteCatalogItem, Record<string, never>,
    Pick<SelectedSubscriptionQuote["quote"]["context"], "mode" | "cadenceDays" | "promoCodes" | "acquisitionCapability" | "starterRequest">>({
    quoteCatalogReadPort: { listQuoteCatalogItems: async () => catalog },
    commercePriceAuthorityPort: { resolvePrice: async input => results[skuIds.indexOf(input.variantId)]! },
    isStrictD1Quote: true, taxProfile: authority.tax, supportedTaxProfiles: [authority.tax], regionCode, currency, now: () => atTime,
    hasPromotionCodePort: false, lineContext: () => ({}), quoteContext: () => () => ({
      mode: request.mode, cadenceDays: request.cadenceDays, promoCodes: request.promoCodes, acquisitionCapability: request.acquisitionCapability,
      starterRequest: digestText(canonical(request)),
    }),
    resolveAutomaticQuotePromotions: async () => refuseSelected("line"),
    applyPromotionCodesV2: async () => refuseSelected("line"),
    resolveQuoteShippingPromotions: async input => {
      evaluation = await authority.evaluate(input);
      const { shippingGrossMinor, discounts } = evaluation.result;
      if (!Number.isInteger(shippingGrossMinor) || shippingGrossMinor < 0 || shippingGrossMinor > 2_147_483_647
        || discounts.length > 20 || discounts.some(discount => !Number.isSafeInteger(discount.amountOffMinor)
          || discount.amountOffMinor < 1 || discount.appliesTo === "line" || (Object.hasOwn(discount, "code") && discount.code !== null)
          || Object.keys(discount).some(key => !discountKeys.has(key))
          || discount.amountOffMinor > (discount.appliesTo === "shipping" ? shippingGrossMinor : input.subtotalGrossMinor))) {
        return refuseSelected("integrity");
      }
      return evaluation.result;
    },
  });
  const snapshot = await quotePort.createServerAuthoritativeQuote(request, { clientId: request.clientId, pricingPolicy: authority.pricingPolicy });
  if (!evaluation) return refuseSelected("line");
  const { result, decisions, secondProductMinor: product } = evaluation;
  const { quote } = snapshot, { acquisitionTerms, shippingTerms } = result;
  const { minimumPayableMinor, normalCadenceDays, graduationCadenceDays, basisTemplateVersion } = authority.retention;
  const subtotal = quote.subtotalGross.amountMinor;
  if (!Number.isSafeInteger(product) || product < Math.min(minimumPayableMinor, subtotal) || product > subtotal) return refuseSelected("integrity");
  const discountMinor = subtotal - product;
  const secondTotalMinor = product + (shippingTerms ? authority.secondShipping(shippingTerms, product) : 0);
  const lines = quote.lines as SelectedSubscriptionQuote["quote"]["lines"];
  const linePricing = lines.map((line, index) => ({ sku: line.sku, quantity: line.quantity, unitAmountMinor: line.unitPriceGross.amountMinor,
    isAddon: lineBindings[index]!.role === "addon", quoteLine: line }));
  const starterRenewalTerms = { version: "native.renewal-terms.v1" as const, linePricing, ...(shippingTerms && { shippingTerms }), minimumPayableMinor, normalCadenceDays,
    starterPack: { schemaVersion: "1" as const, starterIntervalDays: request.cadenceDays, basisTemplateVersion,
      delivery2: { discountBps: acquisitionTerms.delivery2DiscountBps, basisSubtotalMinor: subtotal, discountMinor },
      graduation: { cadenceDays: graduationCadenceDays, lines: linePricing.map(({ sku, quantity: qty, isAddon, quoteLine }, sortOrder) => ({ sku, qty, isAddon, quoteLine, sortOrder })) } } };
  const quoteSnapshot = selectedSubscriptionQuoteSchema.parse({
    ...snapshot, quote: { ...quote, lines, context: { ...quote.context, acquisitionTerms, starterRenewalTerms, pricingPolicy: authority.pricingPolicy } },
  });
  const input: OwnerInput = { ...membership, request, atTime, quote: quoteSnapshot, offer: profile.identity.offer, lineBindings, secondTotalMinor,
    price: { ...priceScope, lists, selectors, results }, policyHistory, phase: authority.phase,
    decisions: { ...decisions, promotions: [...decisions.promotions].sort((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1
      : a.revision < b.revision ? -1 : a.revision > b.revision ? 1 : 0), ...(authority.destination && { destination: authority.destination }) } };
  const owner = buildSelectedSubscriptionOwnerQuote(input);
  if (!owner.evidence.offer || canonical(owner.evidence.offer) !== canonical(profile.identity.offer)) return refuseSelected("membership");
  return { owner, quoteSnapshot };
}
