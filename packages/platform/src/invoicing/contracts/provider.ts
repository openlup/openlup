import type { InvoiceFacts } from "./facts.js";
/** Original host key bytes, immutable revision and exact lookup scope travel together.
 * Carrier: providerPorts create options + approved exact-lookup envelope (fit probe).
 */
export interface InvoiceIdentity {
  readonly providerRef: string;
  readonly requestKey: string;
  /** Persisted create identity from claim, distinct from original host request key. */
  readonly providerCreateIdentity: string;
  readonly factRevision: string;
  readonly orderRef: string;
  readonly invoiceRef: string;
  readonly operation: "issue" | "full_reversal" | "remote_void";
  readonly correctionRef: string | null;
  readonly parentProviderDocumentRef: string | null;
}
/** A closed diagnostic allowlist in the neutral contract. Codes only. */
export type InvoiceDiagnosticCode =
  | "faulted" | "missing_facts" | "legacy_facts_unproved" | "retryable" | "blocked"
  | "unsupported" | "unknown" | "absent" | "host_binding_required"
  | "selection_required" | "disabled" | "identity_mismatch" | "parent_mismatch"
  | "money_mismatch" | "money_unavailable" | "invalid_artifact" | "uncertain_delivery";
export interface InvoiceUnsupported {
  readonly kind: "unsupported";
  readonly code: "host_binding_required" | "unsupported";
  readonly retryable: false;
  readonly effectMayHaveSucceeded: false;
}
/** Evidence references/fingerprints are adapter-filtered; never raw payloads or errors. */
export interface InvoiceProof {
  readonly evidenceRef: string;
  readonly fingerprint: string;
  readonly observedAt: string;
}
export type InvoiceWriteResult =
  | { readonly kind: "issued"; readonly identity: InvoiceIdentity; readonly providerDocumentRef: string; readonly providerDocumentNumber: string | null; readonly proof: InvoiceProof; readonly replayed: boolean }
  | { readonly kind: "refused"; readonly identity: InvoiceIdentity; readonly code: InvoiceDiagnosticCode; readonly retryable: boolean; readonly effectMayHaveSucceeded: false }
  | { readonly kind: "unknown"; readonly identity: InvoiceIdentity; readonly code: "unknown"; readonly effectMayHaveSucceeded: true }
  | InvoiceUnsupported;
/** Exact scope is the full identity, including operation, parent and revision.
 * Incomplete/truncated/failed lookup is unknown. Only exact complete absence can
 * authorize another create; found is proof, never a nullable lookup shortcut.
 */
export type InvoiceReadbackResult =
  | { readonly kind: "found"; readonly identity: InvoiceIdentity; readonly providerDocumentRef: string; readonly providerDocumentNumber: string | null; readonly proof: InvoiceProof }
  | { readonly kind: "absent"; readonly identity: InvoiceIdentity; readonly evidence: InvoiceProof & { readonly exact: true; readonly complete: true; readonly scope: InvoiceIdentity } }
  | { readonly kind: "unknown"; readonly identity: InvoiceIdentity; readonly code: "unknown" }
  | InvoiceUnsupported;
/** Correction bridge: positive immutable BEFORE facts, explicit zero AFTER,
 * stable correctionRef and parent proof. Retry requires exact recovery before I/O.
 * Carrier: donor createFullCorrection options and accountingProviderSnapshot.
 */
export interface InvoiceProviderPort {
  issue(input: { readonly identity: InvoiceIdentity & { readonly operation: "issue"; readonly correctionRef: null; readonly parentProviderDocumentRef: null }; readonly facts: InvoiceFacts; readonly recoveryLookupRequired: boolean }): Promise<InvoiceWriteResult>;
  correct(input: { readonly identity: InvoiceIdentity & { readonly operation: "full_reversal"; readonly correctionRef: string; readonly parentProviderDocumentRef: string }; readonly before: InvoiceFacts; readonly after: { readonly totalNetMinor: 0; readonly totalTaxMinor: 0; readonly totalGrossMinor: 0 }; readonly reason: string; readonly recoveryLookupRequired: boolean }): Promise<InvoiceWriteResult>;
  read(input: InvoiceIdentity): Promise<InvoiceReadbackResult>;
  /** No remote deletion implementation or local-void substitution. */
  void(input: InvoiceIdentity & { readonly operation: "remote_void" }): Promise<{ readonly kind: "voided"; readonly identity: InvoiceIdentity; readonly proof: InvoiceProof } | Exclude<InvoiceWriteResult, { kind: "issued" }>>;
}
