// What a delivery attempt reports back, in vocabulary this domain owns.
//
// Split out of the dispatch port contracts because it is the one part of them a
// TRANSPORT has to speak: an adapter implementing delivery imports this and
// nothing else, and the ports file keeps the reads, scans and email inputs the
// dispatcher needs. Nothing here names a vendor.

/**
 * What the transport made of a refused send, in vocabulary the domain owns.
 *
 * The worker used to branch on one delivery vendor's machine code and persist
 * that code verbatim, which made a vendor's error dictionary part of this
 * contract: a second transport could not answer the question, and the dunning
 * row recorded a string only that vendor's docs explained. The mapping from a
 * transport's own codes to these two facts now happens at the adapter edge.
 */
export interface DunningTransportOutcome {
  /** True when another attempt may succeed; false when the refusal is settled. */
  transient: boolean;
  /** Neutral machine code, persisted as the row's error. Never a vendor string. */
  reasonCode: string;
}

// The reason codes a refusal may be persisted under: unreachable service, a
// settled refusal, a run-timeout cancellation, "too fast, try later", an
// identical request still executing under this key, and a key already spent on a
// DIFFERENT request (which retrying cannot fix).
export const DUNNING_DELIVERY_UNAVAILABLE = "delivery_unavailable";
export const DUNNING_DELIVERY_REJECTED = "delivery_rejected";
export const DUNNING_DELIVERY_ABORTED = "delivery_aborted";
export const DUNNING_DELIVERY_RATE_LIMITED = "delivery_rate_limited";
export const DUNNING_DELIVERY_IDEMPOTENCY_IN_FLIGHT = "delivery_idempotency_in_flight";
export const DUNNING_DELIVERY_IDEMPOTENCY_CONFLICT = "delivery_idempotency_conflict";

export interface DunningEmailSendOutcome {
  ok: boolean;
  /**
   * The transport's own reference for the message it accepted, persisted as the
   * notice's delivery id. Null whenever nothing was accepted. The field used to
   * be named after one mail vendor, which made every other transport's answer
   * read as that vendor's — the captured rail's receipt key is a delivery id in
   * exactly the same sense, and the reconciliation join is what proves it.
   */
  deliveryId: string | null;
  httpStatus: number;
  /** Absent only on an accepted send; every refusal carries one. */
  transport?: DunningTransportOutcome | null;
  aborted: boolean;
  adminDisabled?: boolean;
  /** Terminal intentional non-send; callers must not count it as sent. */
  skipReason?: "admin_disabled" | "egress_suppressed" | null;
}

export function dunningEmailOutcomeFromDelivery(input: {
  accepted: boolean;
  deliveryId: string | null;
  retryable: boolean;
  errorCode: string | null;
}): DunningEmailSendOutcome {
  const aborted = input.errorCode === "aborted";
  return {
    ok: input.accepted,
    deliveryId: input.deliveryId,
    httpStatus: input.accepted ? 202 : input.retryable ? 503 : 422,
    // The delivery port's own codes are already neutral — it is a capability
    // contract, not a vendor client — so they pass through as the reason.
    transport: input.accepted ? null : {
      transient: input.retryable || aborted,
      reasonCode: aborted
        ? DUNNING_DELIVERY_ABORTED
        : input.errorCode ?? (input.retryable ? DUNNING_DELIVERY_UNAVAILABLE : DUNNING_DELIVERY_REJECTED),
    },
    aborted,
  };
}
