import type { FulfillmentDispatchRequest, FulfillmentRefusal } from "./dispatch.js";
/** Durable storage pointer. No signed URL or credential belongs here. */
export interface LabelDocument { objectRef: string; mediaType: "application/pdf"; externalRef: string | null }
export interface FulfillmentLabelPort {
  create(input: FulfillmentDispatchRequest): Promise<{ kind: "created"; parcelRef: string; document: LabelDocument | null } | { kind: "refused"; refusal: FulfillmentRefusal }>;
  /** Transient host response only; never part of a store record. */
  read(document: LabelDocument): Promise<{ kind: "available"; url: string; expiresAt: string | null } | { kind: "refused"; refusal: FulfillmentRefusal }>;
  void(input: { parcelRef: string; document: LabelDocument | null }): Promise<{ providerDeletion: "confirmed" | "unconfirmed"; labelDeleted: boolean; canProceed: boolean; refusal?: FulfillmentRefusal }>;
}
