import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { createCommerceQuoteHandler } from "./commerceQuoteHandler.js";

import { createQuoteResponseSchema, publicCreateQuoteResponseSchema, type CreateQuoteRequest } from "../../../src/domains/commerce/contracts.js";
import { OFFER_POLICY_V2, PROMOTION_ENGINE_V2 } from "../../../src/domains/commerce/offerPolicyContracts.js";
import type { CreateQuoteOptions } from "../../../src/domains/commerce/ports.js";
import type {
  CommerceQuote,
  CommerceQuoteDiscount,
  CommerceQuoteLine,
} from "../../../src/domains/commerce/types.js";
import type { CommercePriceAuthorityPort } from "../../../src/domains/pricing/ports.js";
import type { ResolvedPrice } from "../../../src/domains/pricing/types.js";
import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import { buildQuoteRequest } from "./commerceCheckoutOrchestrationHelpers.js";
import { intent as intentFixture } from "./commerceCheckoutHandler.testFixtures.js";
import type { CommerceQuoteCatalogReadPort } from "./commerceQuoteCatalogReadPort.js";
import { createDbBackedCommerceQuotePort } from "./dbBackedCommerceQuotePort.js";
import type { CommercePromoDataPort } from "./promoDataPort.js";
import type { PromotionCodeQuotePort, ResolvedPromotionCodeCandidate } from "./promotionCodeQuotePort.js";
import {
  issuePromotionQuoteAcceptanceWithOutcome,
  verifyPromotionQuoteAcceptanceWithOutcome,
} from "./promotionQuoteAcceptance.js";
import {
  projectPromotionQuoteMoney,
  stableJson,
  type PromotionQuoteMismatchField,
} from "./promotionQuoteBinding.js";

const NOW = new Date("2026-09-09T10:00:00.000Z");
const KEYRING = { current: "z".repeat(48) };
const provisioning = { petId: null };
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const CODE = "5AQR2FNACETE6JG7";
const SHIPPING_FLAT_MINOR = 1_500;
const QUOTE_OPTIONS = {
  clientId: CLIENT_ID,
  pricingPolicy: { offerPolicyVersion: OFFER_POLICY_V2, promotionEngineVersion: PROMOTION_ENGINE_V2 },
} as CreateQuoteOptions;

const LINES = [
  { sku: "opaque:canned-beef.v1", variantId: "variant-beef-400", unitPriceMinor: 1_090 },
  { sku: "opaque:canned-chicken.v1", variantId: "variant-chicken-400", unitPriceMinor: 1_090 },
  { sku: "opaque:canned-lamb.v1", variantId: "variant-lamb-400", unitPriceMinor: 1_190 },
  { sku: "opaque:canned-turkey.v1", variantId: "variant-turkey-400", unitPriceMinor: 1_190 },
  { sku: "opaque:canned-duck.v1", variantId: "variant-duck-400", unitPriceMinor: 1_290 },
  { sku: "opaque:canned-fish.v1", variantId: "variant-fish-400", unitPriceMinor: 1_290 },
];

type QuoteMutation = (quote: CommerceQuote) => CommerceQuote;
type QuoteMode = "one_time" | "subscription";
type QuoteBenefit = Pick<ResolvedPromotionCodeCandidate, "kind" | "lane"> & { valueBps?: number; valueMinor?: number };
const BENEFITS: QuoteBenefit[] = [
  { lane: "product", kind: "target_percentage", valueBps: 8_000 },
  { lane: "product", kind: "fixed_amount", valueMinor: 500 },
  { lane: "shipping", kind: "percentage", valueBps: 5_000 },
  { lane: "shipping", kind: "fixed_amount", valueMinor: 500 },
  { lane: "shipping", kind: "free_shipping" },
];

/**
 * Presentation, provenance and evaluation-context fields the acceptance token
 * deliberately does NOT bind. Each is applied to the checkout side alone.
 */
