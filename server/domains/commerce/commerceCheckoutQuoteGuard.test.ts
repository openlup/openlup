import { describe, expect, it, vi } from "vitest";

import type { ConfiguratorIntentPersistenceResponse } from "../../../src/domains/commerce/configuratorIntentPersistenceContracts.js";
import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import { createQuoteResponseSchema, type CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import {
  STARTER_DELIVERY2_DISCOUNT_BPS,
  STARTER_OFFER_CAPABILITY,
  starterTermsFromCoverage,
} from "../../../src/domains/commerce/starterOfferPolicy.js";
import type { CheckoutOfferPolicyPort, CheckoutOfferResolution } from "./checkoutOfferPolicyPort.js";
import { resolveCheckoutQuoteGuard } from "./commerceCheckoutQuoteGuard.js";
import { CLIENT_ID, PET_ID, intent, quoteSnapshot } from "./commerceCheckoutHandler.testFixtures.js";

const provisioned = {
  clientId: CLIENT_ID,
  petId: PET_ID,
} as ConfiguratorIntentPersistenceResponse;

describe("resolveCheckoutQuoteGuard", () => {
  it("accepts checkout when no UI expectation is present", async () => {
    const snapshot = quoteSnapshot({ amountMinor: 25460, currency: "PLN" });
    const createQuote = vi.fn().mockResolvedValue(snapshot);

    await expect(
      resolveCheckoutQuoteGuard({
        quotePort: { createQuote },
        intent: intent("subscription"),
        provisioned,
        checkoutKind: "subscription_initial",
        recordQuoteStage: async <T>(operation: () => Promise<T>) => operation(),
      }),
    ).resolves.toEqual({ kind: "accepted", quoteSnapshot: snapshot });
    expect(createQuote).toHaveBeenCalledWith(expect.any(Object), { clientId: CLIENT_ID });
  });

  it("falls back to the provisioned client when pre-persist email eligibility found no history", async () => {
    const snapshot = quoteSnapshot({ amountMinor: 18_774, currency: quoteSnapshot().quote.currency });
    const createQuote = vi.fn().mockResolvedValue(snapshot);

    await expect(resolveCheckoutQuoteGuard({
      quotePort: { createQuote },
      intent: intent(),
      provisioned,
      checkoutKind: "one_time",
      pricingEligibilityClientId: null,
      expectedQuote: { totalGross: snapshot.quote.totalGross },
      recordQuoteStage: async <T>(operation: () => Promise<T>) => operation(),
    })).resolves.toMatchObject({ kind: "accepted" });

    expect(createQuote).toHaveBeenCalledWith(expect.any(Object), { clientId: CLIENT_ID });
  });

  it("blocks checkout before payment work when the authoritative total changed", async () => {
    const snapshot = quoteSnapshot({ amountMinor: 25460, currency: "PLN" });
    const createQuote = vi.fn().mockResolvedValue(snapshot);

    await expect(
      resolveCheckoutQuoteGuard({
        quotePort: { createQuote },
        intent: intent("subscription"),
        provisioned,
        checkoutKind: "subscription_initial",
        expectedQuote: { totalGross: { amountMinor: 12730, currency: "PLN" } },
        recordQuoteStage: async <T>(operation: () => Promise<T>) => operation(),
      }),
    ).resolves.toMatchObject({
      kind: "price_changed",
      response: {
        status: "price_changed",
        priceChanged: true,
        expectedQuote: { totalGross: { amountMinor: 12730, currency: "PLN" } },
        authoritativeQuote: snapshot,
      },
    });
  });

  it("persists an enriched strict quote but strips it from the price-changed response", async () => {
    const snapshot = quoteSnapshot();
    const pricingEligibilityClientId = "77777777-7777-4777-8777-777777777777";
    snapshot.quote.lines[0]!.catalogFacts = catalogFacts(snapshot.quote.currency);
    const createServerAuthoritativeQuote = vi.fn().mockResolvedValue(snapshot);

    const result = await resolveCheckoutQuoteGuard({
      quotePort: { createQuote: vi.fn(), createServerAuthoritativeQuote },
      intent: intent("subscription"),
      provisioned,
      checkoutKind: "subscription_initial",
      pricingEligibilityClientId,
      expectedQuote: {
        totalGross: {
          amountMinor: snapshot.quote.totalGross.amountMinor - 1,
          currency: snapshot.quote.currency,
        },
      },
      recordQuoteStage: async <T>(operation: () => Promise<T>) => operation(),
    });

    expect(createServerAuthoritativeQuote).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      { clientId: pricingEligibilityClientId },
    );
    expect(result).toMatchObject({ kind: "price_changed" });
    if (result.kind === "price_changed") {
      expect(result.response.authoritativeQuote.quote.lines[0]).not.toHaveProperty("catalogFacts");
    }
    const accepted = await resolveCheckoutQuoteGuard({
      quotePort: { createQuote: vi.fn(), createServerAuthoritativeQuote },
      intent: intent("subscription"),
      provisioned,
      checkoutKind: "subscription_initial",
      expectedQuote: { totalGross: snapshot.quote.totalGross },
      recordQuoteStage: async <T>(operation: () => Promise<T>) => operation(),
    });
    expect(accepted).toEqual({ kind: "accepted", quoteSnapshot: snapshot });
  });

  it("blocks a silent v2-to-v1 policy reprice even when the total is unchanged", async () => {
    const snapshot = quoteSnapshot({ amountMinor: 25460, currency: "PLN" });
    snapshot.quote.context = {
      ...snapshot.quote.context,
      mode: "subscription",
      promoCodes: snapshot.quote.context?.promoCodes ?? [],
      pricingPolicy: {
        offerPolicyVersion: "commerce.offer-policy.v1",
        promotionEngineVersion: "promotion-engine.v1",
      },
    };
    await expect(resolveCheckoutQuoteGuard({
      quotePort: { createQuote: vi.fn().mockResolvedValue(snapshot) },
      intent: intent("subscription"), provisioned,
      checkoutKind: "subscription_initial",
      expectedQuote: {
        totalGross: { amountMinor: 25460, currency: "PLN" },
        pricingPolicy: {
          offerPolicyVersion: "commerce.offer-policy.v2",
          promotionEngineVersion: "promotion-engine.v2",
          pricingPolicyToken: "pp1.this-is-a-long-enough-placeholder-token-for-contracts.signature",
        },
      },
      resolvePricingPolicy: () => ({
        offerPolicyVersion: "commerce.offer-policy.v1",
        promotionEngineVersion: "promotion-engine.v1",
      }),
      recordQuoteStage: async <T>(operation: () => Promise<T>) => operation(),
    })).resolves.toMatchObject({ kind: "price_changed" });
  });

  it("treats a historical unbound v1 expectation as equivalent to no policy field", async () => {
    const snapshot = quoteSnapshot({ amountMinor: 25460, currency: "PLN" });
    await expect(resolveCheckoutQuoteGuard({
      quotePort: { createQuote: vi.fn().mockResolvedValue(snapshot) },
      intent: intent("subscription"), provisioned,
      checkoutKind: "subscription_initial",
      expectedQuote: {
        totalGross: { amountMinor: 25460, currency: "PLN" },
        pricingPolicy: {
          offerPolicyVersion: "commerce.offer-policy.v1",
          promotionEngineVersion: "promotion-engine.v1",
        },
      },
      recordQuoteStage: async <T>(operation: () => Promise<T>) => operation(),
    })).resolves.toMatchObject({ kind: "accepted" });
  });

  it("accepts a matching v2 quote only with a valid acceptance token", async () => {
    const snapshot = v2Snapshot();
    const verifier = vi.fn().mockReturnValue(true);
    await expect(resolveCheckoutQuoteGuard({
      quotePort: { createQuote: vi.fn().mockResolvedValue(snapshot) },
      intent: { ...intent(), promoCodes: ["SAVE80"] },
      provisioned,
      checkoutKind: "one_time",
      expectedQuote: { totalGross: snapshot.quote.totalGross },
      promotionAcceptanceToken: "opaque.signed-token",
      verifyPromotionAcceptance: verifier,
      recordQuoteStage: async <T>(operation: () => Promise<T>) => operation(),
    })).resolves.toEqual({ kind: "accepted", quoteSnapshot: snapshot });
    expect(verifier).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing token", undefined, vi.fn().mockReturnValue(true)],
    ["forged token", "opaque.forged-token", vi.fn().mockReturnValue(false)],
    ["HONOR hard kill", "opaque.signed-token", undefined],
  ])("returns price_changed for %s and never reflects the token", async (
    _case, promotionAcceptanceToken, verifyPromotionAcceptance,
  ) => {
    const snapshot = v2Snapshot();
    const result = await resolveCheckoutQuoteGuard({
      quotePort: { createQuote: vi.fn().mockResolvedValue(snapshot) },
      intent: { ...intent(), promoCodes: ["SAVE80"] },
      provisioned,
      checkoutKind: "one_time",
      expectedQuote: {
        totalGross: snapshot.quote.totalGross,
        promotionAcceptanceToken: "must-not-reflect",
      } as never,
      promotionAcceptanceToken,
      verifyPromotionAcceptance,
      recordQuoteStage: async <T>(operation: () => Promise<T>) => operation(),
    });
    expect(result.kind).toBe("price_changed");
    if (result.kind === "price_changed") {
      expect(result.response.expectedQuote).toEqual({ totalGross: snapshot.quote.totalGross });
      expect(JSON.stringify(result.response)).not.toContain("must-not-reflect");
      expect(JSON.stringify(result.response)).not.toContain("opaque.");
    }
  });

  it("never consults an offer policy for an intent without offer fields", async () => {
    const snapshot = quoteSnapshot();
    const createQuote = vi.fn().mockResolvedValue(snapshot);
    const offerPolicy = offerPort();

    await expect(resolveCheckoutQuoteGuard({
      quotePort: { createQuote },
      intent: intent(),
      provisioned,
      checkoutKind: "one_time",
      offerPolicy,
      recordQuoteStage: async <T>(operation: () => Promise<T>) => operation(),
    })).resolves.toEqual({ kind: "accepted", quoteSnapshot: snapshot });
    expect(createQuote).toHaveBeenCalledWith(expect.any(Object), { clientId: CLIENT_ID });
    expect(offerPolicy.resolve).not.toHaveBeenCalled();
    expect(offerPolicy.evidence).not.toHaveBeenCalled();
  });

  it.each([
    ["an offer version", { offerVersion: "offer.v2" }],
    ["a minimum alone", { minimumUnits: 12 }],
  ])("refuses %s without an offer policy before any quote or policy read", async (_case, fields) => {
    const createQuote = vi.fn();
    const resolvePricingPolicy = vi.fn();

    await expect(resolveCheckoutQuoteGuard({
      quotePort: { createQuote },
      intent: { ...intent(), ...fields },
      provisioned,
      checkoutKind: "one_time",
      resolvePricingPolicy,
      recordQuoteStage: async <T>(operation: () => Promise<T>) => operation(),
    })).rejects.toMatchObject({ name: "CheckoutOfferRefusedError", reason: "offer_version_unsupported" });
    expect(createQuote).not.toHaveBeenCalled();
    expect(resolvePricingPolicy).not.toHaveBeenCalled();
  });

  it("never quotes after the offer policy refuses", async () => {
    const createQuote = vi.fn();
    const offerPolicy = offerPort({ kind: "refused", reason: "offer_not_available" });

    await expect(resolveCheckoutQuoteGuard({
      quotePort: { createQuote },
      intent: offerIntent(),
      provisioned,
      checkoutKind: "one_time",
      offerPolicy,
      recordQuoteStage: async <T>(operation: () => Promise<T>) => operation(),
    })).rejects.toMatchObject({ name: "CheckoutOfferRefusedError", reason: "offer_not_available" });
    expect(createQuote).not.toHaveBeenCalled();
    expect(offerPolicy.evidence).not.toHaveBeenCalled();
  });

  it.each(["createServerAuthoritativeQuote", "createQuote"])(
    "quotes a bound version through %s and writes it with valid evidence into the context",
    async (method) => {
      const snapshot = contextSnapshot();
      const quote = vi.fn().mockResolvedValue(snapshot);
      const quotePort = method === "createQuote"
        ? { createQuote: quote }
        : { createQuote: vi.fn(), createServerAuthoritativeQuote: quote };
      const offerPolicy = offerPort();
      const asked = offerIntent();

      const result = await resolveCheckoutQuoteGuard({
        quotePort,
        intent: asked,
        provisioned,
        checkoutKind: "one_time",
        offerPolicy,
        recordQuoteStage: async <T>(operation: () => Promise<T>) => operation(),
      });

      expect(offerPolicy.resolve).toHaveBeenCalledWith({ intent: asked, checkoutKind: "one_time" });
      expect(quote).toHaveBeenCalledWith(expect.any(Object), { clientId: CLIENT_ID, offerVersion: "offer.v2" });
      expect(result).toEqual({
        kind: "accepted",
        quoteSnapshot: {
          ...snapshot,
          quote: {
            ...snapshot.quote,
            context: { ...snapshot.quote.context, offerVersion: "offer.v2", offerEvidence: OFFER_EVIDENCE },
          },
        },
      });
      if (result.kind === "accepted") {
        expect(createQuoteResponseSchema.safeParse(result.quoteSnapshot).success).toBe(true);
      }
    },
  );

  it("answers price_changed for a bound offer whose total moved, without asking for evidence", async () => {
    const snapshot = contextSnapshot();
    const offerPolicy = offerPort();

    const result = await resolveCheckoutQuoteGuard({
      quotePort: { createQuote: vi.fn().mockResolvedValue(snapshot) },
      intent: offerIntent(),
      provisioned,
      checkoutKind: "one_time",
      expectedQuote: {
        totalGross: { ...snapshot.quote.totalGross, amountMinor: snapshot.quote.totalGross.amountMinor + 1 },
      },
      offerPolicy,
      recordQuoteStage: async <T>(operation: () => Promise<T>) => operation(),
    });

    expect(result.kind).toBe("price_changed");
    expect(offerPolicy.evidence).not.toHaveBeenCalled();
  });

  it("carries a minted starter plan and both offer fields together", async () => {
    const terms = starterTermsFromCoverage(14, 14)!;
    const { checkout, steady } = starterQuotes(terms.steadyCans);
    const createQuote = vi.fn().mockResolvedValueOnce(checkout).mockResolvedValueOnce(steady);
    const offerPolicy = offerPort();

    const result = await resolveCheckoutQuoteGuard({
      quotePort: { createQuote },
      intent: {
        ...intent("subscription"),
        starterOffer: {
          capability: STARTER_OFFER_CAPABILITY,
          intervalDays: terms.intervalDays,
          delivery2DiscountBps: STARTER_DELIVERY2_DISCOUNT_BPS,
          steady: { cadenceDays: terms.cadenceDays, cans: terms.steadyCans },
        },
        offerVersion: "offer.v2",
        minimumUnits: 14,
      },
      provisioned,
      checkoutKind: "subscription_initial",
      offerPolicy,
      starterPackEnabled: () => true,
      isFirstOrderEligible: async () => true,
      recordQuoteStage: async <T>(operation: () => Promise<T>) => operation(),
    });

    expect(result.kind).toBe("accepted");
    const context = result.kind === "accepted" ? result.quoteSnapshot.quote.context : undefined;
    expect(context?.starterPack?.graduation.cadenceDays).toBe(terms.cadenceDays);
    expect(context).toMatchObject({ offerVersion: "offer.v2", offerEvidence: OFFER_EVIDENCE });
    expect(createQuote).toHaveBeenNthCalledWith(1, expect.any(Object), { clientId: CLIENT_ID, offerVersion: "offer.v2" });
    expect(offerPolicy.evidence).toHaveBeenCalledWith(expect.objectContaining({
      quote: expect.objectContaining({ context: expect.objectContaining({ starterPack: context?.starterPack }) }),
    }));
  });
});

