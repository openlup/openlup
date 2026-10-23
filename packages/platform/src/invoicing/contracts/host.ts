import type { InvoiceFacts, InvoiceSeller } from "./facts.js";
import type { InvoiceDocumentIdentity, InvoiceProof, InvoiceProviderPort, InvoiceUnsupported } from "./provider.js";
import type { InvoiceArtifactResult, InvoiceClearanceObservation, InvoiceDeliveryPort } from "./delivery.js";
import type { InvoiceCompanyLookupPort } from "./companyLookup.js";
import type { InvoiceSettlementPort } from "./settlement.js";
import type { InvoiceCapabilities } from "./capabilities.js";
import type { InvoiceStorePort } from "./store.js";
/** Host facts, fiscal routing, M07 reads, storage, registry, M04 delivery and M12
 * history are required selections. Every missing native capability refuses before
 * any write; an owed duty remains observable. This interface grants no authority.
 */
export interface InvoiceHostPorts {
  facts: { read(orderId: string): Promise<{ readonly kind: "found"; readonly facts: InvoiceFacts } | { readonly kind: "unknown"; readonly code: "missing_facts" } | InvoiceUnsupported> };
  /** Read the current host seller for the next claim, never per duty. Null orderId
   * means an unscoped claim (including corrections). P8 freezes this seller at
   * first claim; revisionRef feeds the claim wrapper's revision argument.
   */
  seller: { read(input: { readonly orderId: string | null }): Promise<{ readonly kind: "found"; readonly seller: InvoiceSeller; readonly revisionRef: string } | { readonly kind: "unknown"; readonly code: "unknown" } | InvoiceUnsupported> };
  /** Read-only projection of the final claimed M07 identity, never a refund writer.
   * Missing nullable money is unavailable, never fabricated zero or mismatch.
   */
  money: { read(input: { readonly intentRef: string; readonly providerRef: string; readonly providerPaymentRef: string | null; readonly expectedMoney: { readonly amountMinor: number; readonly currency: string } }): Promise<
    | { readonly kind: "observed"; readonly status: "succeeded" | "failed" | "pending"; readonly amountMinor: number | null; readonly currency: string | null; readonly proof: InvoiceProof }
    | { readonly kind: "absent"; readonly evidence: InvoiceProof & { readonly exact: true; readonly complete: true; readonly scope: Parameters<InvoiceHostPorts["money"]["read"]>[0] } }
    | { readonly kind: "unknown" | "unavailable"; readonly code: "money_unavailable" }
    | InvoiceUnsupported
  > };
  artifacts: {
    read(input: { readonly identity: InvoiceDocumentIdentity; readonly kind: "pdf" | "structured_document" | "clearance_receipt" }): Promise<InvoiceArtifactResult>;
    /** Ownership must already be authorized; response bytes are not a storage receipt. */
    download(input: { readonly identity: InvoiceDocumentIdentity; readonly artifactRef: string }): Promise<{ readonly kind: "downloaded"; readonly content: Uint8Array; readonly contentType: string } | { readonly kind: "unknown"; readonly code: "unknown" } | InvoiceUnsupported>;
    persist(input: { readonly identity: InvoiceDocumentIdentity; readonly kind: "pdf" | "structured_document" | "clearance_receipt"; readonly content: Uint8Array; readonly contentType: string }): Promise<Exclude<InvoiceArtifactResult, { kind: "absent" }>>;
  };
  /** Host identifier/tax/rounding policy; refs must match the selected descriptor.
   * No jurisdictional default is supplied. Carrier: TaxIdRoutingPort and injected
   * canonical tax safety in accountingProviderSnapshot.
   */
  fiscal: { verify(input: { readonly facts: InvoiceFacts; readonly policies: InvoiceCapabilities["policies"] }): Promise<{ readonly kind: "verified"; readonly documentKind: string; readonly clearanceRequired: boolean; readonly proof: InvoiceProof } | { readonly kind: "refused"; readonly code: "blocked" | "money_mismatch" } | { readonly kind: "unknown"; readonly code: "unknown" } | InvoiceUnsupported> };
  registry: InvoiceCompanyLookupPort;
  delivery: InvoiceDeliveryPort;
  clearance: { observe(input: { readonly identity: InvoiceDocumentIdentity; readonly providerDocumentRef: string }): Promise<{ readonly kind: "observed"; readonly observation: InvoiceClearanceObservation } | { readonly kind: "unknown"; readonly code: "unknown" } | InvoiceUnsupported> };
  settlement: InvoiceSettlementPort;
  policy: {
    /** Carrier: channelInvoicePolicyGate and the approved explicit operator skip.
     * Suppression receipts have no fabricated document ID. Host persists attribution.
     * Executor decides before installFacts: suppressed orders get no local document.
     * Readback consumers merge recorded receipts with duty readback.
     * Transient read failures return unknown without recording a receipt.
     */
    decide(input: { readonly requestKey: string; readonly lookup: { readonly by: "order"; readonly orderId: string } | { readonly by: "fulfillmentOrder"; readonly fulfillmentOrderRef: string } }): Promise<
      | { readonly kind: "issue"; readonly policyVersion: string }
      | { readonly kind: "policy_suppressed"; readonly outcome: "channel_issues" | "no_document"; readonly policyVersion: string; readonly requestKey: string }
      | { readonly kind: "operator_skipped"; readonly outcome: "operator_skip"; readonly actorRef: string; readonly reason: string; readonly requestKey: string }
      | { readonly kind: "unknown"; readonly code: "unknown" }
      | InvoiceUnsupported
    >;
    receipts(orderId: string): Promise<readonly (Extract<Awaited<ReturnType<InvoiceHostPorts["policy"]["decide"]>>, { kind: "policy_suppressed" | "operator_skipped" }> & { readonly recordedAt: string })[] | { readonly kind: "unknown"; readonly code: "unknown" } | InvoiceUnsupported>;
  };
  /** Authenticate and authorize ownership before reading artifacts. Safe projection
   * only: no buyer/seller payload, raw provider errors, signed URL or arbitrary meta.
   * Found is a complete owned projection; incomplete reads return unknown.
   * Carrier: donor document history + customer download ticket owner/lineage.
   */
  accountHistory: {
    read(input: { readonly accountRef: string; readonly orderId: string }): Promise<
      | { readonly kind: "found"; readonly accountRef: string; readonly orderId: string; readonly documents: readonly { readonly documentRef: string; readonly invoiceRef: string; readonly parentDocumentRef: string | null; readonly role: "original" | "correction" | "replacement"; readonly status: string; readonly issuedAt: string | null; readonly clearance: { readonly state: InvoiceClearanceObservation["state"]; readonly reference: string | null } | null; readonly documentKind: string | null; readonly artifact: "invoice" | "correction"; readonly providerDocumentNumber: string | null; readonly totalGrossMinor: number | null; readonly currency: string; readonly emailState: "not_requested" | "pending" | "provider_accepted" | "failed"; readonly isCurrent: boolean; readonly createdAt: string; readonly downloadAvailable: boolean }[] }
      | { readonly kind: "denied" }
      | { readonly kind: "unknown"; readonly code: "unknown" }
      | InvoiceUnsupported
    >;
    resolveDownload(input: { readonly accountRef: string; readonly orderId: string; readonly documentRef: string }): Promise<{ readonly kind: "authorized"; readonly identity: InvoiceDocumentIdentity; readonly artifactRef: string; readonly fileName: string; readonly parentDocumentRef: string | null } | { readonly kind: "denied" } | { readonly kind: "unknown"; readonly code: "unknown" } | InvoiceUnsupported>;
  };
}
/** Future service composition inputs only; no constructor, worker or runtime route
 * is supplied in P1. Closures/credentials must never be serialized with options.
 */
export interface InvoiceServicesOptions {
  readonly enabled?: boolean;
  readonly selection: { readonly providerRef: string } | null;
  readonly capability: InvoiceCapabilities | null;
  readonly provider: InvoiceProviderPort | null;
  readonly store: InvoiceStorePort | null;
  readonly host: InvoiceHostPorts;
  readiness(): Promise<{ readonly kind: "ready" } | InvoiceUnsupported>;
}
