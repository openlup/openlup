import { describe, expect, it } from "vitest";
import type { ChargeDeps, DueSubscription } from "./chargeSubscriptionCycleOffSession.js";
import {
  failureResult,
  providerCustomerRef,
  readTotalGrossMinor,
  replayPreparedAttempt,
  tpayPayer,
  validateProviderChargeInput,
} from "./chargeSubscriptionCycleOffSessionHelpers.js";

const stripeDue: DueSubscription = {
  subscriptionId: "sub_123",
  clientId: "client_123",
  nextCycleAt: "2026-07-20T10:00:00.000Z",
  currency: "PLN",
  providerKind: "stripe",
  providerCustomerRef: " cus_123 ",
  providerMethodRef: " pm_123 ",
  methodKind: "card",
  payerEmail: null,
  payerName: null,
  methodStatus: "active",
  methodActive: true,
  methodExpiresAt: null,
  methodClientId: "client_123",
};
// The customer reference is now chosen by what the rail expects of a payer, not
// by which provider the row names.
const providerCustomer = { requiresPayerBlock: false, customerRefFallsBackToContactEmail: false };
const contactAsCustomer = { requiresPayerBlock: true, customerRefFallsBackToContactEmail: true };

describe("chargeSubscriptionCycleOffSessionHelpers", () => {
  it("keeps payment-method preflight fail-closed before provider execution", () => {
    expect(validateProviderChargeInput(stripeDue)).toBeNull();
    expect(validateProviderChargeInput({ ...stripeDue, providerMethodRef: null }))
      .toBe("missing_provider_method_ref");
    expect(validateProviderChargeInput({
      ...stripeDue,
      providerKind: "tpay",
      providerCustomerRef: null,
      providerMethodRef: "blik_payid_123",
      methodKind: "card",
      payerEmail: "customer@example.invalid",
    })).toBe("tpay_recurring_requires_blik_payid");
  });

  it("normalizes provider customer and Tpay payer facts", () => {
    expect(providerCustomerRef(stripeDue, providerCustomer)).toBe("cus_123");
    expect(providerCustomerRef({
      ...stripeDue,
      providerKind: "tpay",
      providerCustomerRef: null,
      payerEmail: " payer@example.invalid ",
    }, contactAsCustomer)).toBe("payer@example.invalid");
    // The same row without that capability keeps no customer reference at all:
    // the fallback is the rail's, not the provider name's.
    expect(providerCustomerRef({
      ...stripeDue,
      providerKind: "tpay",
      providerCustomerRef: null,
      payerEmail: " payer@example.invalid ",
    }, providerCustomer)).toBeUndefined();
    expect(tpayPayer({
      ...stripeDue,
      providerKind: "tpay",
      payerEmail: " payer@example.invalid ",
      payerName: " Anna ",
    })).toEqual({ email: "payer@example.invalid", name: "Anna" });
  });

  it("reads only positive integer gross totals from the locked order snapshot", () => {
    expect(readTotalGrossMinor({ totals: { totalGross: { amountMinor: 2599 } } })).toBe(2599);
    expect(readTotalGrossMinor({ totals: { totalGross: { amountMinor: 0 } } })).toBeNull();
    expect(readTotalGrossMinor({ totals: { totalGross: { amountMinor: 12.5 } } })).toBeNull();
    expect(readTotalGrossMinor({ totals: {} })).toBeNull();
  });

  it("replays prepared attempts without making another provider call", async () => {
    const result = await replayPreparedAttempt(
      { now: () => "2026-07-03T12:00:00.000Z" } as ChargeDeps,
      stripeDue,
      {
        cycleId: "cycle_123",
        cycleNumber: 4,
        orderId: "order_123",
        paymentIntentId: "intent_123",
        executionIdempotencyKey: "exec_123",
        providerIdempotencyKey: "provider_key_123",
        providerRequestFingerprint: "fingerprint_123",
        providerKind: "stripe",
      },
      "created",
    );

    expect(result).toMatchObject({
      outcome: "failed",
      attemptStatus: "created",
      replayed: true,
      reason: "provider_attempt_prepared_without_provider_ack",
    });
  });

  it("keeps failure results explicit when preflight cannot build a payable cycle", () => {
    expect(failureResult(stripeDue, null, 4, null, null, "invalid_totals")).toEqual({
      subscriptionId: "sub_123",
      outcome: "failed",
      cycleId: null,
      cycleNumber: 4,
      orderId: null,
      paymentIntentId: null,
      attemptStatus: null,
      replayed: false,
      dunningCaseId: null,
      retryAttempt: null,
      reason: "invalid_totals",
    });
  });
});
