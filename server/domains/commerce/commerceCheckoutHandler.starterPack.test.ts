import { describe, expect, it, vi } from "vitest";
import type { CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import { STARTER_OFFER_CAPABILITY } from "../../../src/domains/commerce/starterOfferPolicy.js";
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
});
