import { describe, expect, it } from "vitest";
import {
  storedMethodCapabilityKinds,
  storedMethodExpectations,
} from "../payment/contracts.js";
import {
  resolveSubscriptionPaymentMethodStatus,
  type SubscriptionPaymentMethodEvidence,
} from "./paymentMethodLifecycle.js";

const NOW = "2026-07-03T10:00:00.000Z";

describe("resolveSubscriptionPaymentMethodStatus", () => {
  it("accepts usable Stripe cards and marks soon-to-expire cards without blocking renewal", () => {
    expect(resolveSubscriptionPaymentMethodStatus(stripe())).toMatchObject({
      status: "usable",
      canAttemptCharge: true,
      preflightReason: null,
    });

    expect(resolveSubscriptionPaymentMethodStatus(stripe({ methodExpiresAt: "2026-07-10T00:00:00.000Z" }), { now: NOW }))
      .toMatchObject({
        status: "expiring",
        canAttemptCharge: true,
        preflightReason: null,
      });
  });

  it("blocks local customer-actionable Stripe method states before PSP execution", () => {
    expect(resolveSubscriptionPaymentMethodStatus(stripe({ providerMethodRef: null })).preflightReason)
      .toBe("missing_provider_method_ref");
    expect(resolveSubscriptionPaymentMethodStatus(stripe({ methodStatus: "revoked" })).status).toBe("revoked");
    expect(resolveSubscriptionPaymentMethodStatus(stripe({ methodStatus: "pending_verification" })).status)
      .toBe("requires_action");
    expect(resolveSubscriptionPaymentMethodStatus(stripe({ methodExpiresAt: "2026-07-01T00:00:00.000Z" }), { now: NOW }).status)
      .toBe("invalid");
  });

  it("routes integrity anomalies to operator-only preflight reasons", () => {
    expect(resolveSubscriptionPaymentMethodStatus(stripe({
      clientId: "client-1",
      methodClientId: "client-2",
    }))).toMatchObject({
      status: "invalid",
      canAttemptCharge: false,
      preflightReason: "payment_method_cross_client",
    });
    expect(resolveSubscriptionPaymentMethodStatus(stripe({ methodStatus: "past_due" }))).toMatchObject({
      status: "invalid",
      canAttemptCharge: false,
      preflightReason: "payment_method_unhandled_status",
    });
  });

  it("requires Tpay BLIK PAYID evidence and payer facts for recurring renewal charge", () => {
    expect(resolveSubscriptionPaymentMethodStatus(tpay()).status).toBe("usable");
    expect(resolveSubscriptionPaymentMethodStatus(tpay({ methodKind: "alias" })).preflightReason)
      .toBe("tpay_recurring_requires_blik_payid");
    expect(resolveSubscriptionPaymentMethodStatus(tpay({ providerMethodRef: null })).preflightReason)
      .toBe("tpay_recurring_payid_missing");
    expect(resolveSubscriptionPaymentMethodStatus(tpay({ payerEmail: null })).preflightReason).toBe("tpay_payer_missing");
  });

  it.each(storedMethodCapabilityKinds)("judges a %s stored method by what its rail expects", (providerKind) => {
    // Derived from the published expectations rather than restated: a rail that
    // starts or stops needing a customer reference, a stored-method kind or a
    // payer contact moves these verdicts without this test being edited.
    const expectations = storedMethodExpectations(providerKind)!;
    const usable: SubscriptionPaymentMethodEvidence = {
      providerKind,
      providerMethodRef: "ref_123",
      providerCustomerRef: expectations.requiresCustomerRef ? "customer_123" : null,
      methodKind: expectations.requiredMethodKind ?? "card",
      methodStatus: "active",
      methodActive: true,
      payerEmail: expectations.requiresPayerContact ? "buyer@example.com" : null,
    };

    expect(resolveSubscriptionPaymentMethodStatus(usable).canAttemptCharge).toBe(true);
    expect(resolveSubscriptionPaymentMethodStatus({ ...usable, providerCustomerRef: null }).canAttemptCharge)
      .toBe(!expectations.requiresCustomerRef);
    expect(resolveSubscriptionPaymentMethodStatus({ ...usable, payerEmail: null }).canAttemptCharge)
      .toBe(!expectations.requiresPayerContact);
    expect(resolveSubscriptionPaymentMethodStatus({ ...usable, methodKind: "unexpected_kind" }).canAttemptCharge)
      .toBe(expectations.requiredMethodKind === null);
  });

  it("separates operator/provider-disabled blockers from customer method blockers", () => {
    expect(resolveSubscriptionPaymentMethodStatus(stripe({ providerKind: "legacy_psp" }))).toMatchObject({
      status: "provider_disabled",
      canAttemptCharge: false,
      preflightReason: "subscription_provider_not_supported",
    });
    expect(resolveSubscriptionPaymentMethodStatus(stripe(), { providerDisabledReason: "stripe_provider_not_configured" }))
      .toMatchObject({
        status: "provider_disabled",
        canAttemptCharge: false,
        preflightReason: "stripe_provider_not_configured",
      });
  });
});

function stripe(overrides: Partial<SubscriptionPaymentMethodEvidence> = {}) {
  return {
    providerKind: "stripe",
    providerCustomerRef: "cus_123",
    providerMethodRef: "pm_123",
    methodKind: "card",
    methodStatus: "active",
    methodActive: true,
    methodExpiresAt: null,
    ...overrides,
  };
}

function tpay(overrides: Partial<SubscriptionPaymentMethodEvidence> = {}) {
  return {
    providerKind: "tpay",
    providerCustomerRef: null,
    providerMethodRef: "payid_123",
    methodKind: "blik_payid",
    methodStatus: "active",
    methodActive: true,
    payerEmail: "buyer@example.com",
    ...overrides,
  };
}
