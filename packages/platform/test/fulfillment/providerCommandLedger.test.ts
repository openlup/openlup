import { expect, expectTypeOf, it } from "vitest";
import { createFulfillmentCommandLedger } from "../../src/fulfillment/index.js";

type Store = Parameters<typeof createFulfillmentCommandLedger>[0];
function fixture() {
  const seen: unknown[] = [];
  const result = { commandId: "command-a", status: "claimed" as const, version: 2, applied: true };
  const store: Store = {
    enqueue: async input => { seen.push(["enqueue", input]); return result; },
    claim: async input => { seen.push(["claim", input]); return []; },
    markSubmitting: async input => {
      seen.push(["markSubmitting", input]);
      if (input.claimToken !== "lease-a" || input.claimGeneration !== 3 || input.expectedVersion !== 2) throw new Error("fence_conflict");
      return { ...result, status: "submitting", version: 3 };
    },
    applyWriteOutcome: async input => { seen.push(["applyWriteOutcome", input]); return { ...result, status: input.kind === "accepted" ? "accepted" : "uncertain" }; },
    confirm: async input => { seen.push(["confirm", input]); return { ...result, status: "confirmed" }; },
    reconcile: async input => { seen.push(["reconcile", input]); return { ...result, proofRecorded: true }; },
    resolve: async input => { seen.push(["resolve", input]); return { ...result, proofRecorded: true }; },
    release: async input => { seen.push(["release", input]); return result; },
    recoverExpired: async input => { seen.push(["recoverExpired", input]); return [{ ...result, status: "uncertain" }]; },
  };
  return { ledger: createFulfillmentCommandLedger(store), seen };
}
it("passes the complete fence unchanged to durable transactions and propagates a stale-owner refusal", async () => {
  const f = fixture(), fence = { commandId: "command-a", claimToken: "lease-a", claimGeneration: 3, expectedVersion: 2, providerAttemptRef: null };
  expect(f.seen).toEqual([]);
  expect(await f.ledger.markSubmitting(fence)).toMatchObject({ status: "submitting", version: 3 });
  expect(f.seen[0]).toEqual(["markSubmitting", fence]);
  for (const stale of [{ ...fence, claimToken: "lease-old" }, { ...fence, claimGeneration: 2 }, { ...fence, expectedVersion: 1 }]) {
    await expect(f.ledger.markSubmitting(stale)).rejects.toThrow("fence_conflict");
  }
  expect(await f.ledger.recoverExpired({ limit: 10 })).toMatchObject([{ status: "uncertain" }]);
  // Store-side lease expiry/atomicity/concurrency are P4, not an in-memory claim.
  expectTypeOf<Parameters<Store["markSubmitting"]>[0]>().toHaveProperty("expectedVersion");
});
it("keeps proof-qualified absence separate from acceptance and routes replay/recovery operations without inventing retries", async () => {
  const f = fixture(), fingerprint = "a".repeat(64), fence = { commandId: "command-a", claimToken: "lease-a", claimGeneration: 3, expectedVersion: 3 };
  await f.ledger.enqueue({ fulfillmentRef: "fulfillment-a", providerRef: "warehouse-a", commandKind: "dispatch_create", contractVersion: "1", idempotencyKey: "opaque-host-key",
    commandKeyFingerprint: fingerprint, commandPayloadFingerprint: fingerprint, providerIdempotencyKeyFingerprint: null, routingFingerprint: fingerprint, configurationFingerprint: fingerprint, correlationKeyFingerprint: fingerprint, retryBudget: 0 });
  await f.ledger.claim({ providerRef: "warehouse-a", commandKind: "dispatch_create", limit: 1, claimOwnerFingerprint: fingerprint, leaseSeconds: 30 });
  await f.ledger.applyWriteOutcome({ ...fence, identityFingerprint: fingerprint, providerAttemptRef: null, kind: "accepted", reason: "provider_accepted", providerReferenceFingerprint: fingerprint });
  const proof = { kind: "provider_reference" as const, fingerprint, observedAt: "2026-10-21T10:00:00Z", source: "provider_lookup" as const };
  await f.ledger.confirm({ ...fence, identityFingerprint: fingerprint, providerAttemptRef: null, proof });
  await f.ledger.reconcile({ commandId: fence.commandId, expectedVersion: 4, identityFingerprint: fingerprint, proof });
  const resolution = { commandId: fence.commandId, expectedVersion: 4, identityFingerprint: fingerprint, decision: "retry_wait" as const, reason: "authoritative_absence" as const,
    retryNotBefore: "2026-10-21T10:10:00Z", proof: { ...proof, kind: "authoritative_absence" as const } };
  await f.ledger.resolve(resolution);
  await f.ledger.release({ ...fence, action: "release", reason: "command_enqueued" });
  expect(f.seen).toHaveLength(7); expect(f.seen[5]).toEqual(["resolve", resolution]);
  expectTypeOf<Parameters<Store["confirm"]>[0]["proof"]["kind"]>().toEqualTypeOf<"provider_reference" | "correlation_key" | "provider_idempotency_key">();
  expect(JSON.stringify(f.seen)).not.toMatch(/rawBody|headers|password|recipient/);
});
