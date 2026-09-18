import { describe, expect, it, vi } from "vitest";
import type { VercelRequest } from "../../_lib/types/vercel.js";
import { resolveSavedTpayPaymentMethodForCheckout } from "./commerceCheckoutSavedPaymentMethod.js";
import type { CheckoutSavedPaymentMethodResolverPort } from "./savedPaymentMethodResolverPort.js";

const SAVED_METHOD_ID = "22222222-2222-4222-8222-222222222222";

describe("checkout saved Tpay payment method resolver", () => {
  it("resolves saved method refs only through the server-side resolver port", async () => {
    const resolver = createResolver({
      providerMethodRef: "payid_secret",
      providerAliasType: "PAYID",
      recurringModel: "O",
    });
    const recordedStages: string[] = [];
    const recordStage = async <T>(stage: "payment_method_ref", operation: () => Promise<T>): Promise<T> => {
      recordedStages.push(stage);
      return operation();
    };

    await expect(resolveSavedTpayPaymentMethodForCheckout({
      req: request("Bearer access-token"),
      paymentExecution: { provider: "tpay", flow: "blik_one_click", savedMethodId: SAVED_METHOD_ID },
      clientId: "client-1",
      savedPaymentMethodResolverPort: resolver,
      now: () => new Date("2026-06-24T12:00:00Z"),
      recordStage,
    })).resolves.toEqual({
      kind: "resolved",
      paymentMethodRef: "payid_secret",
      paymentMethodAliasType: "PAYID",
      paymentMethodRecurringModel: "O",
    });

    expect(resolver.resolveSavedPaymentMethod).toHaveBeenCalledWith({
      accessToken: "access-token",
      clientId: "client-1",
      savedMethodId: SAVED_METHOD_ID,
      requestedFlow: "blik_one_click",
      now: new Date("2026-06-24T12:00:00Z"),
    });
    expect(recordedStages).toEqual(["payment_method_ref"]);
  });

  it("fails closed for saved flows without a customer session or resolver", async () => {
    await expect(resolveSavedTpayPaymentMethodForCheckout({
      req: request(null),
      paymentExecution: { provider: "tpay", flow: "blik_one_click", savedMethodId: SAVED_METHOD_ID },
      clientId: "client-1",
      savedPaymentMethodResolverPort: createResolver(null),
      now: () => new Date("2026-06-24T12:00:00Z"),
      recordStage: async (_stage, operation) => operation(),
    })).resolves.toEqual({ kind: "rejected", reason: "saved_payment_method_session_required" });

    await expect(resolveSavedTpayPaymentMethodForCheckout({
      req: request("Bearer access-token"),
      paymentExecution: {
        provider: "tpay",
        flow: "blik_recurring_saved",
        savedMethodId: SAVED_METHOD_ID,
        recurringModel: "M",
      },
      clientId: "client-1",
      now: () => new Date("2026-06-24T12:00:00Z"),
      recordStage: async (_stage, operation) => operation(),
    })).resolves.toEqual({ kind: "rejected", reason: "saved_payment_method_resolver_unavailable" });
  });

  it("ignores non-saved payment execution flows", async () => {
    await expect(resolveSavedTpayPaymentMethodForCheckout({
      req: request(null),
      paymentExecution: { provider: "tpay", flow: "blik_one_time", blikToken: "123456" },
      clientId: "client-1",
      savedPaymentMethodResolverPort: createResolver(null),
      now: () => new Date("2026-06-24T12:00:00Z"),
      recordStage: async (_stage, operation) => operation(),
    })).resolves.toEqual({ kind: "none" });
  });
});

function createResolver(
  result: Awaited<ReturnType<CheckoutSavedPaymentMethodResolverPort["resolveSavedPaymentMethod"]>>,
): CheckoutSavedPaymentMethodResolverPort {
  return {
    resolveSavedPaymentMethod: vi.fn(async () => result),
  };
}

function request(authorization: string | null): VercelRequest {
  return { headers: authorization ? { authorization } : {} } as unknown as VercelRequest;
}
