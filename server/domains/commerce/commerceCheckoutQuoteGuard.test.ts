import { describe, expect, it, vi } from "vitest";

import type { ConfiguratorIntentPersistenceResponse } from "../../../src/domains/commerce/configuratorIntentPersistenceContracts.js";
import type { CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
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
