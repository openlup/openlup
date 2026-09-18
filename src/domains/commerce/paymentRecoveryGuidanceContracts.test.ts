import { describe, expect, it } from "vitest";
import { CHECKOUT_CONTRACT_VERSION, paymentStatusResponseSchema } from "./checkoutContracts.js";
import { paymentRecoveryGuidanceSchema, paymentRecoveryStatusResponseSchema } from "./paymentRecoveryGuidanceContracts.js";

function base() {
  return { contractVersion: CHECKOUT_CONTRACT_VERSION, orderId: "11111111-1111-4111-8111-111111111111",
    paymentIntentId: "33333333-3333-4333-8333-333333333333", status: "failed", orderStatus: "pending_payment",
    payment: { intentStatus: "failed", attemptStatus: "failed", paymentAttemptId: "44444444-4444-4444-8444-444444444444",
      provider: "stripe", providerPaymentId: "pi_synthetic", updatedAt: "2026-09-11T08:00:00Z" },
    failureReason: "provider_declined", failureDisplay: "provider_declined",
    subscriptionActivation: { status: "not_applicable", subscriptionId: null }, nextAction: null };
}
function guidance() {
  return { version: 1, paymentAttemptId: "44444444-4444-4444-8444-444444444444", purchaseContext: "one_time",
    cause: "generic_decline", methodKind: "blik", methodKey: "blik_one_click", operation: "one_time_payment",
    restriction: null, actions: ["change_method"], consecutiveRefusals: 2, emphasis: "recommended" };
}

describe("negotiated recovery status contract", () => {
  it("accepts strictly bounded guidance and keeps a visible method choice independent of provider", () => {
    const payload = { ...base(), recoveryGuidance: guidance() };
    expect(paymentRecoveryStatusResponseSchema.parse(payload)).toEqual(payload);
    expect(paymentStatusResponseSchema.safeParse(payload).success).toBe(false);
  });

  it.each([undefined, null])("accepts old server absence or explicit null: %s", (value) => {
    const payload = { ...base(), ...(value === undefined ? {} : { recoveryGuidance: value }) };
    expect(paymentRecoveryStatusResponseSchema.parse(payload)).toEqual(payload);
  });

  it.each([
    {}, "private reason", [], { ...guidance(), version: 2 }, { ...guidance(), cause: "future_cause" },
    { ...guidance(), paymentAttemptId: "invalid" }, { ...guidance(), purchaseContext: "subscription_renewal" },
    { ...guidance(), consecutiveRefusals: 3 }, { ...guidance(), consecutiveRefusals: -1 },
    { ...guidance(), actions: ["future_action"] }, { ...guidance(), restriction: "bank" },
    { ...guidance(), methodKey: "payer@example.test" }, { ...guidance(), methodKind: "x".repeat(97) },
    { ...guidance(), rawMessage: "sensitive PSP prose" }, { ...guidance(), adviceCode: "do_not_try_again" },
  ])("discards malformed or private extension without discarding valid base: %j", (recoveryGuidance) => {
    expect(paymentRecoveryGuidanceSchema.safeParse(recoveryGuidance).success).toBe(false);
    expect(paymentRecoveryStatusResponseSchema.parse({ ...base(), recoveryGuidance })).toEqual({ ...base(), recoveryGuidance: null });
  });

  it.each([
    { status: "unknown_status" }, { contractVersion: 99 }, { orderId: "invalid" }, { payment: {} },
    { extra: "private" }, { failureDisplay: "new_unnegotiated_display" }, { nextAction: { kind: "future" } },
  ])("does not repair a malformed legacy status when extension is malformed too: %j", (override) => {
    expect(paymentRecoveryStatusResponseSchema.safeParse({ ...base(), ...override, recoveryGuidance: { cause: "broken" } }).success).toBe(false);
  });

  it.each([null, [], "invalid", { recoveryGuidance: guidance() }])("rejects missing base envelope %j", (value) => {
    expect(paymentRecoveryStatusResponseSchema.safeParse(value).success).toBe(false);
  });

  it("allows explicitly unknown method and count without manufacturing a zero", () => {
    expect(paymentRecoveryGuidanceSchema.parse({ ...guidance(), methodKind: null, methodKey: null, operation: null,
      consecutiveRefusals: null, emphasis: "normal" })).toMatchObject({ consecutiveRefusals: null, methodKey: null });
  });
});
