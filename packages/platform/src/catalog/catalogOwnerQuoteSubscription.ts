import {
  catalogAdmissionEvidenceSchema, catalogAdmissionHeadSchema, catalogAdmissionLinesSchema, catalogAdmissionRefSchema as ref,
} from "./catalogAdmissionSchema.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import { evidenceRef } from "./catalogOwnerQuoteEvidence.js";
import { z } from "./validation.js";
import {
  acquisitionCapabilitySchema, createCommerceQuoteSchemas, deriveSubscriptionUnitPrice, pricingPolicySnapshotSchema,
  projectAcquisitionTerms, quoteDigest, resolvedAcquisitionTermsSchema, subscriptionPricePolicyRevisionSchema, toGrossMinor,
} from "../pricing/index.js";

const ordinal = z.number().int().positive();
const quantity = ordinal.max(99);
const minor = z.number().int().nonnegative();
const currency = z.string().regex(/^[A-Z]{3}$/u);
const country = z.string().regex(/^[A-Z]{2}$/u);
const instant = z.iso.datetime({ offset: true });
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const window = { validFrom: instant, validTo: instant.nullable() };
const scope = { priceListId: z.guid(), regionCode: country, currency, channel: z.literal("D2C") };
const offer = z.object({ ref, version: ref }).strict();
const emptyCodes = z.tuple([]);
const shippingTerms = z.object({
  version: z.literal("shipping-threshold.v1"), currency, flatMinor: minor.max(2_147_483_647), freeThresholdMinor: minor.max(2_147_483_647),
}).strict().optional();
const quoteSchemas = createCommerceQuoteSchemas({ currencySchema: currency, productSlugSchema: ref, contextSchema: z.never() });
const component = quoteSchemas.quotePricingComponentSchema.safeExtend({
  reasonPayload: z.union([
    z.object({ variant_id: z.guid(), line_qty: quantity, base_unit_price_minor: minor }).strict(),
    z.object({ unit_delta_minor: z.number().int(), line_qty: quantity }).strict(),
    z.object({ promotion_id: ref, amount_off_minor: minor }).strict(),
    z.object({ applied_rule_id: ref.nullable(), carrier_kind: ref.nullable(), vat_rate_bps: minor }).strict(),
  ]),
});
const components = z.array(component).optional();
const quoteLine = quoteSchemas.quoteLineSchema.required({ catalogFacts: true }).safeExtend({ pricingComponents: components }).strict();
const mode = z.literal("subscription");
const pricedLine = z.object({ sku: ref, quantity, unitAmountMinor: minor, isAddon: z.boolean(), quoteLine }).strict();
const graduation = z.object({ cadenceDays: ordinal, lines: z.array(z.object({
  sku: ref, qty: quantity, sortOrder: minor, isAddon: z.boolean(), quoteLine,
}).strict()).min(1).max(50) }).strict();
const renewal = z.object({
  version: z.literal("native.renewal-terms.v1"), linePricing: z.array(pricedLine).min(1).max(50),
  shippingTerms, minimumPayableMinor: minor, normalCadenceDays: z.array(ordinal).min(1).max(50),
  starterPack: z.object({
    schemaVersion: z.literal("1"), starterIntervalDays: ordinal, basisTemplateVersion: ordinal,
    delivery2: z.object({ discountBps: minor.max(10_000), basisSubtotalMinor: minor, discountMinor: minor }).strict(),
    graduation,
  }).strict(),
}).strict();
const context = z.object({
  mode, cadenceDays: ordinal, promoCodes: emptyCodes, starterRequest: digest, atTime: instant.optional(),
  acquisitionCapability: acquisitionCapabilitySchema, pricingPolicy: pricingPolicySnapshotSchema,
  acquisitionTerms: resolvedAcquisitionTermsSchema, shippingTerms, starterRenewalTerms: renewal,
}).strict();
const quote = createCommerceQuoteSchemas({ currencySchema: currency, productSlugSchema: ref, contextSchema: context })
  .commerceQuoteSchema.safeExtend({ lines: z.array(quoteLine).length(2), context, pricingComponents: components }).strict();
