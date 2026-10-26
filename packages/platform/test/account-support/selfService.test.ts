import type { AccountSupportCapabilities } from "@openlup/platform/account-support/contracts";
import { NATIVE_SUBSCRIPTION_CAPABILITIES } from "@openlup/platform/subscriptions";
import { expect, it } from "vitest";
import { createSelfServiceCommandFacade } from "../../src/account-support/index.js";

const capabilities: AccountSupportCapabilities = {
  graph: "native", accountRead: { supported: false, refusalCode: "host_binding_required" },
  customer360Read: { supported: false, refusalCode: "host_binding_required" }, invoiceAccess: { supported: false, refusalCode: "host_binding_required" },
  paymentMethodSetup: { supported: false, refusalCode: "unsupported" }, commerceRecovery: { supported: false, refusalCode: "host_binding_required" },
  configuredPurchase: { supported: false, refusalCode: "host_binding_required" },
  operatorSubscription: { supported: false, refusalCode: "operator_subscription_authority_unavailable" },
  operatorContact: { supported: false, refusalCode: "operator_subscription_authority_unavailable" },
  subscriptions: NATIVE_SUBSCRIPTION_CAPABILITIES, communicationGifts: { supported: false, refusalCode: "unsupported_preference" },
};

const request = { subscriptionId: "subscription-a", action: "cancel", idempotencyKey: "key", payload: { survey: { reason: "host" } } };
const changed = { status: "applied", extra: { owner: true } }, noop = { status: "noop" }, replay = { status: "replayed" }, refusal = { status: "refused", reason: "owner-code" };
const cause = new Error("owner-error");
it.each([
  { name: "change", result: changed }, { name: "noop", result: noop }, { name: "replay", result: replay },
  { name: "refusal", result: refusal }, { name: "null", result: null }, { name: "error", result: cause },
])("C1 preserves managed $name identity and transcript", async ({ result }) => {
  const transcript: unknown[] = [];
  const port = {
    async applyAction(principalId: string, input: typeof request) {
      expect(this).toBe(port); expect(principalId).toBe("principal"); expect(input).toBe(request);
      transcript.push(input); if (result === cause) throw cause; return result;
    },
    async previewAction(principalId: string, input: typeof request) {
      expect(this).toBe(port); expect(principalId).toBe("principal"); expect(input).toBe(request); return result;
    },
  };
  const facade = createSelfServiceCommandFacade({ context: { principalId: "principal", clientId: "client", graph: "managed" }, capabilities: { ...capabilities, graph: "managed" }, managedSubscription: port });
  if (result === cause) await expect(facade.managedSubscription.applyAction("principal", request)).rejects.toBe(cause);
  else expect(await facade.managedSubscription.applyAction("principal", request)).toBe(result);
  if (result === refusal) expect(await facade.managedSubscription.previewAction("principal", request)).toBe(refusal);
  expect(transcript).toEqual([request]);
});
it.each(["applyAction", "previewAction"] as const)("C1 guards managed %s before the owner", async method => {
  const transcript: unknown[] = [];
  const owner = async () => { transcript.push(request); return null; };
  const facade = createSelfServiceCommandFacade({ context: { principalId: "principal", clientId: "client", graph: "managed" }, capabilities: { ...capabilities, graph: "managed" }, managedSubscription: { applyAction: owner, previewAction: owner } });
  await expect(facade.managedSubscription[method]("foreign", request)).rejects.toThrow("customer_principal_mismatch");
  expect(transcript).toEqual([]);
});
