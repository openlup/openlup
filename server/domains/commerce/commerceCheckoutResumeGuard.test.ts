import { describe, expect, it, vi } from "vitest";

import { CHECKOUT_CONTRACT_VERSION } from "../../../src/domains/commerce/checkoutContracts.js";
import type { CommerceResumableOrderReadPort } from "../../../src/domains/commerce/ports.js";
import { CLIENT_ID, ORDER_ID, PAYMENT_INTENT_ID, intent } from "./commerceCheckoutHandler.testFixtures.js";
import {
  resolveResumeOpenOrderResponse,
  type QuoteLikeSnapshot,
} from "./commerceCheckoutResumeGuard.js";

/** The basket the buyer just accepted a price for. */
/**
 * `XTS` is the ISO reserved code this repo uses for fixtures, and `XXX` its
 * "no currency" partner for the mismatch case. Real codes are deliberately
 * avoided: they are counted vocabulary in the OSS neutrality ratchet, and a test
 * basket needs no nationality to make its point.
 */
const ACCEPTED: QuoteLikeSnapshot = {
  currency: "XTS",
  totalGross: { amountMinor: 12_900, currency: "XTS" },
  lines: [{ sku: "SKU-A", quantity: 2 }, { sku: "SKU-B", quantity: 1 }],
};

/** The same basket as the producer persists it on the order. */
function storedQuote(overrides: Partial<QuoteLikeSnapshot> = {}) {
  return { quoteSnapshot: { quote: { ...ACCEPTED, ...overrides } } };
}

function port(snapshot: unknown): CommerceResumableOrderReadPort {
  return { findResumableOrderForClient: vi.fn().mockResolvedValue(snapshot) };
}

function resumableOrder(overrides: Record<string, unknown> = {}) {
  return {
    orderId: ORDER_ID,
    paymentIntentId: PAYMENT_INTENT_ID,
    status: "requires_action",
    sameJourney: false,
    metadata: { selectedDelivery: intent("one_time").selectedDelivery, ...storedQuote() },
    ...overrides,
  };
}