const resultPrice = z.object({
  variantId: z.guid(), mode: z.enum(["one_time", "subscription"]), matchedMinQty: z.literal(1),
  unitPriceMinor: minor, amountKind: z.enum(["gross", "net"]), priceListId: z.guid(), priceEntryId: ref, resolvedAt: instant,
}).strict();
const roles = ["actual", "base", "comparison", "offer"] as const;
const selector = z.object({
  sourceOrdinal: ordinal, role: z.enum(roles), selectorKey: ref, declaringRef: ref,
  outcome: z.enum(["selected", "rejected"]), value: resultPrice, ...window,
}).strict();
const issue = catalogAdmissionHeadSchema.extend({
  kind: z.enum(["declaring", "compared"]), sourceOrdinal: ordinal, skuRevisionId: z.guid(),
}).strict();
const candidate = z.object({
  ref, revision: ref, ...window, decision: z.enum(["applied", "eligible", "ineligible"]),
}).strict();
const phase = z.discriminatedUnion("applicability", [
  z.object({ applicability: z.literal("absent") }).strict(),
  z.object({ applicability: z.literal("certified"), phaseDigest: digest, lineBindings: catalogAdmissionLinesSchema,
    basis: z.object({ templateRef: ref, templateVersion: ordinal, cadenceDays: ordinal }).strict() }).strict(),
]);
const contact = z.string().max(240).nullable();
const request = z.object({
  principalRef: z.guid(), clientId: z.guid(), ownerNamespace: ref, purpose: ref, acquisitionCapability: acquisitionCapabilitySchema,
  offerSelector: ref, mode, cadenceDays: ordinal, lines: z.array(z.object({ sku: ref, quantity }).strict()).length(2), promoCodes: emptyCodes,
  checkout: z.object({ configuration: ref, country, termsRevision: ref, firstName: contact, lastName: contact, phone: contact,
    line1: contact, line2: contact, city: contact, postalCode: contact, email: contact, purchaser: z.guid() }).strict(),
}).strict();
const selected = z.object({
  request, atTime: instant, quote: z.object({ contractVersion: z.literal("commerce.v0"), quote }).strict(),
  consultedHeads: z.array(catalogAdmissionHeadSchema).max(500).nullable(), issues: z.array(issue).max(500), offer: offer.optional(),
  lineBindings: catalogAdmissionLinesSchema.length(2), secondTotalMinor: minor,
  price: z.object({
    ...scope, lists: z.array(z.object({ priceListId: z.guid(), ...window }).strict()).max(500),
    selectors: z.array(selector).max(500), results: z.array(z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("subscription_legacy"), base: resultPrice, legacyResolved: resultPrice, unitPriceMinor: minor }).strict(),
      z.object({ kind: z.literal("subscription_policy"), base: resultPrice, policy: subscriptionPricePolicyRevisionSchema, unitPriceMinor: minor }).strict(),
    ])).length(2),
  }).strict().nullable(),
  policyHistory: z.array(subscriptionPricePolicyRevisionSchema).max(500),
  decisions: z.object({
    promotions: z.array(candidate).max(500), eligibilityRef: ref, claim: z.enum(["eligible", "ineligible"]),
    acquisitionPolicyRef: ref, taxRef: ref, shippingRef: ref,
    destination: z.object({ ref, digest }).strict().optional(),
  }).strict(), phase,
}).strict();

export type SelectedSubscriptionOwnerInput = z.input<typeof selected>;
type Selection = z.output<typeof selected>;
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const json = canonicalCatalogDraftJson;
const equal = (a: unknown, b: unknown) => json(a) === json(b);
const unique = (keys: string[]) => new Set(keys).size === keys.length;
const applicable = (from: string, to: string | null, at: string) =>
  Date.parse(from) <= Date.parse(at) && (to === null || Date.parse(at) < Date.parse(to));
const fail = (unavailable = false): never => {
  throw Object.assign(new Error(unavailable ? "Use a selection supported on this installation."
    : "Recover the original purchase evidence with its owner and replay the original request."), {
    code: unavailable ? "catalog_admission_price_context_required" : "catalog_admission_evidence_binding_mismatch",
  });
};

function facts({ atTime: _atTime, ...facts }: z.output<typeof quoteLine>["catalogFacts"]) { return facts; }
function priceValue({ resolvedAt: _resolvedAt, ...value }: z.output<typeof resultPrice>) { return value; }
function presentation({ catalogFacts: _facts, sku, productSlug, quantity, unitPriceGross, lineSubtotalGross, tax, pricingComponents }: z.output<typeof quoteLine>) {
  return { sku, productSlug, quantity, unitPriceGross, lineSubtotalGross, tax, pricingComponents: pricingComponents ?? [] };
}

