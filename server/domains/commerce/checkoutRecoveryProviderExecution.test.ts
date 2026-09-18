import { describe, expect, it } from "vitest";
import type { CheckoutPaymentExecution } from "../../../src/domains/commerce/paymentExecutionContracts.js";
import { buildRecoveryProviderExecution } from "./checkoutRecoveryProviderExecution.js";
import type { CheckoutRecoveryOrderSnapshot } from "./checkoutRecoveryOrderPort.js";

describe("recovery provider execution", () => {
  it("pins a recovery click to its provider identity and captured payer", () => {
    const order: CheckoutRecoveryOrderSnapshot = {
      orderId: "11111111-1111-4111-8111-111111111111", orderRef: "order_11111111-1111-4111-8111-111111111111", orderNumber: "OPENLUP-1", clientId: "22222222-2222-4222-8222-222222222222", status: "pending_payment",
      mode: "subscription_cycle", totalMinor: 1490, currency: "PLN", petName: null, cadenceDays: 30, createdAt: "2026-07-24T00:00:00.000Z",
      customerEmail: "buyer@example.com", customerName: null, paymentIntentId: "33333333-3333-4333-8333-333333333333", paymentIntentStatus: "failed", subscriptionId: "subscription-1", subscriptionCycleId: "cycle-1",
    };
    const paymentExecution: CheckoutPaymentExecution = { provider: "tpay", flow: "blik_recurring_saved", savedMethodId: "44444444-4444-4444-8444-444444444444", recurringModel: "M" };
    const input = {
      order, clientId: order.clientId, paymentProvider: "tpay", paymentExecution,
      idempotencyKey: "recovery-click", providerFlow: "recurring_charge", paymentIntentId: "intent-id",
    } satisfies Parameters<typeof buildRecoveryProviderExecution>[0];
    const result = buildRecoveryProviderExecution(input);
    const replay = buildRecoveryProviderExecution(input);

    expect(result.executionIdempotencyKey).toBe("recovery-click:payment-execution");
    expect(result.executionInput).toMatchObject({ orderId: order.orderId, paymentIntentId: "intent-id", mode: "subscription_cycle", saveForFutureUse: true, returnContext: "public", payer: { email: "buyer@example.com", name: "buyer@example.com" }, transientProviderInput: { provider: "tpay", flow: "recurring_charge" } });
    expect(result.executionInput.providerIdempotencyKey).toBe(result.identity.providerIdempotencyKey);
    expect(result.executionInput.providerRequestFingerprint).toBe(result.identity.providerRequestFingerprint);
    expect(result.identity.providerIdempotencyKey).toBe(replay.identity.providerIdempotencyKey);
    expect(result.identity.providerRequestFingerprint).toBe(replay.identity.providerRequestFingerprint);
  });
});