function v2Snapshot(): CreateQuoteResponse {
  const totalGross = { amountMinor: 2_000, currency: "PLN" as const };
  const snapshot = quoteSnapshot(totalGross);
  return {
    ...snapshot,
    quote: {
      ...snapshot.quote,
      lines: [{
        ...snapshot.quote.lines[0]!,
        unitPriceGross: { amountMinor: 10_000, currency: "PLN" },
        lineSubtotalGross: { amountMinor: 10_000, currency: "PLN" },
        tax: {
          ...snapshot.quote.lines[0]!.tax,
          netAmount: { amountMinor: 9_259, currency: "PLN" },
          vatAmount: { amountMinor: 741, currency: "PLN" },
          grossAmount: { amountMinor: 10_000, currency: "PLN" },
        },
      }],
      discounts: [{
        promotionId: "33333333-3333-4333-8333-333333333333",
        code: "SAVE80",
        appliesTo: "order_total",
        amountOffMinor: 8_000,
        reasonCode: "promotion_code_v2",
        promotionEngineVersion: "promotion-engine.v2",
        promotionCodeId: "44444444-4444-4444-8444-444444444444",
        promotionCodeRevision: 1,
        promotionDefinitionFingerprint: "a".repeat(64),
        promotionCodeScopes: ["one_time"],
        promotionMinimumReferenceMinor: 0,
        promotionCodeValidTo: "2026-07-20T00:00:00.000Z",
        promotionBenefitKind: "target_percentage",
        promotionBenefitValueBps: 8_000,
        floorApplied: false,
      }],
      subtotalGross: { amountMinor: 10_000, currency: "PLN" },
      discountTotalGross: { amountMinor: 8_000, currency: "PLN" },
      totalGross,
      netTotal: { amountMinor: 1_852, currency: "PLN" },
      taxTotal: { amountMinor: 148, currency: "PLN" },
    },
  };
}

