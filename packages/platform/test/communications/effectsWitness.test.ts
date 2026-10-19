import { expect, it } from "vitest";
import { createTransactionalDelivery, TransactionalDeliveryUnavailableError } from "../../src/communications/transactionalDelivery.js";
import type { TransactionalDeliveryReceipt, TransactionalDeliveryReceiptStore } from "../../src/communications/contracts/transactionalDelivery.js";
import { runCommunicationSyncDispatch } from "../../src/communications/communicationSyncWorker.js";
import { fullNewsletterProviderCapabilities } from "../../src/communications/newsletterIntegrationContracts.js";
import type { NewsletterSyncEvent } from "../../src/communications/contracts/newsletter.js";

const command = { idempotencyKey: "notice:1", recipientReference: "reader:1", templateReference: "notice" };
const digest = "a".repeat(64);
const receipt: TransactionalDeliveryReceipt = { idempotencyKey: command.idempotencyKey, commandFingerprint: digest, state: "accepted", deliveryReference: "capture:1", errorCode: null, attemptCount: 1 };

it.each(["accepted", "replay", "conflict", "effect", "accepted-write", "failed-write"])("W3 receipt ordered complete effects: %s", async fault => {
  const calls: unknown[] = [];
  const store: TransactionalDeliveryReceiptStore = {
    async readReceipt(key) { calls.push(["read", key]); return fault === "replay" ? receipt : fault === "conflict" ? { ...receipt, commandFingerprint: "b".repeat(64) } : null; },
    async recordAccepted(value) { calls.push(["accepted", value]); if (fault === "accepted-write") throw Error("uncertain"); return receipt; },
    async recordFailed(value) { calls.push(["failed", value]); if (fault === "failed-write") throw Error("store"); return { ...receipt, state: "failed", deliveryReference: null, errorCode: value.errorCode }; },
  };
  const subject = createTransactionalDelivery({ store, delivery: { async deliver(value) { calls.push(["effect", value]); if (["effect", "failed-write"].includes(fault)) throw Error("transport"); return { deliveryReference: "capture:1" }; } } }, { fingerprint: () => digest });
  const run = subject.send(command);
  if (fault === "conflict") await expect(run).rejects.toThrow("transactional_delivery_command_conflict");
  else if (["effect", "accepted-write", "failed-write"].includes(fault)) await expect(run).rejects.toBeInstanceOf(TransactionalDeliveryUnavailableError);
  else expect(await run).toEqual(receipt);
  expect(calls).toEqual([["read", command.idempotencyKey], ...(["replay", "conflict"].includes(fault) ? [] : [
    ["effect", command], [fault === "effect" || fault === "failed-write" ? "failed" : "accepted", {
      idempotencyKey: command.idempotencyKey, commandFingerprint: digest,
      ...(["effect", "failed-write"].includes(fault) ? { errorCode: "captured_delivery_failed" } : { deliveryReference: "capture:1" }),
    }],
  ])]);
});

export const syncEvent: NewsletterSyncEvent = { id: "sync:1", claimToken: "claim:1", contactId: "contact:1", normalizedEmail: "reader@example.invalid", eventType: "subscribe", purpose: "marketing_newsletter", payload: {}, attemptCount: 0 };

it.each(["sent", "echo", "capability", "retry", "timeout", "stale", "settlement"])("W3 sync complete persistence transcript and fence: %s", async fault => {
  const calls: unknown[] = [];
  const event = { ...syncEvent, ...(fault === "echo" ? { originProviderKind: "synthetic" } : {}) };
  const result = await runCommunicationSyncDispatch({
    store: {
      async claimBatch(value) { calls.push(["claim", value]); return [event]; },
      async markSent(value) { calls.push(["sent", value]); if (fault === "settlement") throw Error("settlement"); return fault !== "stale"; },
      async markFailed(value) { calls.push(["failed", value]); return true; },
    },
    provider: { providerKind: "synthetic", capabilities: { ...fullNewsletterProviderCapabilities, subscribe: fault !== "capability" }, async sync(value) { calls.push(["effect", value]); if (fault === "timeout") throw Error("timeout"); return fault === "retry" ? { status: "retry", reason: "throttled", retryAfterSeconds: 17 } : { status: "sent", remoteProfileId: "remote:1" }; } },
  });
  const failed = ["retry", "timeout", "settlement"].includes(fault);
  expect(result).toMatchObject({ checked: 1, updated: failed || fault === "stale" ? 0 : 1, failures: failed ? 1 : 0 });
  expect(calls).toEqual([
    ["claim", { providerKind: "synthetic", batchSize: 25, visibilitySeconds: 300, maxAttempts: 8 }],
    ...(["echo", "capability"].includes(fault) ? [] : [["effect", event]]),
    ...(["retry", "timeout"].includes(fault) ? [] : [["sent", { eventId: event.id, claimToken: event.claimToken, providerKind: "synthetic", remoteProfileId: ["echo", "capability"].includes(fault) ? null : "remote:1", responseSummary: fault === "echo" ? { status: "skipped", reason: "origin_provider_echo_loop", originProviderKind: "synthetic", originProviderEventId: null } : fault === "capability" ? { status: "skipped", reason: "unsupported_provider_capability", eventType: "subscribe", requiredCapability: "subscribe" } : { status: "sent" } }]]),
    ...(failed ? [["failed", { eventId: event.id, claimToken: event.claimToken, providerKind: "synthetic", error: fault === "retry" ? "throttled" : fault, retry: true, backoffSeconds: fault === "retry" ? 17 : 300 }]] : []),
  ]);
});
