import type { AccountSupportCapabilities } from "@openlup/platform/account-support/contracts";
import { NATIVE_SUBSCRIPTION_CAPABILITIES } from "@openlup/platform/subscriptions";
import { expect, it } from "vitest";
import type { PaymentRepairMethodPort } from "@openlup/platform/payments/contracts";
import { createPaymentMethodComposition, createSelfServiceCommandFacade } from "@openlup/platform/account-support";

const capabilities: AccountSupportCapabilities = {
  graph: "native", accountRead: { supported: false, refusalCode: "host_binding_required" },
  customer360Read: { supported: false, refusalCode: "host_binding_required" }, invoiceAccess: { supported: false, refusalCode: "host_binding_required" },
  paymentMethodSetup: { supported: false, refusalCode: "unsupported" }, commerceRecovery: { supported: false, refusalCode: "host_binding_required" },
  configuredPurchase: { supported: false, refusalCode: "host_binding_required" },
  operatorSubscription: { supported: false, refusalCode: "operator_subscription_authority_unavailable" },
  operatorContact: { supported: false, refusalCode: "operator_subscription_authority_unavailable" },
  subscriptions: NATIVE_SUBSCRIPTION_CAPABILITIES, communicationGifts: { supported: false, refusalCode: "unsupported_preference" },
};

const input = { customer: "customer", metadata: { source: "account", subscriptionId: "subscription" }, idempotencyKey: "setup-key" };
const ready = { kind: "ready" as const, setupRef: "setup", handoff: { kind: "redirect" as const, url: "https://example.invalid/setup" }, replayed: true };
const unsupported = { kind: "unsupported" as const }, methodError = new Error("method-owner-error");
const unconfigured: AccountSupportCapabilities = { ...capabilities, subscriptions: { ...capabilities.subscriptions,
  genericBundleCommands: { supported: false, refusalCode: "native_generic_bundle_commands_unsupported" },
  commandBoundReceipts: { supported: false, refusalCode: "native_command_bound_receipts_unsupported" },
} };
it.each([{ name: "ready", result: ready }, { name: "unsupported", result: unsupported }, { name: "error", result: methodError }])("C3 preserves M07 $name identity", async ({ result }) => {
  const transcript: unknown[] = [];
  const owner: PaymentRepairMethodPort = { async setupMethod(value) { expect(this).toBe(owner); transcript.push(value); if (result === methodError) throw methodError; return result as Awaited<ReturnType<PaymentRepairMethodPort["setupMethod"]>>; } };
  const facade = createSelfServiceCommandFacade({ context: { principalId: "actor", clientId: "client", graph: "native" },
    capabilities: { ...unconfigured, paymentMethodSetup: { supported: true } }, paymentMethod: createPaymentMethodComposition(owner) });
  if (result === methodError) await expect(facade.paymentMethod.execute("actor", input)).rejects.toBe(methodError);
  else expect(await facade.paymentMethod.execute("actor", input)).toBe(result);
  expect(transcript).toEqual([input]);
});

const request = { subscriptionId: "subscription" }, cause = new Error("owner-failure");
function accountLanes(result: object | null, transcript: unknown[]) {
  const owner = async (userId: string, value: typeof request) => {
    expect(userId).toBe("actor"); expect(value).toBe(request); transcript.push(value);
    if (result === cause) throw cause; return result;
  };
  const facade = createSelfServiceCommandFacade({ context: { principalId: "actor", clientId: "client", graph: "native" },
    capabilities: { ...unconfigured, paymentMethodSetup: { supported: true }, commerceRecovery: { supported: true }, configuredPurchase: { supported: true } },
    paymentMethod: { execute: owner }, profile: { updateProfile: owner }, commerce: { execute: owner }, recovery: { startPaymentRecovery: owner } });
  return {
    profile: (id: string) => facade.profile.updateProfile(id, request),
    commerce: (id: string) => facade.commerce.execute(id, request),
    recovery: (id: string) => facade.recovery.startPaymentRecovery(id, request),
    paymentMethod: (id: string) => facade.paymentMethod.execute(id, request),
  };
}
it.each(["profile", "commerce", "recovery", "paymentMethod"] as const)("C3 guards %s before the owner", async lane => {
  const transcript: unknown[] = [];
  await expect(accountLanes(null, transcript)[lane]("foreign")).rejects.toThrow("customer_principal_mismatch");
  expect(transcript).toEqual([]);
});
it.each((["profile", "commerce", "recovery"] as const).flatMap(lane => [
  { lane, name: "null", result: null }, { lane, name: "owner result", result: { owner: true } }, { lane, name: "error", result: cause },
]))("C3 preserves $lane $name", async ({ lane, result }) => {
  const transcript: unknown[] = [];
  if (result === cause) await expect(accountLanes(result, transcript)[lane]("actor")).rejects.toBe(cause);
  else expect(await accountLanes(result, transcript)[lane]("actor")).toBe(result);
  expect(transcript).toEqual([request]);
});
