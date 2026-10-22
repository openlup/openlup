import type { InvoiceDiagnosticCode, InvoiceUnsupported } from "./provider.js";
export interface InvoiceCapabilities {
  readonly version: "invoicing.capabilities.v1";
  readonly providerRef: string;
  readonly fiscalScope: { readonly scopeRef: string; readonly version: string };
  readonly policies: { readonly identifierRef: string; readonly taxRef: string; readonly roundingRef: string };
  readonly documentKinds: readonly string[];
  readonly correctionKinds: readonly "full_reversal"[];
  readonly numberingOwner: "provider";
  readonly sellerTiming: "execution" | "first_claim";
  readonly operations: Readonly<Record<"issue" | "correction" | "recovery" | "readback" | "exactAbsence" | "remoteVoid" | "artifact" | "clearance" | "settlement" | "companyLookup", { readonly supported: true } | { readonly supported: false; readonly reason: "host_required" | "not_implemented" | "not_exposed" }>>;
  readonly defaultOff: true;
}
/** Interpretation only: no environment discovery, activation, writes or provider calls. */
export type InvoiceCapabilitySelection = InvoiceUnsupported | { readonly kind: "ready"; readonly capability: InvoiceCapabilities } | { readonly kind: "refused"; readonly code: Extract<InvoiceDiagnosticCode, "disabled" | "selection_required">; readonly retryable: false; readonly effectMayHaveSucceeded: false };
