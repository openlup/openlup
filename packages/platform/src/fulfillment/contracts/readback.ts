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
