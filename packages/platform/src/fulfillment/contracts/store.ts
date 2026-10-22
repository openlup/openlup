import type { DispatchEvidence, FulfillmentDispatchRequest, FulfillmentDispatchResult, FulfillmentRefusal } from "./dispatch.js";
export interface DispatchRecord {
  dispatchRef: string; requestKey: string; fulfillmentRef: string; orderRef: string; parcelRef: string | null;
  externalRef: string | null; mode: "shadow" | "stage" | "live";
  status: "draft" | "submitting" | "created" | "uncertain" | "failed" | "cancel_requested" | "cancelled";
  evidence: DispatchEvidence; replayed: boolean;
  acceptance?: Extract<FulfillmentDispatchResult, { kind: "accepted" }> | null;
}
export interface FulfillmentStorePort {
  read(requestKey: string): Promise<DispatchRecord | null>;
  readCandidate(fulfillmentRef: string): Promise<FulfillmentDispatchRequest | null>;
  prepare(fulfillmentRef: string): Promise<{ disposition: "ready" | "withheld"; contactRevision: number | null }>;
  /** Evidence comes from adapter prepare, before any external submission. */
  claim(input: { requestKey: string; fulfillmentRef: string; orderRef: string; parcelRef: string | null; mode: DispatchRecord["mode"]; evidence: DispatchEvidence }): Promise<{ kind: "claimed"; record: DispatchRecord } | { kind: "refused"; refusal: FulfillmentRefusal }>;
  /** G14: idempotent mapped attempt; persist only prepared, sanitized evidence. */
  recordProviderAttempt(attemptKey: string, fulfillmentRef: string, preparedEvidence: DispatchEvidence, mode: DispatchRecord["mode"], status: "recorded"): Promise<{ replayed: boolean }>;
  /** Bind submission to the same prepared command fingerprint recorded by claim. */
  begin(input: { dispatchRef: string; commandFingerprint: string }): Promise<{ kind: "begun"; record: DispatchRecord; begun: boolean; replayed: boolean } | { kind: "refused"; refusal: FulfillmentRefusal }>;
  /** Accepted rescue retains externalRef as uncertain; only acknowledge closes the local acceptance atomically. */
  finalize(input: { dispatchRef: string; result: FulfillmentDispatchResult }): Promise<DispatchRecord>;
  acknowledge(input: { dispatchRef: string; acceptance: Extract<FulfillmentDispatchResult, { kind: "accepted" }> }): Promise<{ acknowledged: boolean; replayed: boolean; record: DispatchRecord }>;
  markStaleSubmissionsUncertain(staleBefore: string): Promise<number>;
}
export interface FulfillmentPaidHandoffPort {
  ensureObligation(input: { requestKey: string; orderRef: string; paidFactRef: string }): Promise<{ fulfillmentRef: string; replayed: boolean }>;
  acknowledge(input: { requestKey: string; fulfillmentRef: string }): Promise<{ acknowledged: boolean; replayed: boolean }>;
}
