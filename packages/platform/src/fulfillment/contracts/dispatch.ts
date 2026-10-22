type DeliveryKind = "parcel-locker" | "courier";
type PickupPoint = { id: string; provider: string; name: string; address: { line1: string; postalCode: string; city: string; country: string } };
export interface FulfillmentSelection {
  providerRef: string | null;
  carrierRef: string | null;
  serviceRef: string | null;
  deliveryKind: DeliveryKind;
  pickupPoint: PickupPoint | null;
}
export interface FulfillmentRefusal {
  reason: "not_dispatchable" | "selection_required" | "provider_mismatch" | "carrier_service_required" | "disabled" | "not_ready" | "unsupported" | "withheld" | "claim_conflict" | "contact_stale" | "stock_contention" | "local_missing" | "io_failure" | "malformed" | "untrusted" | "unsupported_event" | "stale" | "missing_correlation";
  phase: "selection" | "prepare" | "claim" | "begin" | "dispatch" | "acknowledge" | "verify" | "normalize" | "apply" | "readback" | "sync";
  retryable: boolean;
}
/** Frozen domain input. Contact PII stays transient; only allowlisted mapped items enter evidence. Credentials stay in adapter closures. */
export interface FulfillmentDispatchRequest {
  requestKey: string;
  fulfillmentRef: string;
  orderRef: string;
  orderNumber: string | null;
  parcelRef: string | null;
  contactRevision: { schemaVersion: number; source: string; revision: number };
  recipient: { name: string | null; email: string | null; phone: string | null; line1: string; line2: string | null; city: string; postalCode: string; country: string; deliveryInstructions: string | null; courierInstructions: string | null };
  lines: readonly { skuRef: string; title: string | null; quantity: number; productRef: string | null; packRef: string | null; lotRef?: string | null; expirationDate?: string | null }[];
  selection: FulfillmentSelection;
}
/** Allowlisted durable evidence; fingerprint commits to actual adapter command bytes. */
export interface DispatchEvidence {
  commandFingerprint: string;
  contactRevision: FulfillmentDispatchRequest["contactRevision"];
  providerRef: string;
  carrierRef: string | null;
  serviceRef: string | null;
  transcript?: {
    itemCount: number;
    items: readonly { skuRef: string; quantity: number; lotRef: string | null; expirationDate: string | null }[];
    deliveryKind: DeliveryKind; pickupPointRef: string | null;
    /** Count of populated reference/date fields redacted by the durable projection. */
    redactedFieldCount?: number;
  };
  mapping?: { source: "dispatch_worker"; mode: "shadow" | "stage" | "live"; shadowMode: boolean };
}
export interface FulfillmentOperationError {
  code: string; status: number | null; retryable: boolean; mayHaveSucceeded: boolean;
  /** Machine cause only; never an arbitrary exception message. */
  cause?: string;
}
export type FulfillmentDispatchResult = ({ error?: FulfillmentOperationError } & (
  | { kind: "accepted"; externalRef: string; evidence: DispatchEvidence; providerAttemptKey: string; labelKey: string; recovery?: { source: "persisted_acceptance"; proof: "persisted_external_ref"; noProviderPost: true } }
  | { kind: "not_dispatched"; effectMayHaveSucceeded: false; refusal: FulfillmentRefusal }
  | { kind: "unknown"; effectMayHaveSucceeded: true; refusal: FulfillmentRefusal }));
export type FulfillmentDispatchPrepareResult =
  | { kind: "prepared"; evidence: DispatchEvidence }
  | { kind: "refused"; refusal: FulfillmentRefusal };
export interface FulfillmentDispatchPort {
  /**
   * Without external submission, build the actual command and fingerprint its bytes
   * before store claim/begin. Return only sanitized evidence; keep the raw command
   * transient inside the adapter. Refuse not_dispatchable or the exact selection
   * refusal when preparation cannot proceed. A contact_stale remap requires a new
   * prepare of the rebuilt request/command before another claim/begin.
   */
  prepare(request: FulfillmentDispatchRequest): Promise<FulfillmentDispatchPrepareResult>;
  /**
   * Send exactly the prepared command identified by this evidence. Never silently
   * rebuild a different command; absent/mismatched preparation refuses before I/O.
   * Absent/mismatched preparation: not_dispatchable, phase dispatch, retryable false.
   * Unknown submission outcomes require readback, never blind re-submission.
   */
  dispatch(request: FulfillmentDispatchRequest, evidence: DispatchEvidence): Promise<FulfillmentDispatchResult>;
}
