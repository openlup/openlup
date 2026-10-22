import type { FulfillmentObservation } from "./observation.js";
import type { FulfillmentRefusal } from "./dispatch.js";
export type FulfillmentReadbackResult =
  | { kind: "found"; externalRef: string; createdAt: string | null; updatedAt: string | null; observation: FulfillmentObservation }
  | { kind: "absent"; scope: { providerRef: string; requestKey: string; fulfillmentRef: string; externalRef: string | null }; proof: { kind: "authoritative_exact_lookup"; evidenceRef: `evidence:${string}`; checkedAt: string } }
  | { kind: "unknown"; refusal: FulfillmentRefusal }
  | { kind: "unsupported"; refusal: FulfillmentRefusal };
export interface FulfillmentReadbackPort {
  /** Empty pages and missing local rows cannot certify external absence. */
  read(input: { providerRef: string; requestKey: string; fulfillmentRef: string; externalRef: string | null; mode: "command" | "parcel" }): Promise<FulfillmentReadbackResult>;
}

/** Collection observation is separate from authoritative exact lookup. */
export type FulfillmentReconciliationObservation = FulfillmentReadbackResult | {
  kind: "unmapped"; externalRef: string | null;
  evidence: Pick<FulfillmentObservation, "correlation" | "eventKey" | "providerStatus">;
};
export interface FulfillmentObservationPagePort {
  readPage(input: { page: number; size: number }): Promise<
    | { kind: "page"; rows: readonly FulfillmentReconciliationObservation[] }
    | { kind: "page_exhausted" }
    | { kind: "failed"; refusal: FulfillmentRefusal; error?: import("./dispatch.js").FulfillmentOperationError }
  >;
}
