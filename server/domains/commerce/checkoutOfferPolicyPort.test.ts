import { describe, expect, it, vi } from "vitest";
import type { CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import {
  CHECKOUT_OFFER_VERSION_UNSUPPORTED,
  CheckoutOfferRefusedError,
  resolveCheckoutOffer,
  withCheckoutOfferContext,
  type CheckoutOfferPolicyPort,
  type CheckoutOfferResolution,
} from "./checkoutOfferPolicyPort.js";
import { intent, quoteSnapshot } from "./commerceCheckoutHandler.testFixtures.js";

const OFFER_EVIDENCE = { tier: "b", units: 14 };

function offerPort(
  resolution: CheckoutOfferResolution = { kind: "bound", offerVersion: "offer.v2" },
  evidence: Record<string, unknown> = OFFER_EVIDENCE,
) {
  return {
    resolve: vi.fn(async () => resolution),
    evidence: vi.fn(async () => evidence),
  } satisfies CheckoutOfferPolicyPort;
}

function offerIntent(fields: { offerVersion?: string; minimumUnits?: number } = { offerVersion: "offer.v2", minimumUnits: 14 }) {
  return { ...intent(), ...fields };
}

function snapshotWithContext(): CreateQuoteResponse {
  const snapshot = quoteSnapshot();
  return {
    ...snapshot,
    quote: { ...snapshot.quote, context: { mode: "one_time", cadenceDays: null, promoCodes: [] } },
  };
}

describe("resolveCheckoutOffer", () => {
  it("returns null without a port call when the intent carries no offer field", async () => {
    const port = offerPort();

    await expect(resolveCheckoutOffer(port, intent(), "one_time")).resolves.toBeNull();
    await expect(resolveCheckoutOffer(undefined, intent(), "one_time")).resolves.toBeNull();
    expect(port.resolve).not.toHaveBeenCalled();
  });

  it.each([
    ["an offer version", { offerVersion: "offer.v2" }],
    ["a minimum alone", { minimumUnits: 12 }],
  ])("refuses %s without a port as offer_version_unsupported", async (_case, fields) => {
    const refusal = resolveCheckoutOffer(undefined, offerIntent(fields), "one_time");

    await expect(refusal).rejects.toBeInstanceOf(CheckoutOfferRefusedError);
    await expect(refusal).rejects.toMatchObject({
      reason: CHECKOUT_OFFER_VERSION_UNSUPPORTED,
      message: "checkout_offer_refused:offer_version_unsupported",
    });
  });

  it("throws the port's refusal with its own reason", async () => {
    const port = offerPort({ kind: "refused", reason: "offer_not_available" });

    await expect(resolveCheckoutOffer(port, offerIntent(), "subscription_initial")).rejects.toMatchObject({
      name: "CheckoutOfferRefusedError",
      reason: "offer_not_available",
    });
    expect(port.evidence).not.toHaveBeenCalled();
  });

  it("binds the version the port resolves, asking with the intent and the checkout kind", async () => {
    const port = offerPort();
    const asked = offerIntent();

    await expect(resolveCheckoutOffer(port, asked, "subscription_initial")).resolves.toEqual({
      port,
      offerVersion: "offer.v2",
    });
    expect(port.resolve).toHaveBeenCalledWith({ intent: asked, checkoutKind: "subscription_initial" });
  });
});

describe("withCheckoutOfferContext", () => {
  it("returns the same snapshot object without a binding", async () => {
    const snapshot = snapshotWithContext();

    await expect(withCheckoutOfferContext(null, intent(), snapshot)).resolves.toBe(snapshot);
  });

  it("writes the bound version and the port's evidence into the context", async () => {
    const port = offerPort();
    const snapshot = snapshotWithContext();
    const asked = offerIntent();

    const bound = await withCheckoutOfferContext({ port, offerVersion: "offer.v2" }, asked, snapshot);

    expect(bound.quote.context).toEqual({
      ...snapshot.quote.context,
      offerVersion: "offer.v2",
      offerEvidence: OFFER_EVIDENCE,
    });
    expect(bound.quote.lines).toBe(snapshot.quote.lines);
    expect(snapshot.quote.context).not.toHaveProperty("offerVersion");
    expect(port.evidence).toHaveBeenCalledWith({ intent: asked, offerVersion: "offer.v2", quote: snapshot.quote });
  });

  it("fails closed when a bound snapshot has no context", async () => {
    const port = offerPort();

    await expect(withCheckoutOfferContext({ port, offerVersion: "offer.v2" }, offerIntent(), quoteSnapshot()))
      .rejects.toThrow("checkout_offer_context_missing");
    expect(port.evidence).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-identifier key", { "tier-name": "b" }],
    ["more than 4096 characters", { note: "x".repeat(4_096) }],
  ])("throws when the evidence has %s", async (_case, evidence) => {
    const port = offerPort({ kind: "bound", offerVersion: "offer.v2" }, evidence);

    await expect(withCheckoutOfferContext({ port, offerVersion: "offer.v2" }, offerIntent(), snapshotWithContext()))
      .rejects.toThrow();
  });
});
