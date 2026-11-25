import type { ContinuationRecord, ContinuationRecordStorageBinding, IdentifierBinding } from "./bindings.js";
import { toAttemptNumber, toContinuationId, type ContinuationId } from "./identity.js";

/**
 * Returns the continuation identity of the current purchase.
 *
 * It reuses the stored record's identity when `identifier.accepts` accepts it;
 * reuse writes nothing and does not call `fingerprint`. Otherwise it calls
 * `identifier.next()`, then `fingerprint()`, writes a new record with that
 * fingerprint and identity and no attempt, replacing any stored record, and
 * returns the new identity. One purchase therefore keeps one identity across
 * payload changes until `clearContinuationRecord` runs.
 *
 * It reads no storage-failure policy. A storage binding that cannot reach its
 * storage returns `null` from `read` and drops `write`, so each call returns a
 * new identity that is not kept. An error a binding or `fingerprint` raises
 * propagates unchanged.
 */
export function getOrCreateContinuationId(
  bindings: { storage: ContinuationRecordStorageBinding; identifier: IdentifierBinding },
  input: { fingerprint: () => string },
): ContinuationId {
  const record = bindings.storage.read();
  if (record && bindings.identifier.accepts(record.continuationId)) return record.continuationId;

  const continuationId = toContinuationId(bindings.identifier.next());
  const fingerprint = input.fingerprint();
  bindings.storage.write({ fingerprint, continuationId });
  return continuationId;
}

/**
 * Returns the stored continuation record as the storage binding reads it, or
 * `null`. It applies no acceptance check and writes nothing, so it also returns
 * a record whose identity `getOrCreateContinuationId` would not reuse. An
 * absent `attempt` means the first attempt, `0`.
 */
export function readContinuationRecord(bindings: { storage: ContinuationRecordStorageBinding }): ContinuationRecord | null {
  return bindings.storage.read();
}

/**
 * Moves the stored record to its next payment attempt: it writes the record
 * with `attempt` one higher, reading an absent `attempt` as `0`, and keeps its
 * identity and fingerprint whatever the identity's format. With no stored
 * record it writes nothing. It is the only function that changes `attempt`.
 */
export function advanceAttempt(bindings: { storage: ContinuationRecordStorageBinding }): void {
  const record = bindings.storage.read();
  if (!record) return;
  bindings.storage.write({ ...record, attempt: toAttemptNumber((record.attempt ?? 0) + 1) });
}

/**
 * Clears the stored continuation record, so the next `getOrCreateContinuationId`
 * mints a new identity.
 */
export function clearContinuationRecord(bindings: { storage: ContinuationRecordStorageBinding }): void {
  bindings.storage.clear();
}
