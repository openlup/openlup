import { describe, expect, it, vi } from "vitest";
import type { CustomerSubscriptionPreviewRequest } from "../../../src/domains/customers/subscriptionFacadeContracts.js";
import type { CustomerSubscriptionEligibilityInput } from "./customerAccountV2ReadModels.js";
import { actionEligibility, previewTelemetry, quoteExpiresAt } from "./customerSubscriptionPreviewTelemetry.js";

const SUB_ID = "00000000-0000-4000-8000-000000000001";
const ADDRESS_ID = "00000000-0000-4000-8000-000000000002";
const NEXT_CYCLE_AT = "2026-06-09T00:00:00.000Z";

function eligibilityInput(
  overrides: Partial<CustomerSubscriptionEligibilityInput> = {},
): CustomerSubscriptionEligibilityInput {
  return {
    subscriptionId: SUB_ID,
    status: "active",
    nextCycleAt: NEXT_CYCLE_AT,
    editCutoffAt: "2026-06-08T00:00:00.000Z",
    paymentMethodKind: "card",
    paymentMethodRefPresent: true,
    ...overrides,
  };
}

describe("customer subscription preview telemetry", () => {
  it("blocks resume when a paused subscription no longer has a usable payment method", () => {
    const result = actionEligibility(
      "resume",
      eligibilityInput({
        status: "paused",
        paymentMethodKind: null,
        paymentMethodRefPresent: false,
      }),
      new Map(),
    );

    expect(result).toEqual({ canEdit: false, reason: "missing_payment_method" });
  });

  it("surfaces locked-cycle, payment-method, future-template, and charge-timing telemetry", () => {
    const action: CustomerSubscriptionPreviewRequest["subscriptionAction"] = {
      action: "order_now",
      idempotencyKey: "order-now-preview-1",
      subscriptionId: SUB_ID,
      confirmedChargeTiming: true,
    };

    const result = previewTelemetry({
      action,
      subscription: {
        client_id: "11111111-1111-4111-8111-111111111111",
        template_version: 3,
        payment_method_kind: "card",
        payment_method_ref: "pm_123",
        payment_method_client_id: "11111111-1111-4111-8111-111111111111",
        provider_kind: "stripe",
        provider_customer_ref: "cus_123",
        provider_method_ref: "pm_123",
        provider_method_kind: "card",
        payment_method_status: "active",
        payment_method_active: true,
      },
      nextCycleAt: NEXT_CYCLE_AT,
      blocker: "cycle_locked",
      previewReason: null,
    });

    expect(result.lockedCycle).toEqual({ locked: true, status: "blocked_preflight" });
    expect(result.futureTemplate).toEqual({
      templateVersion: 3,
      effectiveCycleAt: NEXT_CYCLE_AT,
      priceAgreementPolicy: "lock_until_edit",
    });
    expect(result.paymentMethodStatus).toBe("usable");
    expect(result.chargeTiming).toEqual({
      requiresConfirmation: true,
      confirmed: true,
      earliestChargeAt: NEXT_CYCLE_AT,
    });
  });

  it("surfaces revoked and provider-disabled payment method lifecycle states", () => {
    const action: CustomerSubscriptionPreviewRequest["subscriptionAction"] = {
      action: "update_recipe_mix",
      idempotencyKey: "recipe-preview-1",
      subscriptionId: SUB_ID,
      expectedTemplateVersion: 3,
      acceptedQuoteHash: "a".repeat(64),
      recipes: [{ variantId: "11111111-1111-4111-8111-111111111111", qty: 2 }],
    };

    expect(previewTelemetry({
      action,
      subscription: {
        client_id: "11111111-1111-4111-8111-111111111111",
        payment_method_client_id: "11111111-1111-4111-8111-111111111111",
        provider_kind: "stripe",
        provider_customer_ref: "cus_123",
        provider_method_ref: "pm_123",
        provider_method_kind: "card",
        payment_method_status: "revoked",
        payment_method_active: false,
      },
      nextCycleAt: NEXT_CYCLE_AT,
      blocker: undefined,
      previewReason: "missing_payment_method",
    }).paymentMethodStatus).toBe("revoked");

    expect(previewTelemetry({
      action,
      subscription: {
        provider_kind: "legacy_psp",
        provider_method_ref: "pm_legacy",
        provider_method_kind: "card",
        payment_method_status: "active",
        payment_method_active: true,
      },
      nextCycleAt: NEXT_CYCLE_AT,
      blocker: undefined,
      previewReason: "missing_payment_method",
    }).paymentMethodStatus).toBe("provider_disabled");
  });

  it("reports address deliverability blockers and quote TTLs deterministically", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
    const action: CustomerSubscriptionPreviewRequest["subscriptionAction"] = {
      action: "change_shipping_address",
      idempotencyKey: "address-preview-1",
      subscriptionId: SUB_ID,
      shippingAddressId: ADDRESS_ID,
    };

    const result = previewTelemetry({
      action,
      subscription: {
        template_version: 4,
        payment_method_kind: null,
        payment_method_ref: null,
      },
      nextCycleAt: NEXT_CYCLE_AT,
      blocker: undefined,
      previewReason: "invalid_address",
    });

    expect(result.paymentMethodStatus).toBe("missing");
    expect(result.deliverability).toEqual({
      status: "blocked",
      blockedReason: "invalid_address",
    });
    expect(quoteExpiresAt()).toBe("2026-06-01T12:15:00.000Z");
    vi.useRealTimers();
  });
});
