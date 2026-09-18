import { describe, expect, it } from "vitest";
import { checkoutInlineRecoveryPayRequestSchema } from "./checkoutInlineRecoveryContracts.js";

const base = {
  orderId: "11111111-1111-4111-8111-111111111111",
  clientId: "22222222-2222-4222-8222-222222222222",
  paymentIntentId: "33333333-3333-4333-8333-333333333333",
  journeyId: "checkout:44444444-4444-4444-8444-444444444444",
  expectedPaymentAttemptId: "55555555-5555-4555-8555-555555555555",
  retryRequestId: "66666666-6666-4666-8666-666666666666",
};

describe("checkout inline recovery contract", () => {
  it("admits only fresh Stripe card and fresh Tpay BLIK shapes", () => {
    expect(checkoutInlineRecoveryPayRequestSchema.safeParse({ ...base, paymentMethod: "card", paymentProvider: "stripe" }).success).toBe(true);
    expect(checkoutInlineRecoveryPayRequestSchema.safeParse({ ...base, paymentMethod: "blik", paymentProvider: "tpay",
      paymentExecution: { provider: "tpay", flow: "blik_one_time", blikToken: "123456" } }).success).toBe(true);
    expect(checkoutInlineRecoveryPayRequestSchema.safeParse({ ...base, paymentMethod: "blik", paymentProvider: "tpay",
      paymentExecution: { provider: "tpay", flow: "blik_recurring_activation", blikToken: "123456", recurringModel: "O" } }).success).toBe(true);
  });

  it.each([
    { ...base, paymentMethod: "card", paymentProvider: "stripe", paymentExecution: { provider: "tpay", flow: "blik_one_time", blikToken: "123456" } },
    { ...base, paymentMethod: "card", paymentProvider: "tpay" },
    { ...base, paymentMethod: "blik", paymentProvider: "tpay", paymentExecution: { provider: "tpay", flow: "blik_one_click", savedMethodId: base.orderId } },
    { ...base, paymentMethod: "blik", paymentProvider: "tpay", paymentExecution: { provider: "tpay", flow: "blik_recurring_activation", blikToken: "123456", recurringModel: "M" } },
    { ...base, paymentMethod: "transfer", paymentProvider: "tpay" },
    { ...base, paymentMethod: "card", paymentProvider: "stripe", token: "raw-secret" },
  ])("rejects unsupported or credential-bearing input %#", (input) => {
    expect(checkoutInlineRecoveryPayRequestSchema.safeParse(input).success).toBe(false);
  });
});
