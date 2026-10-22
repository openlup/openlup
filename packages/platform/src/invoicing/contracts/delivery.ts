import type { InvoiceIdentity, InvoiceProof, InvoiceUnsupported } from "./provider.js";
/** Durable opaque references; signed URLs and downloaded bytes are transient. */
export type InvoiceArtifactResult =
  | { readonly kind: "found"; readonly identity: InvoiceIdentity; readonly artifact: { readonly kind: "pdf" | "structured_document" | "clearance_receipt"; readonly ref: string; readonly owner: "provider" | "host_storage"; readonly mediaType: string; readonly proof: InvoiceProof } }
  | { readonly kind: "absent"; readonly identity: InvoiceIdentity; readonly proof: InvoiceProof & { readonly exact: true; readonly complete: true; readonly scope: { readonly identity: InvoiceIdentity; readonly kind: "pdf" | "structured_document" | "clearance_receipt"; readonly artifactRef: string | null } } }
  | { readonly kind: "unknown"; readonly identity: InvoiceIdentity; readonly code: "unknown" }
  | InvoiceUnsupported;
/** Observation only; unsupported is never not_required. No clearance submission. */
export interface InvoiceClearanceObservation {
  readonly state: "not_submitted" | "pending" | "rejected" | "accepted" | "not_required" | "unsupported";
  readonly reference: string | null;
  readonly proof: InvoiceProof;
}
export interface InvoiceDeliveryPort {
  /** Host M04 content/transport; provider acceptance is not inbox delivery.
   * Preserve delivery/request keys, recipient, filename and bytes. Validate PDF
   * type, size and signature before send; uncertain send must never repeat sending.
   */
  send(input: { readonly deliveryRef: string; readonly requestKey: string; readonly attemptCount: number; readonly documentRef: string; readonly orderId: string; readonly orderRef: string; readonly invoiceRef: string; readonly providerDocumentRef: string; readonly clientRef: string | null; readonly recipient: string; readonly source: string | null; readonly providerDocumentNumber: string | null; readonly filename: string; readonly content: Uint8Array; readonly contentType: string }): Promise<
    | { readonly kind: "provider_accepted"; readonly receiptRef: string; readonly proof: InvoiceProof }
    | { readonly kind: "failed_before_send"; readonly retryable: boolean; readonly code: "retryable" | "invalid_artifact" }
    | { readonly kind: "uncertain"; readonly code: "uncertain_delivery"; readonly receiptRef: string | null }
    | InvoiceUnsupported
  >;
}