const PRESENTATION_MUTATIONS: Array<[string, QuoteMutation]> = [
  ["discount label", (quote) => patchDiscount(quote, { label: "  Zimowa promocja  " })],
  ["discount customerSemantic", (quote) => patchDiscount(quote, { customerSemantic: "first_purchase_10" })],
  ["discount code", (quote) => patchDiscount(quote, { code: "5aqr2fnacete6jg7" })],
  ["promotionCodeRevision", (quote) => patchDiscount(quote, { promotionCodeRevision: 97 })],
  ["promotionCodeScopes", (quote) => patchDiscount(quote, { promotionCodeScopes: ["subscription_initial"] })],
  ["promotionMinimumReferenceMinor", (quote) => patchDiscount(quote, { promotionMinimumReferenceMinor: 9_999 })],
  ["promotionCodeValidTo", (quote) => patchDiscount(quote, { promotionCodeValidTo: "2099-01-01T00:00:00.000Z" })],
  ["floorApplied", (quote) => patchDiscount(quote, { floorApplied: true })],
  ["line pricingComponents", (quote) => patchLine(quote, { pricingComponents: [] })],
  ["quote pricingComponents", (quote) => ({ ...clone(quote), pricingComponents: [] })],
  ["quote context", (quote) => ({ ...clone(quote), context: undefined })],
  ["codeRejections", (quote) => ({
    ...clone(quote),
    codeRejections: [{ code: "OTHER80", reason: "not_recognized" as const }],
  })],
  ["codeRejectionDetails", (quote) => ({
    ...clone(quote),
    codeRejectionDetails: [{ code: "OTHER80", reason: "scope_not_applicable" as const, allowedScopes: ["one_time" as const] }],
  })],
];

/** Every amount the customer pays. Each names the section it broke. */
const MONEY_MUTATIONS: Array<[string, PromotionQuoteMismatchField, QuoteMutation]> = [
  ["line unitPriceGross", "lines", (quote) => patchLine(quote, {
    unitPriceGross: { amountMinor: 1_091, currency: quote.currency },
  })],
  ["line lineSubtotalGross", "lines", (quote) => patchLine(quote, {
    lineSubtotalGross: { amountMinor: 1_091, currency: quote.currency },
  })],
  ["line quantity", "lines", (quote) => patchLine(quote, { quantity: 2 })],
  ["line tax vatRateBps", "lines", (quote) => {
    const next = clone(quote);
    next.lines[0]!.tax.vatRateBps = 500;
    return next;
  }],
  ["discount amountOffMinor", "discounts", (quote) => patchDiscount(quote, { amountOffMinor: 1 })],
  ["shippingGross", "shipping", (quote) => ({
    ...clone(quote), shippingGross: { amountMinor: 1, currency: quote.currency },
  })],
  ["shippingDiscountGross", "shipping", (quote) => ({
    ...clone(quote), shippingDiscountGross: { amountMinor: 1, currency: quote.currency },
  })],
  ["totalGross", "totals", (quote) => ({
    ...clone(quote), totalGross: { ...quote.totalGross, amountMinor: quote.totalGross.amountMinor + 1 },
  })],
  ["netTotal", "totals", (quote) => ({
    ...clone(quote), netTotal: { ...quote.netTotal, amountMinor: quote.netTotal.amountMinor + 1 },
  })],
  ["taxTotal", "totals", (quote) => ({
    ...clone(quote), taxTotal: { ...quote.taxTotal, amountMinor: quote.taxTotal.amountMinor + 1 },
  })],
  ["subtotalGross", "totals", (quote) => ({
    ...clone(quote), subtotalGross: { ...quote.subtotalGross, amountMinor: quote.subtotalGross.amountMinor + 1 },
  })],
  ["discountTotalGross", "totals", (quote) => ({
    ...clone(quote), discountTotalGross: { ...quote.discountTotalGross, amountMinor: 1 },
  })],
  ["currency", "currency", (quote) => ({ ...clone(quote), currency: "EUR" as CommerceQuote["currency"] })],
];

/** Which promotion granted the money, and what it applies to. */
const IDENTITY_MUTATIONS: Array<[string, QuoteMutation]> = [
  ["promotionId", (quote) => patchDiscount(quote, { promotionId: "99999999-9999-4999-8999-999999999999" })],
  ["promotionCodeId", (quote) => patchDiscount(quote, { promotionCodeId: "88888888-8888-4888-8888-888888888888" })],
  ["promotionDefinitionFingerprint", (quote) => patchDiscount(quote, { promotionDefinitionFingerprint: "c".repeat(64) })],
  ["appliesTo", (quote) => patchDiscount(quote, { appliesTo: "shipping" })],
];

