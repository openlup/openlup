import type { ContinuationRecord, ContinuationRecordStorageBinding, IdentifierBinding, StorageFailurePolicy } from "./bindings.js";
import { toAttemptNumber, toContinuationId, type ContinuationId } from "./identity.js";

/**
 * Returns the continuation identity of the current purchase, or `null` when
 * its storage did not keep a new identity: `null` means nothing may be sent.
 *
 * 1. It reads the record. When one is stored and `identifier.accepts` accepts
 *    its identity, it returns that identity. Reuse writes nothing, does not
 *    call `fingerprint` and reads nothing back, under every policy.
 * 2. Otherwise it calls `identifier.next()`, then `fingerprint()`, and writes
 *    a new record with that fingerprint and identity and no attempt, replacing
 *    any stored record.
 * 3. Under `storageFailure: "continue_unpersisted"` it returns the new
 *    identity without reading it back, whether or not it was kept.
 * 4. Under any other value (absent, `"refuse"`, or a member this version does
 *    not know) it reads the record once more and returns the new identity only
 *    when that record names it and the fingerprint just written; `attempt` is
 *    not compared, so a codec may read an absent attempt as `0`. Otherwise it
 *    returns `null`.
 * 5. A refusal has no other effect: no second identity, no clear, no retry,
 *    no event.
 * 6. It catches nothing: an error a binding or `fingerprint` raises propagates
 *    as the same object, and a write that throws is not read back.
 *
 * One purchase therefore keeps one identity across payload changes until
 * `clearContinuationRecord` runs. The result type includes `null` under every
 * policy, so a `continue_unpersisted` caller narrows it too.
 *
 * On `null`, send nothing and let the buyer try again once storage is
 * available. The cause is a storage binding that did not keep the record it
 * was given: the browser refused or dropped the write, or the binding's codec
 * reads back another identity or fingerprint than it was written. A codec
 * reads back the `continuationId` and `fingerprint` it wrote. Passing the
 * deprecated `continue_unpersisted` restores the earlier behaviour, which can
 * create a second order.
 */
export function getOrCreateContinuationId(
  bindings: { storage: ContinuationRecordStorageBinding; identifier: IdentifierBinding },
  input: { fingerprint: () => string; storageFailure?: StorageFailurePolicy },
): ContinuationId | null {
  const record = bindings.storage.read();
  if (record && bindings.identifier.accepts(record.continuationId)) return record.continuationId;

  const continuationId = toContinuationId(bindings.identifier.next());
  const fingerprint = input.fingerprint();
  bindings.storage.write({ fingerprint, continuationId });
  if (input.storageFailure === "continue_unpersisted") return continuationId;
  const kept = bindings.storage.read();
  return kept && kept.continuationId === continuationId && kept.fingerprint === fingerprint ? continuationId : null;
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