describe("commerce checkout resume guard", () => {
  it("builds a resume response for an in-flight order from another journey", async () => {
    const resumePort = port({
      ...resumableOrder(),
      metadata: { selectedDelivery: intent("subscription").selectedDelivery, ...storedQuote() },
    });

    const response = await resolveResumeOpenOrderResponse({
      deps: { resumableOrderPort: resumePort, resumeWindowMinutes: 15 },
      clientId: CLIENT_ID,
      checkoutKind: "subscription_initial",
      intent: intent("subscription"),
      acceptedQuote: ACCEPTED,
      now: () => new Date("2026-06-19T12:00:00.000Z"),
    });

    expect(resumePort.findResumableOrderForClient).toHaveBeenCalledWith({
      clientId: CLIENT_ID,
      withinMinutes: 15,
      now: new Date("2026-06-19T12:00:00.000Z"),
      journeyKey: intent("subscription").idempotencyKey,
    });
    expect(response).toEqual(
      expect.objectContaining({
        contractVersion: CHECKOUT_CONTRACT_VERSION,
        checkoutKind: "subscription_initial",
        orderId: ORDER_ID,
        paymentIntentId: PAYMENT_INTENT_ID,
        status: "requires_action",
        clientAction: { kind: "none" },
        payment: { requiresReusablePaymentMethod: true },
        subscription: { requested: true, cadenceDays: 21, activationStatus: "pending_payment_success" },
      }),
    );
  });

  it("fails open when lookup throws", async () => {
    const resumePort: CommerceResumableOrderReadPort = {
      findResumableOrderForClient: vi.fn().mockRejectedValue(new Error("network unavailable")),
    };

    await expect(
      resolveResumeOpenOrderResponse({
        deps: { resumableOrderPort: resumePort },
        clientId: CLIENT_ID,
        checkoutKind: "one_time",
        intent: intent("one_time"),
        acceptedQuote: ACCEPTED,
        now: () => new Date("2026-06-19T12:00:00.000Z"),
      }),
    ).resolves.toBeNull();
  });

  it("hands a SAME-JOURNEY order to supersede instead of resuming it", async () => {
    // The money defect this wave exists to remove. A cart edit reuses the
    // journey key, so the in-flight order belongs to THIS submit — answering
    // with it would re-offer the old total for a basket the buyer changed.
    // Returning null lets the order-draft path reach
    // `commerce_supersede_pre_payment_order_draft`, which cancels the unpaid
    // order and re-drafts at the new price, and which refuses once money moved.
    const resumePort = port(resumableOrder({ sameJourney: true }));

    await expect(
      resolveResumeOpenOrderResponse({
        deps: { resumableOrderPort: resumePort },
        clientId: CLIENT_ID,
        checkoutKind: "one_time",
        intent: intent("one_time"),
        acceptedQuote: ACCEPTED,
        now: () => new Date("2026-06-19T12:00:00.000Z"),
      }),
    ).resolves.toBeNull();
  });

  it("refuses a same-journey order EVEN when the cart still matches exactly", async () => {
    // The two barriers are independent, and this is the one that proves it. An
    // identical cart is not permission to resume a cart edit: supersede must
    // still own the order so the re-draft is the one that gets paid.
    const resumePort = port(resumableOrder({ sameJourney: true }));

    await expect(
      resolveResumeOpenOrderResponse({
        deps: { resumableOrderPort: resumePort },
        clientId: CLIENT_ID,
        checkoutKind: "one_time",
        intent: intent("one_time"),
        acceptedQuote: ACCEPTED,
        now: () => new Date("2026-06-19T12:00:00.000Z"),
      }),
    ).resolves.toBeNull();
  });

  it("does not resume when the customer changed delivery selection", async () => {
    const resumePort = port(resumableOrder({
      metadata: {
        ...storedQuote(),
        // Any selection that DIFFERS is the point; which carrier it is, is not.
        // Named neutrally so the fixture carries no vendor vocabulary — the
        // guard compares an opaque key built from these fields, never a brand.
        selectedDelivery: {
          ...intent("one_time").selectedDelivery,
          providerKind: "other-provider",
          carrierKind: "other-carrier",
          carrierCode: "OTHER",
          service: "other_courier_standard",
          serviceCode: "OTHER_COURIER_STANDARD",
        },
      },
    }));

    await expect(
      resolveResumeOpenOrderResponse({
        deps: { resumableOrderPort: resumePort },
        clientId: CLIENT_ID,
        checkoutKind: "one_time",
        intent: intent("one_time"),
        acceptedQuote: ACCEPTED,
        now: () => new Date("2026-06-19T12:00:00.000Z"),
      }),
    ).resolves.toBeNull();
  });

  it.each([
    ["a different total", { totalGross: { amountMinor: 15_900, currency: "XTS" } }],
    ["a different currency", { currency: "XXX", totalGross: { amountMinor: 12_900, currency: "XXX" } }],
    ["a changed quantity", { lines: [{ sku: "SKU-A", quantity: 3 }, { sku: "SKU-B", quantity: 1 }] }],
    ["a swapped line", { lines: [{ sku: "SKU-A", quantity: 2 }, { sku: "SKU-C", quantity: 1 }] }],
    ["a dropped line", { lines: [{ sku: "SKU-A", quantity: 2 }] }],
  ])("does not resume a cross-device order with %s", async (_label, overrides) => {
    // Same buyer, different journey, different basket — two tabs, two
    // configurations. Money is what the buyer is about to authorize, so it has
    // to be the money they were just shown.
    const resumePort = port(resumableOrder({
      metadata: {
        selectedDelivery: intent("one_time").selectedDelivery,
        ...storedQuote(overrides as Partial<QuoteLikeSnapshot>),
      },
    }));

    await expect(
      resolveResumeOpenOrderResponse({
        deps: { resumableOrderPort: resumePort },
        clientId: CLIENT_ID,
        checkoutKind: "one_time",
        intent: intent("one_time"),
        acceptedQuote: ACCEPTED,
        now: () => new Date("2026-06-19T12:00:00.000Z"),
      }),
    ).resolves.toBeNull();
  });

  it("resumes when the line order differs but the basket does not", async () => {
    // Order of lines is not identity; quantity is. Without this the guard would
    // refuse legitimate cross-device returns for a purely cosmetic difference.
    const resumePort = port(resumableOrder({
      metadata: {
        selectedDelivery: intent("one_time").selectedDelivery,
        ...storedQuote({ lines: [{ sku: "SKU-B", quantity: 1 }, { sku: "SKU-A", quantity: 2 }] }),
      },
    }));

    await expect(
      resolveResumeOpenOrderResponse({
        deps: { resumableOrderPort: resumePort },
        clientId: CLIENT_ID,
        checkoutKind: "one_time",
        intent: intent("one_time"),
        acceptedQuote: ACCEPTED,
        now: () => new Date("2026-06-19T12:00:00.000Z"),
      }),
    ).resolves.not.toBeNull();
  });

  it.each([
    ["no quote at all", {}],
    ["an unreadable quote", { quoteSnapshot: { quote: { currency: "XTS" } } }],
  ])("does not resume an order whose basket cannot be established: %s", async (_label, stored) => {
    // Fail CLOSED. An order we cannot price is exactly the one not to re-offer.
    const resumePort = port(resumableOrder({
      metadata: { selectedDelivery: intent("one_time").selectedDelivery, ...stored },
    }));

    await expect(
      resolveResumeOpenOrderResponse({
        deps: { resumableOrderPort: resumePort },
        clientId: CLIENT_ID,
        checkoutKind: "one_time",
        intent: intent("one_time"),
        acceptedQuote: ACCEPTED,
        now: () => new Date("2026-06-19T12:00:00.000Z"),
      }),
    ).resolves.toBeNull();
  });
});
