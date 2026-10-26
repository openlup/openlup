import { expect, it, vi } from "vitest";
import { createAccountSupportBindings, createAccountSupportServices, createSelfServiceCommandFacade, type AccountSupportCapabilities } from "../../src/account-support/index.js";
import { NATIVE_SUBSCRIPTION_CAPABILITIES } from "../../src/subscriptions/index.js";

const unavailable = { supported: false as const, refusalCode: "host_binding_required" as const };
const capabilities: AccountSupportCapabilities = {
  graph: "native", accountRead: unavailable, customer360Read: unavailable, invoiceAccess: unavailable,
  commerceRecovery: unavailable, configuredPurchase: unavailable, paymentMethodSetup: { supported: false, refusalCode: "unsupported" },
  operatorContact: { supported: false, refusalCode: "operator_subscription_authority_unavailable" },
  operatorSubscription: { supported: false, refusalCode: "operator_subscription_authority_unavailable" },
  subscriptions: NATIVE_SUBSCRIPTION_CAPABILITIES, communicationGifts: { supported: false, refusalCode: "unsupported_preference" },
};

it.each([false, true])("B1 captures one graph and preserves the selected R3 owner transcript (failure=%s)", async fail => {
  const request = { actorId: "actor-a", clientId: "subject-b", subscriptionId: "subscription-c", action: "pause", payload: {}, idempotencyKey: "original-key", now: "original-time" };
  const receipt = { status: "applied", owner: "receipt" }, cause = Error("owner-error");
  const apply = vi.fn(async (input: typeof request) => { expect(input).toBe(request); if (fail) throw cause; return receipt; });
  const facade = createSelfServiceCommandFacade({ context: { principalId: "actor-a", clientId: "subject-b", graph: "native" }, capabilities,
    nativeRawSubscription: { apply, preview: async () => ({}) } });
  const options = { graph: "native" as const, capabilities: { ...capabilities }, operations: { subscriptionApply: facade.nativeRawSubscription.apply } };
  const binding = createAccountSupportBindings(options);
  options.capabilities.graph = "managed";
  options.operations.subscriptionApply = async () => ({ status: "wrong" });
  expect(binding.graph).toBe("native"); expect(binding.capabilities.graph).toBe("native");
  const services = createAccountSupportServices({ enabled: true, ...binding, readiness: async () => ({ kind: "ready" }) });
  if (fail) await expect(services.operations.subscriptionApply(request)).rejects.toBe(cause);
  else expect(await services.operations.subscriptionApply(request)).toBe(receipt);
  expect(apply).toHaveBeenCalledTimes(1);
  expect(Object.isFrozen(binding.operations)).toBe(true);
});

it.each([null, { checkoutStart: null }])("B2 refuses an unbound commerce selection %j", async commerce => {
  const binding = createAccountSupportBindings({ graph: "native", capabilities, operations: {}, commerce });
  expect(await binding.commerce("checkoutStart", { orderId: "order-a" })).toEqual({ kind: "unsupported", code: "host_binding_required" });
});

it("B3 preserves a selected owner's unsupported result without relabelling it", async () => {
  const unsupported = { kind: "unsupported", ownerReason: "original" }, input = { orderId: "order-b" };
  const checkoutStart = vi.fn(async (request: typeof input) => { expect(request).toBe(input); return unsupported; });
  const binding = createAccountSupportBindings({ graph: "native", capabilities, operations: {}, commerce: { checkoutStart } });
  expect(await binding.commerce("checkoutStart", input)).toBe(unsupported);
  expect(checkoutStart).toHaveBeenCalledTimes(1);
});
