import { describe, expect, it } from "vitest";
import { customerSubscriptionPreviewResponseSchema } from "./subscriptionFacadeContracts.js";

describe("customer subscription preview contract", () => {
  it("accepts renewal hardening telemetry for future template, payment, delivery, catalog, and charge timing", () => {
    const parsed = customerSubscriptionPreviewResponseSchema.parse({
      preview: {
        subscriptionId: "11111111-1111-4111-8111-111111111111",
        action: "update_package_template",
        canApply: true,
        blockedReason: null,
        nextCycleAt: "2026-07-10T10:00:00.000Z",
        editCutoffAt: "2026-07-09T10:00:00.000Z",
        templateVersion: 3,
        lockedCycle: { locked: false, status: null },
        futureTemplate: {
          templateVersion: 3,
          effectiveCycleAt: "2026-07-10T10:00:00.000Z",
          priceAgreementPolicy: "lock_until_edit",
        },
        paymentMethodStatus: "usable",
        deliverability: { status: "address_book_validated", blockedReason: null },
        catalogAvailability: { status: "unknown", blockedReason: null },
        quoteHash: "a".repeat(64),
        quoteExpiresAt: "2026-07-02T10:15:00.000Z",
        currentTotal: { amountMinor: 5000, currency: "PLN" },
        newTotal: { amountMinor: 6000, currency: "PLN" },
        delta: { amountMinor: 1000, currency: "PLN" },
        chargeTiming: {
          requiresConfirmation: false,
          confirmed: false,
          earliestChargeAt: null,
        },
      },
    });

    expect(parsed.preview.paymentMethodStatus).toBe("usable");
    expect(parsed.preview.futureTemplate?.priceAgreementPolicy).toBe("lock_until_edit");
  });

  it("accepts a NEGATIVE price delta for a price-reducing package edit (CJ01-R)", () => {
    // A package/plan change that lowers the recurring price yields delta < 0.
    // Before the fix, `delta` used the non-negative money schema, so the preview
    // handler rejected its own response (INVALID_RESPONSE → 502) for any
    // price-reducing edit. Both the top-level delta and packageEdit.delta must
    // accept a negative amountMinor.
    const parsed = customerSubscriptionPreviewResponseSchema.parse({
      preview: {
        subscriptionId: "11111111-1111-4111-8111-111111111111",
        action: "update_package_template",
        canApply: true,
        blockedReason: null,
        nextCycleAt: "2026-07-10T10:00:00.000Z",
        editCutoffAt: "2026-07-09T10:00:00.000Z",
        templateVersion: 3,
        quoteHash: "a".repeat(64),
        quoteExpiresAt: "2026-07-02T10:15:00.000Z",
        currentTotal: { amountMinor: 6000, currency: "PLN" },
        newTotal: { amountMinor: 5000, currency: "PLN" },
        delta: { amountMinor: -1000, currency: "PLN" },
        packageEdit: {
          currentRecurringPrice: { amountMinor: 6000, currency: "PLN" },
          newRecurringPrice: { amountMinor: 5000, currency: "PLN" },
          delta: { amountMinor: -1000, currency: "PLN" },
          quoteHash: "a".repeat(64),
          effectiveCycleAt: "2026-07-10T10:00:00.000Z",
          priceAgreementPolicy: "lock_until_edit",
        },
      },
    });

    expect(parsed.preview.delta?.amountMinor).toBe(-1000);
    expect(parsed.preview.packageEdit?.delta.amountMinor).toBe(-1000);
    // absolute prices stay non-negative
    expect(parsed.preview.packageEdit?.newRecurringPrice.amountMinor).toBe(5000);
  });

  it("accepts provider-disabled payment-method lifecycle telemetry", () => {
    const parsed = customerSubscriptionPreviewResponseSchema.parse({
      preview: {
        subscriptionId: "11111111-1111-4111-8111-111111111111",
        action: "resume",
        canApply: false,
        blockedReason: "missing_payment_method",
        nextCycleAt: "2026-07-10T10:00:00.000Z",
        editCutoffAt: "2026-07-09T10:00:00.000Z",
        templateVersion: 3,
        paymentMethodStatus: "provider_disabled",
      },
    });

    expect(parsed.preview.paymentMethodStatus).toBe("provider_disabled");
  });
});
