import { describe, expect, it, vi } from "vitest";
import type { CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import { STARTER_OFFER_CAPABILITY } from "../../../src/domains/commerce/starterOfferPolicy.js";
import type { StarterTermsPort } from "../../../src/domains/commerce/starterTermsPort.js";
import { ACQUISITION_TERMS_CAPABILITY } from "@openlup/platform/pricing";
import { createCommerceCheckoutHandler } from "./commerceCheckoutHandler.js";
import {
  createPorts,
  createResponse,
  intent,
  quoteSnapshot,
  request,
} from "./commerceCheckoutHandler.testFixtures.js";

/**
 * End-to-end pin for the SIGNAL layer: a checkout intent that asks for the
 * starter pack must arrive at `startRuntime` — the value that becomes
 * `p_quote_snapshot` for `commerce_finalize_order_for_checkout` — carrying a
 * valid `quote.context.starterPack`, and the flag-off path must produce a
 * snapshot that is byte-identical to the pre-starter one.
 */

const STARTER_OFFER = {
  capability: STARTER_OFFER_CAPABILITY,
  intervalDays: 14,
  delivery2DiscountBps: 3_500,
  steady: { cadenceDays: 28 as const, cans: 28 },
};

function subscriptionQuote(): CreateQuoteResponse {
  const snapshot = quoteSnapshot({ amountMinor: 16_800, currency: "PLN" });
  return {
    ...snapshot,
    quote: {
      ...snapshot.quote,
      lines: [{ ...snapshot.quote.lines[0], quantity: 14, unitPriceGross: { amountMinor: 1_200, currency: "PLN" } }],
      pricingComponents: [
        {
          scope: "order",
          componentType: "base_unit",
          amountMinor: 21_000,
          reasonCode: "variant_unit_price",
          reasonPayload: {},
        },
      ],
      context: {
        mode: "subscription",
        cadenceDays: 21,
        feedingCoverageDays: 14,
        promoCodes: [],
      },
    },
  };
}

function starterIntent() {
  return { ...intent("subscription"), starterOffer: STARTER_OFFER };
}

/**
 * The checkout quote, then the STEADY re-quote. Wave 2's fixture answered both
 * calls with the 14-can checkout quote, so the marker it asserted promised a
 * 28-can steady basket alongside 14 cans of graduation lines — the P1-2 defect,
 * living in a fixture, invisible because the assertion never checked `qty`.
 * The rework's cross-field refine rejects that plan, which is how it was found.
 */
function steadySubscriptionQuote(): CreateQuoteResponse {
  const snapshot = subscriptionQuote();
  return {
    ...snapshot,
    quote: {
      ...snapshot.quote,
      lines: [{
        ...snapshot.quote.lines[0],
        quantity: 28,
        // Currency taken from the quote itself: a line whose currency disagrees
        // with its quote is not a shape the port can produce.
        unitPriceGross: { amountMinor: 1_200, currency: snapshot.quote.currency },
        lineSubtotalGross: { amountMinor: 33_600, currency: snapshot.quote.currency },
      }],
    },
  };
}

function portsWithQuote() {
  const ports = createPorts();
  const createQuote = vi.fn().mockResolvedValue(subscriptionQuote());
  createQuote.mockResolvedValueOnce(subscriptionQuote()).mockResolvedValueOnce(steadySubscriptionQuote());
  ports.quotePort = { createQuote } as unknown as typeof ports.quotePort;
  return ports;
}

function finalizedSnapshot(ports: ReturnType<typeof createPorts>): CreateQuoteResponse {
  const call = vi.mocked(ports.runtimePort.startRuntime).mock.calls[0][0];
  return call.orderDraft.quoteSnapshot as CreateQuoteResponse;
}

describe("checkout finalize payload, starter-pack lane", () => {
  const futureTerms = { schemaVersion: ACQUISITION_TERMS_CAPABILITY, revision: "terms-next",
    initialDiscountBps: 3_000, delivery2DiscountBps: 2_000, sourcePromotionId: "11111111-1111-4111-8111-111111111111",
    effectiveFrom: "1999-01-01T00:00:00.000Z", effectiveTo: null };
  const futureExpectation = { revision: futureTerms.revision, delivery2DiscountBps: futureTerms.delivery2DiscountBps };

  function capablePorts() {
    const base = quoteSnapshot({ amountMinor: 18_200, currency: quoteSnapshot().quote.currency });
    const quote: CreateQuoteResponse = { ...base, quote: { ...base.quote,
      lines: [{ ...base.quote.lines[0]!, quantity: 14, unitPriceGross: { amountMinor: 1_300, currency: quoteSnapshot().quote.currency } }],
      pricingComponents: subscriptionQuote().quote.pricingComponents,
      discounts: [{ promotionId: futureTerms.sourcePromotionId, appliesTo: "order_total", amountOffMinor: 3_500,
        reasonCode: "promotion_v2:target_percentage" }],
      discountTotalGross: { amountMinor: 3_500, currency: quoteSnapshot().quote.currency }, totalGross: { amountMinor: 14_700, currency: quoteSnapshot().quote.currency },
      netTotal: { amountMinor: 13_611, currency: quoteSnapshot().quote.currency }, taxTotal: { amountMinor: 1_089, currency: quoteSnapshot().quote.currency },
      context: { ...subscriptionQuote().quote.context!, acquisitionTerms: futureTerms },
    } };
    const steady = quoteSnapshot({ amountMinor: 36_400, currency: quoteSnapshot().quote.currency });
    steady.quote.lines = [{ ...steady.quote.lines[0]!, quantity: 28, unitPriceGross: { amountMinor: 1_300, currency: quoteSnapshot().quote.currency } }];
    const createQuote = vi.fn().mockResolvedValueOnce(quote).mockResolvedValueOnce(steady);
    return { ...createPorts(), quotePort: { createQuote },
      subscriptionCheckoutContractEnabled: () => true, starterPackEnabled: () => true,
      isFirstOrderEligible: async () => true, verifyPromotionAcceptance: vi.fn(() => true) };
  }

  function capableBody() {
    return { intent: { ...intent("subscription"), acquisitionCapability: ACQUISITION_TERMS_CAPABILITY,
      starterOffer: { ...STARTER_OFFER, delivery2DiscountBps: 2_000, acquisitionTerms: futureExpectation } },
    expectedQuote: { totalGross: { amountMinor: 14_700, currency: quoteSnapshot().quote.currency }, acquisitionTerms: futureExpectation,
      promotionAcceptanceToken: "signed-new-commercial-promise" } };
  }

  it("freezes the server-selected 30/20 acquisition and source with an exact 20 percent second-delivery marker", async () => {
    const ports = capablePorts();
    await createCommerceCheckoutHandler(ports)(request("POST", capableBody()), createResponse());
    const snapshot = finalizedSnapshot(ports);
    expect(snapshot.quote.context?.acquisitionTerms).toEqual(futureTerms);
    expect(snapshot.quote.context?.starterPack?.delivery2).toEqual({
      discountBps: 2_000, discountMinor: 1_400, basisSubtotalMinor: 18_200,
    });
    expect(ports.verifyPromotionAcceptance).toHaveBeenCalledWith(expect.objectContaining({
      token: "signed-new-commercial-promise", request: expect.objectContaining({ acquisitionCapability: ACQUISITION_TERMS_CAPABILITY }),
    }));
  });

  it.each(["missing signature", "rejected signature", "stale expected terms", "stale declaration"])(
    "does not create runtime money for %s even when delivery-1 total is unchanged", async (scenario) => {
      const ports = capablePorts();
      const body = capableBody();
      if (scenario === "missing signature") delete (body.expectedQuote as { promotionAcceptanceToken?: string }).promotionAcceptanceToken;
      if (scenario === "rejected signature") ports.verifyPromotionAcceptance.mockReturnValue(false);
      if (scenario === "stale expected terms") body.expectedQuote.acquisitionTerms = { ...futureExpectation, delivery2DiscountBps: 3_500 };
      if (scenario === "stale declaration") body.intent.starterOffer.acquisitionTerms = { ...futureExpectation, revision: "older-revision" };
      const res = createResponse();
      await createCommerceCheckoutHandler(ports)(request("POST", body), res);
      expect(ports.runtimePort.startRuntime).not.toHaveBeenCalled();
      expect(ports.orderDraftPort.createOrderDraft).not.toHaveBeenCalled();
      expect(ports.quotePort.createQuote).toHaveBeenCalledTimes(1);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true,
        data: expect.objectContaining({ status: "price_changed", priceChanged: true }) }));
    },
  );
  it("injects a valid quote.context.starterPack when the offer is asked for and granted", async () => {
    const res = createResponse();
    const ports = {
      ...portsWithQuote(),
      subscriptionCheckoutContractEnabled: () => true,
      starterPackEnabled: () => true,
      isFirstOrderEligible: () => Promise.resolve(true),
    };

    await createCommerceCheckoutHandler(ports)(
      request("POST", { intent: starterIntent() }),
      res,
    );

    const snapshot = finalizedSnapshot(ports);
    expect(snapshot.quote.context?.starterPack).toEqual({
      schemaVersion: "1",
      starterIntervalDays: 14,
      basisTemplateVersion: 1,
      delivery2: { discountBps: 3_500, discountMinor: 3_150, basisSubtotalMinor: 16_800 },
      graduation: {
        cadenceDays: 28,
        sizeConstraint: { kind: "unit_count", value: 28 },
        lines: [
          // qty is asserted explicitly now: the size constraint and the lines
          // have to agree, and only checking the sku is what hid P1-2 here.
          expect.objectContaining({ sku: "opaque:lamb-launch.v1", sortOrder: 0, isAddon: false, qty: 28 }),
        ],
      },
    });
  });

  it("leaves the finalize payload byte-identical to today when the flag is off", async () => {
    const withFlagOff = { ...portsWithQuote(), subscriptionCheckoutContractEnabled: () => true };
    const withoutStarterLane = { ...portsWithQuote(), subscriptionCheckoutContractEnabled: () => true };

    await createCommerceCheckoutHandler(withFlagOff)(
      request("POST", { intent: { ...intent("subscription"), starterOffer: undefined } }),
      createResponse(),
    );
    await createCommerceCheckoutHandler(withoutStarterLane)(
      request("POST", { intent: intent("subscription") }),
      createResponse(),
    );

    const baseline = finalizedSnapshot(withoutStarterLane);
    expect(finalizedSnapshot(withFlagOff)).toEqual(baseline);
    expect(baseline.quote.context).not.toHaveProperty("starterPack");
  });

  it("rejects a forged starter offer while the flag is off, without finalizing", async () => {
    const res = createResponse();
    const ports = {
      ...portsWithQuote(),
      subscriptionCheckoutContractEnabled: () => true,
      starterPackEnabled: () => false,
    };

    await createCommerceCheckoutHandler(ports)(
      request("POST", { intent: starterIntent() }),
      res,
    );

    expect(vi.mocked(ports.runtimePort.startRuntime)).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({ status: "price_changed", priceChanged: true }),
      }),
    );
  });

  it("rejects a returning customer's starter offer with the same price_changed shape", async () => {
    const res = createResponse();
    const ports = {
      ...portsWithQuote(),
      subscriptionCheckoutContractEnabled: () => true,
      starterPackEnabled: () => true,
      isFirstOrderEligible: () => Promise.resolve(false),
    };

    await createCommerceCheckoutHandler(ports)(
      request("POST", { intent: starterIntent() }),
      res,
    );

    expect(vi.mocked(ports.runtimePort.startRuntime)).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({ status: "price_changed" }),
      }),
    );
  });

  it("a starterTermsPort passed to the handler reaches the guard; the finalized snapshot's graduation has cadence 21 and the port's constraint", async () => {
    const constraint = { kind: "unit_count", value: 28, opaqueHint: 900 };
    const resolve = vi.fn<StarterTermsPort["resolve"]>(async () => ({
      kind: "terms",
      terms: { intervalDays: 14, steadyCadenceDays: 21, steadyUnits: 28, graduationSizeConstraint: constraint },
    }));
    const ports = {
      ...portsWithQuote(),
      subscriptionCheckoutContractEnabled: () => true,
      starterPackEnabled: () => true,
      isFirstOrderEligible: () => Promise.resolve(true),
      starterTermsPort: { resolve },
    };

    await createCommerceCheckoutHandler(ports)(
      request("POST", {
        intent: { ...intent("subscription"), starterOffer: { ...STARTER_OFFER, steady: { cadenceDays: 21, cans: 28 } } },
      }),
      createResponse(),
    );

    expect(resolve).toHaveBeenCalledTimes(1);
    const graduation = finalizedSnapshot(ports).quote.context?.starterPack?.graduation;
    expect(graduation?.cadenceDays).toBe(21);
    expect(graduation?.sizeConstraint).toEqual(constraint);
  });
});
