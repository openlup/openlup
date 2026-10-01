import { describe, expect, it, vi } from "vitest";
import type { CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import type { CheckoutOfferPolicyPort } from "./checkoutOfferPolicyPort.js";
import { createCommerceCheckoutHandler } from "./commerceCheckoutHandler.js";
import {
  CLIENT_ID,
  createPorts,
  createResponse,
  intent,
  quoteSnapshot,
  request,
} from "./commerceCheckoutHandler.testFixtures.js";

/**
 * End-to-end pin for the offer-version lane: an intent that carries an adopter
 * offer version is refused before any quote or order draft unless the adopter's
 * offer policy binds it, and a bound version reaches the order draft inside
 * `quote.context` with the adopter's evidence.
 */

const OFFER_EVIDENCE = { tier: "b", units: 14 };

function offerIntent() {
  return { ...intent(), offerVersion: "offer.v2", minimumUnits: 14 };
}

function quoteWithContext(): CreateQuoteResponse {
  const snapshot = quoteSnapshot();
  return {
    ...snapshot,
    quote: { ...snapshot.quote, context: { mode: "one_time", cadenceDays: null, promoCodes: [] } },
  };
}

function portsWithQuote() {
  const ports = createPorts();
  ports.quotePort = { createQuote: vi.fn().mockResolvedValue(quoteWithContext()) };
  return ports;
}

function orderDraftSnapshot(ports: ReturnType<typeof createPorts>): CreateQuoteResponse {
  return vi.mocked(ports.orderDraftPort.createOrderDraft).mock.calls[0][0].quoteSnapshot;
}

describe("checkout offer version lane", () => {
  it("refuses an offer version without an offer policy before any quote or order draft", async () => {
    const res = createResponse();
    const ports = portsWithQuote();

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: offerIntent() }), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: "CONFLICT",
        message: "Checkout offer refused",
        details: { feature: "checkout", stage: "quote", reason: "offer_version_unsupported" },
      },
    });
    expect(ports.quotePort.createQuote).not.toHaveBeenCalled();
    expect(ports.orderDraftPort.createOrderDraft).not.toHaveBeenCalled();
    expect(ports.runtimePort.startRuntime).not.toHaveBeenCalled();
  });

  it("carries a bound version and its evidence into the order draft's quote context", async () => {
    const res = createResponse();
    const offerPolicy: CheckoutOfferPolicyPort = {
      resolve: vi.fn().mockResolvedValue({ kind: "bound", offerVersion: "offer.v2" }),
      evidence: vi.fn().mockResolvedValue(OFFER_EVIDENCE),
    };
    const ports = { ...portsWithQuote(), offerPolicy };

    await createCommerceCheckoutHandler(ports)(request("POST", { intent: offerIntent() }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(offerPolicy.resolve).toHaveBeenCalledWith({
      intent: expect.objectContaining({ offerVersion: "offer.v2", minimumUnits: 14 }),
      checkoutKind: "one_time",
    });
    expect(ports.quotePort.createQuote).toHaveBeenCalledWith(expect.any(Object), {
      clientId: CLIENT_ID,
      offerVersion: "offer.v2",
    });
    expect(orderDraftSnapshot(ports).quote.context).toEqual({
      ...quoteWithContext().quote.context,
      offerVersion: "offer.v2",
      offerEvidence: OFFER_EVIDENCE,
    });
  });

  it("never consults the offer policy for an intent without offer fields", async () => {
    const offerPolicy: CheckoutOfferPolicyPort = { resolve: vi.fn(), evidence: vi.fn() };
    const withPolicy = { ...portsWithQuote(), offerPolicy };
    const withoutPolicy = portsWithQuote();

    await createCommerceCheckoutHandler(withPolicy)(request("POST", { intent: intent() }), createResponse());
    await createCommerceCheckoutHandler(withoutPolicy)(request("POST", { intent: intent() }), createResponse());

    expect(offerPolicy.resolve).not.toHaveBeenCalled();
    expect(offerPolicy.evidence).not.toHaveBeenCalled();
    expect(orderDraftSnapshot(withPolicy)).toEqual(orderDraftSnapshot(withoutPolicy));
    expect(orderDraftSnapshot(withPolicy).quote.context).not.toHaveProperty("offerVersion");
  });
});
