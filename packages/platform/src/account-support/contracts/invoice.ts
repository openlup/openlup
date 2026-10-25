/** Exact browser-safe transcriptions of M09 account-history inputs and outcomes. */
export interface InvoiceDocumentIdentity {
  readonly providerRef: string;
  readonly documentRef: string;
  readonly providerDocumentRef: string | null;
  readonly orderRef: string;
  readonly invoiceRef: string;
  readonly parentProviderDocumentRef: string | null;
}
export interface InvoiceUnsupported {
  readonly kind: "unsupported";
  readonly code: "host_binding_required" | "unsupported";
  readonly retryable: false;
  readonly effectMayHaveSucceeded: false;
}
export type InvoiceClearanceState = "accepted" | "not_submitted" | "pending" | "rejected" | "not_required" | "unsupported";
export type InvoiceAccessPort = {
    read(input: { readonly accountRef: string; readonly orderId: string }): Promise<
      | { readonly kind: "found"; readonly accountRef: string; readonly orderId: string; readonly documents: readonly { readonly documentRef: string; readonly invoiceRef: string; readonly parentDocumentRef: string | null; readonly role: "original" | "correction" | "replacement"; readonly status: string; readonly issuedAt: string | null; readonly clearance: { readonly state: InvoiceClearanceState; readonly reference: string | null } | null; readonly documentKind: string | null; readonly artifact: "invoice" | "correction"; readonly providerDocumentNumber: string | null; readonly totalGrossMinor: number | null; readonly currency: string; readonly emailState: "not_requested" | "pending" | "provider_accepted" | "failed"; readonly isCurrent: boolean; readonly createdAt: string; readonly downloadAvailable: boolean }[] }
      | { readonly kind: "denied" }
      | { readonly kind: "unknown"; readonly code: "unknown" }
      | InvoiceUnsupported
    >;
    resolveDownload(input: { readonly accountRef: string; readonly orderId: string; readonly documentRef: string }): Promise<{ readonly kind: "authorized"; readonly identity: InvoiceDocumentIdentity; readonly artifactRef: string; readonly fileName: string; readonly parentDocumentRef: string | null } | { readonly kind: "denied" } | { readonly kind: "unknown"; readonly code: "unknown" } | InvoiceUnsupported>;
  };
