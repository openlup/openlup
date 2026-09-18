import { describe, expect, it } from "vitest";
import {
  CHECKOUT_RESUME_CONTRACT_VERSION,
  checkoutResumeDraftStateSchema,
  checkoutResumeReadResponseSchema,
  checkoutResumeTokenSchema,
  checkoutResumeUpsertRequestSchema,
} from "./checkoutResumeContracts.js";

describe("checkout resume contracts", () => {
  it("accepts sanitized hidden resume state without contact, address or payment payloads", () => {
    const parsed = checkoutResumeUpsertRequestSchema.parse({
      idempotencyKey: "resume-2026-06-06",
      lastSectionId: "shipping",
      draftState: {
        version: CHECKOUT_RESUME_CONTRACT_VERSION,
        mode: "subscription",
        cadenceDays: 28,
        cart: {
          items: [
            {
              sku: "OPENLUP-DOG-LAMB-CAN-400G",
              productSlug: "lamb",
              variantId: "variant_lamb_400g",
              quantity: 6,
            },
          ],
        },
        completion: {
          petProfile: true,
          productSelection: true,
          cadence: true,
          account: false,
          shipping: false,
          billing: false,
          payment: false,
          review: false,
        },
        redactedFields: ["contact", "shipping_address", "payment_secret"],
      },
    });

    expect(parsed.draftState.redactedFields).toContain("contact");
    expect(parsed.resumeToken).toBeUndefined();
  });

  it("rejects raw form, address and payment-shaped state", () => {
    for (const draftState of [
      {
        version: CHECKOUT_RESUME_CONTRACT_VERSION,
        mode: "one_time",
        email: "ada@example.com",
      },
      {
        version: CHECKOUT_RESUME_CONTRACT_VERSION,
        mode: "one_time",
        shippingAddress: { street: "Prosta 1", city: "Warszawa" },
      },
      {
        version: CHECKOUT_RESUME_CONTRACT_VERSION,
        mode: "one_time",
        paymentProvider: { blik: "123456" },
      },
      {
        version: CHECKOUT_RESUME_CONTRACT_VERSION,
        mode: "one_time",
        cart: {
          items: [
            {
              sku: "OPENLUP-DOG-LAMB-CAN-400G",
              quantity: 1,
              providerPayload: { pspReference: "raw" },
            },
          ],
        },
      },
    ]) {
      expect(checkoutResumeDraftStateSchema.safeParse(draftState).success).toBe(false);
    }
  });

  it("does not expose the opaque token in read responses", () => {
    const response = checkoutResumeReadResponseSchema.parse({
      contractVersion: CHECKOUT_RESUME_CONTRACT_VERSION,
      draft: {
        id: "11111111-1111-4111-8111-111111111111",
        contractVersion: CHECKOUT_RESUME_CONTRACT_VERSION,
        lastSectionId: "review",
        draftState: {
          version: CHECKOUT_RESUME_CONTRACT_VERSION,
          mode: "one_time",
          cart: { items: [] },
          completion: {},
          redactedFields: ["raw_form_payload"],
        },
        expiresAt: "2026-06-06T12:00:00.000Z",
        createdAt: "2026-06-06T10:00:00.000Z",
        updatedAt: "2026-06-06T10:30:00.000Z",
        replayed: true,
      },
    });

    expect(JSON.stringify(response)).not.toContain("resumeToken");
  });

  it("requires opaque URL-safe tokens", () => {
    expect(
      checkoutResumeTokenSchema.safeParse(
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO123",
      ).success,
    ).toBe(true);
    expect(checkoutResumeTokenSchema.safeParse("short").success).toBe(false);
    expect(checkoutResumeTokenSchema.safeParse("has/slash/and+plus").success).toBe(false);
  });
});