describe("promotion acceptance across the quote route and the checkout guard", () => {
  it("accepts a route-issued token against the checkout guard's authoritative quote", async () => {
    const { issued, authoritative, outcome } = await crossSurface();

    // The exact production asymmetry: the quote route signs the public projection
    // (catalogFacts stripped by projectPublicQuoteSnapshot), the checkout guard
    // verifies the raw server-authoritative quote, which carries them.
    expect(issued.lines.every((line) => !("catalogFacts" in line))).toBe(true);
    expect(authoritative.lines.every((line) => line.catalogFacts !== undefined)).toBe(true);

    if (!outcome.accepted) {
      // Diagnostic: the same projection quoteBinding() hashes, diffed by JSON path.
      // eslint-disable-next-line no-console
      console.error("QUOTE_BINDING_DIFF", JSON.stringify(
        diffPaths(bindingInput(issued), bindingInput(authoritative)), null, 2));
    }
    expect(outcome).toEqual(expect.objectContaining({ accepted: true, reason: "accepted" }));
    expect(diffPaths(bindingInput(issued), bindingInput(authoritative))).toEqual([]);
  });

  for (const mode of ["one_time", "subscription"] as const) {
    for (const surface of ["anonymous", "account"] as const) {
      it.each(BENEFITS)(`${surface} ${mode} accepts $lane/$kind across surfaces`, async (benefit) => {
        const port = quotePort("Promo v2", benefit);
        const request = quoteRequest(mode);
        const issued = createQuoteResponseSchema.parse(await port.createQuote(request, {
          ...QUOTE_OPTIONS, clientId: surface === "account" ? CLIENT_ID : undefined,
        }));
        const { token } = issuePromotionQuoteAcceptanceWithOutcome({
          request, quote: issued.quote, keyring: KEYRING, now: NOW,
        });
        expect(token).not.toBeNull();
        const checkoutRequest = buildQuoteRequest(configuratorIntent(mode), provisioning);
        const authoritative = await port.createServerAuthoritativeQuote!(checkoutRequest, QUOTE_OPTIONS);
        expect(verifyPromotionQuoteAcceptanceWithOutcome({
          token: token!, request: checkoutRequest, quote: authoritative.quote,
          expectedTotal: issued.quote.totalGross, keyring: KEYRING, now: NOW,
        })).toMatchObject({ accepted: true, reason: "accepted" });
      });
    }
  }

  it("accepts when the checkout side parses the authoritative quote through the same contract", async () => {
    const port = quotePort();
    const request = quoteRequest();

    const issued = createQuoteResponseSchema.parse(await port.createQuote(request, QUOTE_OPTIONS));
    const { token } = issuePromotionQuoteAcceptanceWithOutcome({
      request, quote: issued.quote, keyring: KEYRING, now: NOW,
    });
    const authoritative = createQuoteResponseSchema.parse(
      await port.createServerAuthoritativeQuote!(request, QUOTE_OPTIONS));

    expect(verifyPromotionQuoteAcceptanceWithOutcome({
      token: token!,
      request,
      quote: authoritative.quote,
      expectedTotal: issued.quote.totalGross,
      keyring: KEYRING,
      now: NOW,
    })).toEqual(expect.objectContaining({ accepted: true }));
  });

  it("keeps acceptance when the checkout guard builds its own quote request", async () => {
    const port = quotePort();
    const publicRequest = quoteRequest();
    const checkoutRequest = buildQuoteRequest(configuratorIntent(), provisioning);

    const issued = createQuoteResponseSchema.parse(await port.createQuote(publicRequest, QUOTE_OPTIONS));
    const { token } = issuePromotionQuoteAcceptanceWithOutcome({
      request: publicRequest, quote: issued.quote, keyring: KEYRING, now: NOW,
    });
    const authoritative = await port.createServerAuthoritativeQuote!(checkoutRequest, QUOTE_OPTIONS);

    expect(verifyPromotionQuoteAcceptanceWithOutcome({
      token: token!, request: checkoutRequest, quote: authoritative.quote,
      expectedTotal: issued.quote.totalGross, keyring: KEYRING, now: NOW,
    })).toEqual(expect.objectContaining({ accepted: true }));
  });

  // Was the `.trim()` reproduction: a promotion whose DB `name` carries surrounding
  // whitespace is trimmed by `quoteDiscountSchema` on the quote route and not on the
  // checkout side. It is now one presentation difference among many, and accepted.
  it("accepts a v2 checkout when the contract normalises a presentation field", async () => {
    const { outcome } = await crossSurface({ promotionName: "  Zimowa promocja  " });

    expect(outcome).toEqual(expect.objectContaining({ accepted: true, reason: "accepted" }));
  });

  it.each(PRESENTATION_MUTATIONS)("accepts when only %s differs on the checkout side", async (_name, mutate) => {
    const { outcome } = await crossSurface({ mutate });

    expect(outcome).toEqual(expect.objectContaining({ accepted: true, reason: "accepted" }));
  });

  // `reasonCode` is not bound either, but it is what marks a discount as v2
  // evidence, so removing it trips the separate `no_v2_adjustment_in_quote`
  // guard rather than the binding. The projection proves the binding ignored it.
  it("does not bind a discount reasonCode", async () => {
    const { authoritative, outcome } = await crossSurface({
      mutate: (quote) => patchDiscount(quote, { reasonCode: "promotion_code_v1" }),
    });

    expect(bindingInput(patchDiscount(authoritative, { reasonCode: "promotion_code_v1" })))
      .toEqual(bindingInput(authoritative));
    expect(outcome).toEqual(expect.objectContaining({
      accepted: false, reason: "no_v2_adjustment_in_quote",
    }));
  });

  it.each(MONEY_MUTATIONS)("rejects when %s changes, naming the %s section", async (_name, section, mutate) => {
    const { outcome } = await crossSurface({ mutate });

    expect(outcome).toEqual(expect.objectContaining({
      accepted: false, reason: "quote_mismatch", mismatchField: section,
    }));
  });

  it.each(IDENTITY_MUTATIONS)("rejects when the discount identity field %s changes", async (_name, mutate) => {
    const { outcome } = await crossSurface({ mutate });

    expect(outcome).toEqual(expect.objectContaining({
      accepted: false, reason: "quote_mismatch", mismatchField: "discounts",
    }));
  });

  it("refreshes an actual legacy whole-quote token before strict checkout accepts it", async () => {
    const port = quotePort();
    const request = quoteRequest();
    const issued = createQuoteResponseSchema.parse(await port.createQuote(request, QUOTE_OPTIONS));
    const { token } = issuePromotionQuoteAcceptanceWithOutcome({
      request, quote: issued.quote, keyring: KEYRING, now: NOW,
    });
    const legacyToken = legacyWholeQuoteToken(token!, issued.quote);
    const authoritative = await port.createServerAuthoritativeQuote!(request, QUOTE_OPTIONS);
    const verify = (candidate: string, quote = authoritative.quote) =>
      verifyPromotionQuoteAcceptanceWithOutcome({
        token: candidate, request, quote, expectedTotal: issued.quote.totalGross,
        keyring: KEYRING, now: NOW,
      });
    expect(verify(legacyToken)).toMatchObject({
      accepted: false, reason: "quote_mismatch", mismatchField: "other",
    });
    const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
    vi.mocked(res.status).mockReturnValue(res);
    const honor = vi.fn((candidate: string, _request: CreateQuoteRequest, quote: CommerceQuote) =>
      verify(candidate, quote).accepted);
    await createCommerceQuoteHandler({
      quotePort: port,
      resolvePricingPolicy: () => QUOTE_OPTIONS.pricingPolicy,
      honorPromotionAcceptance: honor,
      createPromotionAcceptance: (canonicalRequest, quote) => issuePromotionQuoteAcceptanceWithOutcome({
        request: canonicalRequest, quote, keyring: KEYRING, now: NOW,
      }).token,
    })({ method: "POST", body: { ...request, promotionAcceptanceToken: legacyToken } } as VercelRequest, res);
    expect(honor).toHaveReturnedWith(false);
    expect(res.status).toHaveBeenCalledWith(200);
    const response = vi.mocked(res.json).mock.calls[0]![0] as { data: unknown };
    const refreshed = publicCreateQuoteResponseSchema.parse(response.data).promotionAcceptanceToken!;
    expect(refreshed).not.toBe(legacyToken);
    expect(verify(refreshed)).toMatchObject({ accepted: true, reason: "accepted" });
  });
});