function priceDecision(input: Selection, projected: Selection["quote"]["quote"]) {
  const { lists, selectors, results, ...scope } = input.price ?? fail(true);
  const { policyHistory, lineBindings, atTime } = input;
  const active = lists.filter(row => applicable(row.validFrom, row.validTo, atTime));
  const policies = policyHistory.filter(row => applicable(row.effectiveFrom, row.effectiveTo, atTime));
  if (active.length !== 1 || active[0]!.priceListId !== scope.priceListId || (policyHistory.length > 0 && policies.length !== 1)) fail(true);
  const policy = policies[0];
  if (!unique(lists.map(row => row.priceListId)) || !unique(policyHistory.map(row => row.id))
    || lists.some(row => row.validTo !== null && Date.parse(row.validTo) <= Date.parse(row.validFrom))
    || policyHistory.some(row => Object.entries(scope).some(([key, value]) => row[key as keyof typeof scope] !== value))
    || !unique(selectors.map(row => json([row.sourceOrdinal, row.role, row.selectorKey])))
    || selectors.some(row => row.value.resolvedAt !== row.validFrom || row.value.priceListId !== scope.priceListId
      || row.value.variantId !== lineBindings[row.sourceOrdinal - 1]?.skuId
      || (row.validTo !== null && Date.parse(row.validTo) <= Date.parse(row.validFrom)))) fail();
  for (const [index, result] of results.entries()) {
    const source = selectors.filter(row => row.sourceOrdinal === index + 1);
    const base = source.filter(row => row.role === "base");
    const actual = source.filter(row => row.role === "actual");
    const line = projected.lines[index]!, identity = line.catalogFacts;
    const resolved = result.kind === "subscription_legacy" ? result.legacyResolved : result.base;
    if (base.length !== 1 || actual.length !== 1 || result.base.mode !== "one_time" || result.base.amountKind !== "gross"
      || ![base[0]!, actual[0]!].every(row => row.outcome === "selected" && applicable(row.validFrom, row.validTo, atTime))
      || source.some(row => (row.role === "comparison" || row.role === "offer") && row.outcome !== "rejected")
      || !equal(priceValue(base[0]!.value), priceValue(result.base)) || !equal(priceValue(actual[0]!.value), priceValue(resolved))
      || identity.basePriceEntryId !== result.base.priceEntryId || identity.baseUnitAmountMinor !== result.base.unitPriceMinor
      || identity.resolvedUnitAmountMinor !== line.unitPriceGross.amountMinor || identity.resolvedLineAmountMinor !== line.lineSubtotalGross.amountMinor
      || toGrossMinor({ ...resolved, unitPriceMinor: result.unitPriceMinor }, line.tax.vatRateBps) !== identity.resolvedUnitAmountMinor
      || (policy ? result.kind !== "subscription_policy" || !equal(result.policy, policy) || identity.version !== "catalog_facts_v2"
        || identity.policyRevisionId !== policy.id || identity.policyDigest !== policy.digest
        || result.unitPriceMinor !== deriveSubscriptionUnitPrice(result.base.unitPriceMinor, policy)
        : result.kind !== "subscription_legacy" || resolved.mode !== "subscription" || identity.version !== "catalog_facts_v1"
          || identity.resolvedPriceEntryId !== resolved.priceEntryId || result.unitPriceMinor !== resolved.unitPriceMinor)) fail();
  }
  const priceRows = [...selectors].sort((a, b) => a.sourceOrdinal - b.sourceOrdinal
    || roles.indexOf(a.role) - roles.indexOf(b.role) || order(a.selectorKey, b.selectorKey))
    .map(({ value, ...row }) => ({ ...row, value: priceValue(value) }));
  return {
    priceEvidenceRef: evidenceRef("price.v1", { scope, lists: [...lists].sort((a, b) => order(a.priceListId, b.priceListId)), selectors: priceRows,
      facts: projected.lines.map(line => facts(line.catalogFacts)) }),
    policyEvidenceRef: evidenceRef("policy.v1", { scope, applicability: policy ? "applies" : "not_applicable", selected: policy ?? null,
      history: [...policyHistory].sort((a, b) => order(a.id, b.id)) }),
  };
}

