import { describe, expect, it, vi } from "vitest";
import type { HttpRequest } from "../../src/http/index.js";
import { resolveSavedPaymentMethodForCheckout } from "./checkoutTestFixtures.js";
type CheckoutSavedPaymentMethodResolverPort = NonNullable<Parameters<typeof resolveSavedPaymentMethodForCheckout>[0]["savedPaymentMethodResolverPort"]>;

const SAVED_METHOD_ID = "22222222-2222-4222-8222-222222222222";

describe("checkout saved provider payment method resolver", () => {
  it("resolves saved method refs only through the server-side resolver port", async () => {
    const resolver = createResolver({
      providerMethodRef: "method_secret",
      providerAliasType: "stored_reference",
      recurringModel: "initial",
    });
    const recordedStages: string[] = [];
    const recordStage = async <T>(stage: "payment_method_ref", operation: () => Promise<T>): Promise<T> => {
      recordedStages.push(stage);
      return operation();
    };

    await expect(resolveSavedPaymentMethodForCheckout({
      req: request("Bearer access-token"),
      paymentExecution: { provider: "redirect", flow: "saved_once", savedMethodId: SAVED_METHOD_ID },
      clientId: "client-1",
      savedPaymentMethodResolverPort: resolver,
      now: () => new Date("1999-06-24T12:00:00Z"),
      recordStage,
    })).resolves.toEqual({
      kind: "resolved",
      paymentMethodRef: "method_secret",
      paymentMethodAliasType: "stored_reference",
      paymentMethodRecurringModel: "initial",
    });

    expect(resolver.resolveSavedPaymentMethod).toHaveBeenCalledWith({
      accessToken: "access-token",
      clientId: "client-1",
      savedMethodId: SAVED_METHOD_ID,
      requestedFlow: "saved_once",
      now: new Date("1999-06-24T12:00:00Z"),
    });
    expect(recordedStages).toEqual(["payment_method_ref"]);
  });

  it("fails closed for saved flows without a customer session or resolver", async () => {
    await expect(resolveSavedPaymentMethodForCheckout({
      req: request(null),
      paymentExecution: { provider: "redirect", flow: "saved_once", savedMethodId: SAVED_METHOD_ID },
      clientId: "client-1",
      savedPaymentMethodResolverPort: createResolver(null),
      now: () => new Date("1999-06-24T12:00:00Z"),
      recordStage: async (_stage, operation) => operation(),
    })).resolves.toEqual({ kind: "rejected", reason: "saved_payment_method_session_required" });

    await expect(resolveSavedPaymentMethodForCheckout({
      req: request("Bearer access-token"),
      paymentExecution: {
        provider: "redirect",
        flow: "saved_recurring",
        savedMethodId: SAVED_METHOD_ID,
        recurringModel: "subsequent",
      },
      clientId: "client-1",
      now: () => new Date("1999-06-24T12:00:00Z"),
      recordStage: async (_stage, operation) => operation(),
    })).resolves.toEqual({ kind: "rejected", reason: "saved_payment_method_resolver_unavailable" });
  });

  it("ignores non-saved payment execution flows", async () => {
    await expect(resolveSavedPaymentMethodForCheckout({
      req: request(null),
      paymentExecution: { provider: "redirect", flow: "one_time", transientCode: "123456" },
      clientId: "client-1",
      savedPaymentMethodResolverPort: createResolver(null),
      now: () => new Date("1999-06-24T12:00:00Z"),
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

function request(authorization: string | null): HttpRequest {
  return { headers: authorization ? { authorization } : {} } as unknown as HttpRequest;
}