async function crossSurface(options: { promotionName?: string; mutate?: QuoteMutation } = {}) {
  const port = quotePort(options.promotionName);
  const request = quoteRequest();
  const issued = createQuoteResponseSchema.parse(await port.createQuote(request, QUOTE_OPTIONS));
  const { token } = issuePromotionQuoteAcceptanceWithOutcome({
    request, quote: issued.quote, keyring: KEYRING, now: NOW,
  });
  expect(token).not.toBeNull();
  const authoritative = await port.createServerAuthoritativeQuote!(request, QUOTE_OPTIONS);
  return {
    issued: issued.quote,
    authoritative: authoritative.quote,
    outcome: verifyPromotionQuoteAcceptanceWithOutcome({
      token: token!,
      request,
      quote: options.mutate ? options.mutate(authoritative.quote) : authoritative.quote,
      expectedTotal: issued.quote.totalGross,
      keyring: KEYRING,
      now: NOW,
    }),
  };
}

/** Frozen pre-PR binding from main 462db3c4, including the old whole-quote hash. */
function legacyWholeQuoteToken(token: string, quote: CommerceQuote): string {
  const [encoded] = token.split(".");
  const { sectionBindings: _sectionBindings, ...payload } = JSON.parse(
    Buffer.from(encoded!, "base64url").toString("utf8"));
  const { codeRejectionDetails: _details, ...withoutDetails } = quote;
  payload.quoteBinding = createHmac("sha256", KEYRING.current).update(stableJson({
    ...withoutDetails,
    context: quote.context ? {
      mode: quote.context.mode, cadenceDays: quote.context.cadenceDays ?? null,
      sizeConstraint: quote.context.sizeConstraint ?? null,
    } : null,
    discounts: quote.discounts.map(({ code: _code, ...discount }) => discount),
    codeRejections: quote.codeRejections?.map((rejection) => rejection.reason) ?? [],
  })).digest("hex");
  const next = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${next}.${createHmac("sha256", KEYRING.current).update(next).digest("base64url")}`;
}

function clone(quote: CommerceQuote): CommerceQuote {
  return structuredClone(quote);
}

function patchDiscount(quote: CommerceQuote, patch: Partial<CommerceQuoteDiscount>): CommerceQuote {
  const next = clone(quote);
  next.discounts = next.discounts.map((discount, index) => index === 0 ? { ...discount, ...patch } : discount);
  return next;
}

function patchLine(quote: CommerceQuote, patch: Partial<CommerceQuoteLine>): CommerceQuote {
  const next = clone(quote);
  next.lines = next.lines.map((line, index) => index === 0 ? { ...line, ...patch } : line);
  return next;
}

/** The exact reduction quoteBinding() hashes. */
function bindingInput(quote: CommerceQuote): Record<string, unknown> {
  return projectPromotionQuoteMoney(quote) as unknown as Record<string, unknown>;
}

function diffPaths(left: unknown, right: unknown, path = "$", out: string[] = []): string[] {
  const isObject = (value: unknown) => value !== null && typeof value === "object";
  if (!isObject(left) || !isObject(right) || Array.isArray(left) !== Array.isArray(right)) {
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      out.push(`${path}: issued=${JSON.stringify(left)} authoritative=${JSON.stringify(right)}`);
    }
    return out;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = new Set([
    ...Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined),
    ...Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined),
  ]);
  for (const key of keys) {
    const l = leftRecord[key];
    const r = rightRecord[key];
    if (l === undefined || r === undefined) {
      out.push(`${path}.${key}: issued=${JSON.stringify(l)} authoritative=${JSON.stringify(r)}`);
      continue;
    }
    diffPaths(l, r, `${path}.${key}`, out);
  }
  return out;
}

function quotePort(promotionName = "Promo v2", benefit?: QuoteBenefit) {
  return createDbBackedCommerceQuotePort({
    quoteCatalogReadPort: quoteCatalogReadPort(),
    commercePriceAuthorityPort: commercePriceAuthorityPort(),
    promoDataPort: promoDataPort(),
    promotionCodeQuotePort: promotionCodeQuotePort(promotionName, benefit),
    commerceSettingsPort: { getShippingFlatMinor: async () => SHIPPING_FLAT_MINOR },
    regionCode: "GLOBAL",
    now: () => NOW.toISOString(),
  });
}

function configuratorIntent(mode: QuoteMode = "one_time"): ConfiguratorIntent {
  return {
    ...intentFixture(mode),
    cadenceDays: mode === "subscription" ? 28 : null,
    promoCodes: [CODE],
    visitorId: "visitor-9f2c1b7d",
    sizeConstraint: { kind: "unit_count", value: LINES.length },
    contact: { firstName: "Anna", lastName: "Kowalska", email: "buyer@example.com", phone: "+48123456789" },
    selectedFlavorSlugs: LINES.map((_line, index) => `canned-${index}`),
    selectedVariants: LINES.map((line, index) => ({
      variantId: line.variantId, sku: line.sku, flavorSlug: `canned-${index}`, qty: 1,
    })),
  } as ConfiguratorIntent;
}

function quoteRequest(mode: QuoteMode = "one_time"): CreateQuoteRequest {
  return {
    // Shaped exactly as src/checkout/machine/useLiveQuoteRequest.ts builds it.
    mode,
    cadenceDays: mode === "subscription" ? 28 : null,
    sizeConstraint: { kind: "unit_count", value: LINES.length },
    petProfileContext: { dailyKcalOverride: 328 },
    promoCodes: [CODE],
    lines: LINES.map((line) => ({
      sku: line.sku, quantity: 1, variantId: line.variantId, modeAtLine: mode,
    })),
    visitorId: "visitor-9f2c1b7d",
    customerEligibilityContext: { email: "buyer@example.com" },
  } as CreateQuoteRequest;
}

function quoteCatalogReadPort(): CommerceQuoteCatalogReadPort {
  return {
    listQuoteCatalogItems: async () => LINES.map((line, index) => ({
      skuId: `5${index}000000-0000-4000-8000-000000000000`,
      skuCode: line.sku,
      variantId: line.variantId,
      productSlug: `canned-${index}`,
      netWeightG: 400,
      energyPer100g: null,
      allergenSlugs: [],
      isPrimarySku: true,
      isAddon: false,
      sellability: { oneTime: true, subscription: true },
      documentRevision: {
        id: `6${index}000000-0000-4000-8000-000000000000`,
        digest: `${index}`.repeat(64),
      },
    })),
  };
}

function commercePriceAuthorityPort(): CommercePriceAuthorityPort {
  return {
    resolvePrice: vi.fn(async (query) => {
      const line = LINES.find((candidate) => candidate.variantId === query.variantId);
      if (!line) throw new Error(`no fixture price for ${query.variantId}`);
      const base: ResolvedPrice = {
        variantId: line.variantId,
        mode: "one_time",
        matchedMinQty: 1,
        unitPriceMinor: line.unitPriceMinor,
        amountKind: "gross",
        priceListId: "list-default",
        priceEntryId: `price-${line.variantId}`,
        resolvedAt: NOW.toISOString(),
      };
      if (query.mode === "subscription") return {
        kind: "subscription_policy" as const, base,
        unitPriceMinor: Math.floor(base.unitPriceMinor * 0.9 / 10) * 10,
        policy: {
          id: "77777777-7777-4777-8777-777777777777", revisionNo: 1,
          priceListId: "88888888-8888-4888-8888-888888888888",
          regionCode: query.regionCode, currency: query.currency, channel: query.channel,
          discountBps: 1_000, roundingQuantumMinor: 10, roundingRule: "FLOOR_TO_QUANTUM" as const,
          effectiveFrom: NOW.toISOString(), effectiveTo: null, digest: "d".repeat(64),
        },
      };
      return { kind: "one_time" as const, base, unitPriceMinor: base.unitPriceMinor };
    }),
  };
}

function promoDataPort(): CommercePromoDataPort {
  return {
    listActivePromotions: async () => [],
    countPaidOrders: async () => 0,
    countPaidOrdersByMode: async () => ({ oneTime: 0, subscription: 0 }),
    redemptionCounts: async () => new Map(),
    deviceFirstOrderRedeemed: async () => false,
  };
}

function promotionCodeQuotePort(
  promotionName: string,
  benefit: QuoteBenefit = BENEFITS[0]!,
): PromotionCodeQuotePort {
  const candidate = {
    promotionId: "22222222-2222-4222-8222-222222222222",
    codeId: "11111111-1111-4111-8111-111111111111",
    code: CODE,
    codeRevision: 1,
    definitionFingerprint: "b".repeat(64),
    minimumReferenceMinor: 0,
    validTo: null,
    name: promotionName,
    source: "code",
    scopes: ["one_time", "subscription_initial"],
    ...benefit,
  } as unknown as ResolvedPromotionCodeCandidate;
  return {
    resolve: vi.fn(async () => ({ candidates: [candidate], codeRejections: [], codeRejectionDetails: [] })),
  };
}