function catalogFacts(currency: CreateQuoteResponse["quote"]["currency"]) {
  return {
    version: "catalog_facts_v1" as const,
    skuId: "11111111-1111-4111-8111-111111111111",
    documentRevisionId: "22222222-2222-4222-8222-222222222222",
    documentDigest: "a".repeat(64),
    resolvedPriceEntryId: "resolved-entry",
    basePriceEntryId: "base-entry",
    mode: "subscription" as const,
    atTime: "2026-06-05T10:00:00.000Z",
    currency,
    resolvedUnitAmountMinor: 1340,
    resolvedLineAmountMinor: 25460,
    baseUnitAmountMinor: 1490,
  };
}

const OFFER_EVIDENCE = { tier: "b", units: 14 };

function offerIntent(): ConfiguratorIntent {
  return { ...intent(), offerVersion: "offer.v2", minimumUnits: 14 };
}

function offerPort(resolution: CheckoutOfferResolution = { kind: "bound", offerVersion: "offer.v2" }) {
  return {
    resolve: vi.fn(async () => resolution),
    evidence: vi.fn(async () => OFFER_EVIDENCE),
  } satisfies CheckoutOfferPolicyPort;
}

function contextSnapshot(): CreateQuoteResponse {
  const snapshot = quoteSnapshot();
  return {
    ...snapshot,
    quote: { ...snapshot.quote, context: { mode: "one_time", cadenceDays: null, promoCodes: [] } },
  };
}

/** A subscription quote the starter lane mints a plan from, then its steady re-quote. */
function starterQuotes(steadyUnits: number): { checkout: CreateQuoteResponse; steady: CreateQuoteResponse } {
  const base = quoteSnapshot({ amountMinor: 16_800, currency: quoteSnapshot().quote.currency });
  const money = (amountMinor: number) => ({ amountMinor, currency: base.quote.currency });
  const checkout: CreateQuoteResponse = {
    ...base,
    quote: {
      ...base.quote,
      lines: [{ ...base.quote.lines[0]!, quantity: 14, unitPriceGross: money(1_200) }],
      pricingComponents: [{
        scope: "order",
        componentType: "base_unit",
        amountMinor: 21_000,
        reasonCode: "variant_unit_price",
        reasonPayload: {},
      }],
      context: { mode: "subscription", cadenceDays: 21, feedingCoverageDays: 14, promoCodes: [] },
    },
  };
  const steady: CreateQuoteResponse = {
    ...checkout,
    quote: {
      ...checkout.quote,
      lines: [{ ...checkout.quote.lines[0]!, quantity: steadyUnits, lineSubtotalGross: money(1_200 * steadyUnits) }],
    },
  };
  return { checkout, steady };
}
