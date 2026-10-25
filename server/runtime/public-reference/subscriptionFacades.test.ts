import { expect, it, vi } from "vitest";
import { createTransactionalDelivery } from "@openlup/platform/communications";
import type { TransactionalDeliveryReceipt, TransactionalDeliveryReceiptStore } from "@openlup/platform/communications";
import type { SubscriptionLifecycleFact } from "@openlup/platform/subscriptions";
import { NATIVE_SUBSCRIPTION_CAPABILITIES } from "@openlup/platform/subscriptions";
import { createReferenceSubscriptionFacades } from "./subscriptionFacades.js";

it.each([
  { kind: "stock_wait_resumed", template: "subscription-stock-wait-resumed" },
  { kind: "payment_failed", template: "subscription-payment-failed-2" },
] as const)("the reference facade delivers $kind through M04 and M04 owns replay deduplication", async ({ kind, template }) => {
  const ledger = new Map<string, TransactionalDeliveryReceipt>();
  const readReceipt = async (key: string) => ledger.get(key) ?? null;
  const store: TransactionalDeliveryReceiptStore = { readReceipt,
    async recordAccepted(input) { const receipt = { ...input, state: "accepted" as const, errorCode: null, attemptCount: 1 }; ledger.set(input.idempotencyKey, receipt); return receipt; },
    async recordFailed() { throw new Error("unexpected failure"); },
  };
  const deliver = vi.fn(async () => ({ deliveryReference: "captured:notice" }));
  const delivery = createTransactionalDelivery({ store, delivery: { deliver } });
  const apply = vi.fn(async () => ({ outcome: "refused" as const, reason: "subscription_command_payment_blocked" as const }));
  const facades = createReferenceSubscriptionFacades({ commands: { capabilities: NATIVE_SUBSCRIPTION_CAPABILITIES, apply },
    delivery: { ...delivery, readReceipt, bind: async descriptor => ({ recipientReference: descriptor.recipientRef, templateReference: descriptor.templateSlug }) } });
  const fact: SubscriptionLifecycleFact = { kind, factId: "fact", idempotencyKey: "wait:resumed", subscriptionId: "sub", clientId: "client",
    cycleId: null, caseId: "case", orderId: "order", occurredAt: "at", firstRecordedAt: "at", ...(kind === "stock_wait_resumed" ? { kind, frozenFingerprint: "frozen" } : { kind, retryAttempt: 2, nextRetryAt: "later", failureClass: "temporary", amountMinor: 200, currency: "XXX" }) };
  const input = { fact, messageKey: fact.idempotencyKey, recipientRef: "customer:1", locale: "en", recoveryUrlPath: null };
  expect(await facades.messages.deliver(input)).toEqual({ notificationId: "captured:notice", replayed: false });
  expect(await facades.messages.deliver(input)).toEqual({ notificationId: "captured:notice", replayed: true });
  expect(deliver).toHaveBeenCalledExactlyOnceWith({ idempotencyKey: fact.idempotencyKey, recipientReference: "customer:1", templateReference: template });
  await expect(facades.messages.deliver({ ...input, recipientRef: "customer:2" })).rejects.toThrow("conflict");
  await facades.commands.customerSkip({ actor: { kind: "customer", actorId: "a", clientId: "client" }, subscriptionId: "sub", idempotencyKey: "command-key", now: "at" });
  expect(apply).toHaveBeenCalledTimes(1);
});
