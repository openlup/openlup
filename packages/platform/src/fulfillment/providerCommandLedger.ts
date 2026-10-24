/** Structural protocol for the contributed durable ledger. Each operation must
 * be one atomic store transaction, including its transition evidence. P4 owns SQL.
 * This factory holds no leases, retry counters, commands or persistence in memory.
 */
type CommandStatus = "queued" | "claimed" | "submitting" | "accepted" | "confirmed" | "retry_wait" | "uncertain" | "manual_review" | "terminal_rejected" | "cancelled";
type CommandResult = { commandId: string; status: CommandStatus; version: number; applied: boolean };
type Fence = { commandId: string; claimToken: string; claimGeneration: number; expectedVersion: number };
type Proof = { kind: "provider_reference" | "correlation_key" | "provider_idempotency_key"; fingerprint: string; observedAt: string; source: "provider_lookup" | "provider_webhook" | "operator_verified" };
type ClaimedCommand = {
  commandId: string; fulfillmentRef: string; orderRef: string; providerRef: string;
  commandKind: "dispatch_create"; contractVersion: "1"; status: "claimed"; version: number;
  commandKeyFingerprint: string; commandPayloadFingerprint: string; providerIdempotencyKeyFingerprint: string | null;
  routingFingerprint: string; configurationFingerprint: string; correlationKeyFingerprint: string;
  retryBudget: number; retryCount: number; claimToken: string; claimGeneration: number; leaseExpiresAt: string;
};
type LedgerStore = {
  enqueue(input: { fulfillmentRef: string; providerRef: string; commandKind: "dispatch_create"; contractVersion: "1";
    idempotencyKey: string; commandKeyFingerprint: string; commandPayloadFingerprint: string;
    providerIdempotencyKeyFingerprint: string | null; routingFingerprint: string; configurationFingerprint: string;
    correlationKeyFingerprint: string; retryBudget: number }): Promise<CommandResult>;
  claim(input: { providerRef: string; commandKind: "dispatch_create"; limit: number; claimOwnerFingerprint: string; leaseSeconds: number }): Promise<readonly ClaimedCommand[]>;
  markSubmitting(input: Fence & { providerAttemptRef: string | null }): Promise<CommandResult>;
  applyWriteOutcome(input: Fence & { identityFingerprint: string; providerAttemptRef: string | null } & (
    { kind: "accepted"; reason: "provider_accepted"; providerReferenceFingerprint: string }
    | { kind: "uncertain"; reason: "write_uncertain" }
    | { kind: "rejected"; reason: "safe_rejection" | "terminal_rejection"; retryNotBefore: string | null;
        proof: { kind: "definitive_provider_rejection"; fingerprint: string; observedAt: string; source: "provider_response" } }
  )): Promise<CommandResult>;
  confirm(input: Fence & { identityFingerprint: string; providerAttemptRef: string | null; proof: Proof }): Promise<CommandResult>;
  reconcile(input: { commandId: string; expectedVersion: number; identityFingerprint: string; proof: Proof }): Promise<CommandResult & { proofRecorded: boolean }>;
  resolve(input: { commandId: string; expectedVersion: number; identityFingerprint: string } & (
    { decision: "manual_review"; reason: "effect_unknown" | "identity_mismatch" | "invalid_contract" | "unsafe_retry"; proof: Proof }
    | { decision: "retry_wait"; reason: "authoritative_absence"; retryNotBefore: string;
        proof: { kind: "authoritative_absence"; fingerprint: string; observedAt: string; source: "provider_lookup" } }
  )): Promise<CommandResult & { proofRecorded: boolean }>;
  release(input: Fence & ({ action: "release"; reason: "command_enqueued" } | { action: "cancel"; reason: "operator_cancelled" })): Promise<CommandResult>;
  recoverExpired(input: { limit: number }): Promise<readonly CommandResult[]>;
};

/** Bind the durable protocol without substituting a local state machine.
 * Store fences compare token, generation, version and unexpired lease together.
 * Expired claimed work becomes queued; expired submitting/accepted work becomes
 * uncertain. Only authoritative scoped absence may admit uncertain work to retry.
 * Claim respects availability/retry budget; finalization cannot invent absence.
 */
export function createFulfillmentCommandLedger(store: LedgerStore): LedgerStore {
  return {
    enqueue: input => store.enqueue(input), claim: input => store.claim(input),
    markSubmitting: input => store.markSubmitting(input), applyWriteOutcome: input => store.applyWriteOutcome(input),
    confirm: input => store.confirm(input), reconcile: input => store.reconcile(input),
    resolve: input => store.resolve(input), release: input => store.release(input), recoverExpired: input => store.recoverExpired(input),
  };
}