function renewalProjection(input: Selection, projected: Selection["quote"]["quote"]) {
  const { linePricing, starterPack, shippingTerms, version, minimumPayableMinor, normalCadenceDays } = projected.context.starterRenewalTerms;
  const { graduation, delivery2, schemaVersion, starterIntervalDays, basisTemplateVersion } = starterPack;
  const copyMatches = (line: z.output<typeof quoteLine>, original: z.output<typeof quoteLine>) =>
    equal(facts(line.catalogFacts), facts(original.catalogFacts)) && equal(presentation(line), presentation(original));
  if (linePricing.length !== projected.lines.length || graduation.lines.length !== linePricing.length
    || !equal(shippingTerms ?? null, projected.context.shippingTerms ?? null) || !normalCadenceDays.includes(graduation.cadenceDays)
    || starterIntervalDays !== projected.context.cadenceDays || delivery2.discountBps !== projected.context.acquisitionTerms.delivery2DiscountBps
    || delivery2.basisSubtotalMinor !== projected.subtotalGross.amountMinor || delivery2.discountMinor > delivery2.basisSubtotalMinor
    || linePricing.some((row, index) => {
      const binding = input.lineBindings[index]!, line = projected.lines[index]!;
      return row.sku !== line.sku || row.quantity !== line.quantity || row.unitAmountMinor !== line.unitPriceGross.amountMinor
        || row.isAddon !== (binding.role === "addon") || !copyMatches(row.quoteLine, line);
    }) || graduation.lines.some((row, index) => {
      const retained = linePricing[index]!, certificate = input.phase.applicability === "certified" ? input.phase.lineBindings[index] : undefined;
      return row.sortOrder !== index || row.sku !== retained.sku || row.qty !== retained.quantity || !copyMatches(row.quoteLine, retained.quoteLine)
        || (certificate && (certificate.skuCode !== row.sku || certificate.skuId !== row.quoteLine.catalogFacts.skuId
          || certificate.quantity !== row.qty || certificate.mode !== "subscription" || (certificate.role === "addon") !== row.isAddon));
    }) || (input.phase.applicability === "certified" && (input.phase.lineBindings.length !== graduation.lines.length
      || input.phase.basis.cadenceDays !== graduation.cadenceDays || input.phase.basis.templateVersion !== basisTemplateVersion))) fail();
  return { version, shippingTerms: shippingTerms ?? null, minimumPayableMinor, normalCadenceDays,
    linePricing: linePricing.map(({ sku, quantity, unitAmountMinor, isAddon, quoteLine }) => ({ sku, quantity, unitAmountMinor, isAddon, quoteLine: presentation(quoteLine) })),
    starterPack: { schemaVersion, starterIntervalDays, basisTemplateVersion, delivery2,
      graduation: { cadenceDays: graduation.cadenceDays, lines: graduation.lines.map(({ sku, qty, sortOrder, isAddon, quoteLine }) =>
        ({ sku, qty, sortOrder, isAddon, quoteLine: presentation(quoteLine) })) } }, phase: input.phase };
}

function reviewedProjection(input: Selection, quote: Selection["quote"]["quote"], issues: Selection["issues"]) {
  const { lines, discounts, pricingComponents, subtotalGross, discountTotalGross, shippingGross, shippingDiscountGross,
    totalGross, netTotal, taxTotal, currency, taxIncluded, context } = quote;
  return {
    lines: lines.map(line => ({ ...presentation(line), baseUnitMinor: line.catalogFacts.baseUnitAmountMinor })),
    discounts, pricingComponents: pricingComponents ?? [], subtotalGross, discountTotalGross, shippingGross: shippingGross ?? null,
    shippingDiscountGross: shippingDiscountGross ?? null, totalGross, netTotal, taxTotal, currency, taxIncluded,
    mode: context.mode, cadenceDays: context.cadenceDays, acquisitionTerms: projectAcquisitionTerms(context.acquisitionTerms),
    shippingTerms: context.shippingTerms ?? null, secondTotalMinor: input.secondTotalMinor,
    ownerDecisions: { ...input.decisions, issues, acquisitionPromotionRef: context.acquisitionTerms.sourcePromotionId,
      offerPolicyVersion: context.pricingPolicy.offerPolicyVersion, promotionEngineVersion: context.pricingPolicy.promotionEngineVersion },
  };
}

/**
 * Selected owner field paths
 *
 * | Owner input | Bound paths |
 * | --- | --- |
 * | Verified principal/client, namespace, purpose and original selection | Separate signed request, including checkout configuration, country, terms revision and allowlisted contact from its owner. |
 * | v0 quote lines, discounts, components, tax, shipping and totals | Reviewed projection, with rendered cadence and second payable and a separate owner-decision member. |
 * | Quote lines, retained linePricing and graduation quoteLine copies | Lift exact matching catalogFacts to price evidence, excluding only each atTime. |
 * | Timed list, actual/base/comparison/offer rows and policy history | Tagged price/policy evidence, retaining raw windows once and dropping result resolvedAt. |
 * | Membership/publication | Current heads by product, issue identities by role and source, selected offer and ordered source bindings. |
 * | Retained starterRenewalTerms and scoped phase owner | Version, line prices and roles, shipping, payable floor, cadence, delivery2 and independently certified graduation. |
 * | Scoped promotion, tax, shipping and destination owners | Private decisions and exact retained destination pair when supplied. |
 */
