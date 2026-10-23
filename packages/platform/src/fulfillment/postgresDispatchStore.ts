import type { DispatchRecord, FulfillmentDispatchRequest, FulfillmentStorePort } from './contracts/index.js';
import { dispatchEvidence, dispatchResult } from './dispatchProjection.js';
import type { createFulfillmentCommandLedger } from './providerCommandLedger.js';

/** Caller supplies a driver and its selected host preparation/data boundary. */
export interface PgExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export async function nativeCall<T>(db: PgExecutor, name: string, values: unknown[]): Promise<T> {
  const result = await db.query(`SELECT public.${name}(${values.map((_, index) => `$${index + 1}`).join(',')}) AS response`, values);
  if (!result.rows[0] || result.rows[0].response === undefined) throw new Error('fulfillment_native_response_missing');
  return result.rows[0].response as T;
}

export function createPostgresFulfillmentDispatchStore(db: PgExecutor, host: {
  /** Synchronize authoritative withholding/contact revision on prepare and every source edit. */
  prepare(fulfillmentRef: string): ReturnType<FulfillmentStorePort['prepare']>;
  readCandidate(fulfillmentRef: string): Promise<FulfillmentDispatchRequest | null>;
}): FulfillmentStorePort & { commandLedger: ReturnType<typeof createFulfillmentCommandLedger> } {
  return {
    readCandidate: ref => host.readCandidate(ref),
    prepare: ref => host.prepare(ref),
    async read(key) {
      const result = await db.query("SELECT public.fulfillment_dispatch_read(ref) || jsonb_build_object('acceptance',ref.acceptance) AS response FROM public.fulfillment_dispatch_refs ref WHERE request_key=$1", [key]);
      return result.rows[0]?.response as DispatchRecord | undefined ?? null;
    },
    claim: input => nativeCall(db, 'fulfillment_dispatch_claim', [input.requestKey, input.fulfillmentRef, input.orderRef, input.parcelRef, input.mode, JSON.stringify(dispatchEvidence(input.evidence))]),
    recordProviderAttempt: (key, ref, evidence, mode) => nativeCall(db, 'fulfillment_record_provider_attempt', [key, ref, JSON.stringify(dispatchEvidence(evidence)), mode]),
    begin: input => nativeCall(db, 'fulfillment_dispatch_begin', [input.dispatchRef, input.commandFingerprint]),
    finalize: input => nativeCall(db, 'fulfillment_dispatch_finish', [input.dispatchRef, JSON.stringify(dispatchResult(input.result)), false]),
    acknowledge: input => nativeCall(db, 'fulfillment_dispatch_finish', [input.dispatchRef, JSON.stringify(dispatchResult(input.acceptance)), true]),
    async markStaleSubmissionsUncertain(staleBefore) {
      const result = await db.query("UPDATE public.fulfillment_dispatch_refs SET status='uncertain',updated_at=now() WHERE status='submitting' AND updated_at<$1 RETURNING id", [staleBefore]);
      return result.rows.length;
    },
    commandLedger: commandLedger(db),
  };
}
function commandLedger(db: PgExecutor): ReturnType<typeof createFulfillmentCommandLedger> {
  const fence = (v: { commandId: string; claimToken: string; claimGeneration: number; expectedVersion: number }) => [v.commandId, v.claimToken, v.claimGeneration, v.expectedVersion];
  return {
    enqueue: v => nativeCall(db, 'commerce_fulfillment_enqueue_provider_command', [v.fulfillmentRef, v.providerRef, v.commandKind, v.contractVersion, v.idempotencyKey, v.commandKeyFingerprint, v.commandPayloadFingerprint, v.providerIdempotencyKeyFingerprint, v.routingFingerprint, v.configurationFingerprint, v.correlationKeyFingerprint, v.retryBudget]),
    async claim(v) {
      const result = await db.query('SELECT public.commerce_fulfillment_claim_provider_commands($1,$2,$3,$4,$5) AS response', [v.providerRef, v.commandKind, v.limit, v.claimOwnerFingerprint, v.leaseSeconds]);
      return result.rows.map(row => row.response) as Awaited<ReturnType<ReturnType<typeof createFulfillmentCommandLedger>['claim']>>;
    },
    markSubmitting: v => nativeCall(db, 'commerce_fulfillment_mark_command_submitting', [...fence(v), v.providerAttemptRef]),
    applyWriteOutcome: v => nativeCall(db, 'commerce_fulfillment_apply_command_write_outcome', [...fence(v), v.identityFingerprint, v.kind, v.reason, v.kind === 'rejected' ? v.retryNotBefore : null, v.kind === 'accepted' ? v.providerReferenceFingerprint : null, v.providerAttemptRef, v.kind === 'rejected' ? v.proof.kind : null, v.kind === 'rejected' ? v.proof.fingerprint : null, v.kind === 'rejected' ? v.proof.observedAt : null, v.kind === 'rejected' ? v.proof.source : null]),
    confirm: v => nativeCall(db, 'commerce_fulfillment_confirm_provider_command', [...fence(v), v.identityFingerprint, v.providerAttemptRef, v.proof.kind, v.proof.fingerprint, v.proof.observedAt, v.proof.source]),
    reconcile: v => nativeCall(db, 'commerce_fulfillment_reconcile_provider_command', [v.commandId, v.expectedVersion, v.identityFingerprint, v.proof.kind, v.proof.fingerprint, v.proof.observedAt, v.proof.source]),
    resolve: v => nativeCall(db, 'commerce_fulfillment_resolve_uncertain_command', [v.commandId, v.expectedVersion, v.identityFingerprint, v.decision, v.reason, v.proof.kind, v.proof.fingerprint, v.proof.observedAt, v.proof.source, v.decision === 'retry_wait' ? v.retryNotBefore : null]),
    release: v => nativeCall(db, 'commerce_fulfillment_release_or_cancel_command', [...fence(v), v.action, v.reason]),
    recoverExpired: v => nativeCall(db, 'commerce_fulfillment_recover_expired_provider_commands', [v.limit]),
  };
}