export type SelectedSubscriptionOwnerPreimage = {
  reviewedProjection: ReturnType<typeof reviewedProjection>;
  consultedHeads: NonNullable<Selection["consultedHeads"]>;
  offer?: Selection["offer"];
  lineBindings: Selection["lineBindings"];
  priceEvidenceRef: string;
  policyEvidenceRef: string;
  renewalTerms: ReturnType<typeof renewalProjection>;
};

export function buildSelectedSubscriptionOwnerQuote(raw: SelectedSubscriptionOwnerInput) {
  let input: Selection;
  try {
    const original = json(raw);
    input = selected.parse(raw);
    if (original !== json(input)) fail();
  } catch { return fail(); }
  const { request, consultedHeads, lineBindings, offer, phase } = input;
  const projected = input.quote.quote;
  if (consultedHeads === null || input.price === null) return fail(true);
  const heads = [...consultedHeads].sort((a, b) => order(a.productId, b.productId));
  const headsByProduct = new Map(heads.map(head => [head.productId, head]));
  const issues = [...input.issues].sort((a, b) => a.sourceOrdinal - b.sourceOrdinal || order(a.kind, b.kind)
    || order(a.productId, b.productId) || order(a.publicationId, b.publicationId) || order(a.skuRevisionId, b.skuRevisionId));
  const governed = lineBindings.find(line => line.source === "fresh");
  if (!governed || governed.source !== "fresh" || !lineBindings.some(line => line.source === "legacy")) return fail();
  const declaring = issues.filter(row => row.kind === "declaring");
  if (declaring.length !== 1 || declaring[0]!.sourceOrdinal !== governed.sourceOrdinal || declaring[0]!.skuRevisionId !== governed.skuRevisionId
    || headsByProduct.size !== heads.length || !unique(issues.map(row => json([row.kind, row.sourceOrdinal, row.publicationId, row.skuRevisionId])))
    || issues.some(row => {
      const head = headsByProduct.get(row.productId);
      return !lineBindings[row.sourceOrdinal - 1] || !head || (head.publicationId === row.publicationId
        && (head.revision !== row.revision || head.documentDigest !== row.documentDigest));
    })
    || !unique(lineBindings.map(line => line.skuId)) || !unique(lineBindings.map(line => line.skuCode))
    || request.clientId !== request.checkout.purchaser || request.checkout.country !== input.price.regionCode
    || request.cadenceDays !== projected.context.cadenceDays || input.price.currency !== projected.currency
    || !unique(input.decisions.promotions.map(row => json([row.ref, row.revision])))
    || projected.codeRejections?.length || projected.codeRejectionDetails?.length
    || lineBindings.some((row, index) => {
      const line = projected.lines[index]!, selected = request.lines[index]!;
      return row.mode !== "subscription" || line.catalogFacts.mode !== row.mode || line.catalogFacts.currency !== projected.currency
        || row.skuId !== line.catalogFacts.skuId || row.skuCode !== line.sku || line.sku !== selected.sku
        || row.quantity !== line.quantity || line.quantity !== selected.quantity;
    })) return fail();
  const renewalTerms = renewalProjection(input, projected);
  try {
    const { priceEvidenceRef, policyEvidenceRef } = priceDecision(input, projected);
    const document: SelectedSubscriptionOwnerPreimage = {
      reviewedProjection: reviewedProjection(input, projected, issues), consultedHeads: heads,
      ...(offer ? { offer } : {}), lineBindings, priceEvidenceRef, policyEvidenceRef, renewalTerms,
    };
    const destination = input.decisions.destination;
    const evidence = catalogAdmissionEvidenceSchema.parse({
      moneyVersion: "v0", quoteDigest: quoteDigest("catalog.owner-quote.v0", document),
      consultedHeads: heads, ...(offer ? { offer } : {}), lineBindings, priceEvidenceRef, policyEvidenceRef,
      ...(destination ? { destinationRef: destination.ref, destinationDigest: destination.digest } : {}),
      ...(phase.applicability === "certified" ? { graduation: { phaseDigest: phase.phaseDigest, lineBindings: phase.lineBindings } } : {}),
    });
    return { requestBinding: request, document, evidence };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "catalog_admission_price_context_required") throw error;
    return fail();
  }
}
