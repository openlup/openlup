import type { InvoiceProof, InvoiceUnsupported } from "./provider.js";
/** Injected registry seam. Host owns identifier validation, freshness and fallback;
 * lookup evidence never overwrites checkout truth or becomes a renewal prerequisite.
 * Carrier: accountingControlContracts lookup fields, generalized per A5 fit probe.
 */
export interface InvoiceCompanyLookupPort {
  lookup(input: { readonly identifier: { readonly scheme: string; readonly value: string; readonly country?: string }; readonly asOf: string; readonly sourceRef: string }): Promise<
    | { readonly kind: "found" | "partial"; readonly identifier: { readonly scheme: string; readonly value: string; readonly country?: string }; readonly legalName: string | null; readonly registrationIds: readonly { readonly scheme: string; readonly value: string }[]; readonly address: { readonly line1: string; readonly postalCode: string; readonly city: string; readonly country: string } | null; readonly taxRegistrations: readonly { readonly scheme: string; readonly status: "active" | "not_registered" | "exempt" | "unknown" }[]; readonly sourceRef: string; readonly proof: InvoiceProof }
    | { readonly kind: "not_found"; readonly sourceRef: string; readonly proof: InvoiceProof }
    | { readonly kind: "unknown"; readonly sourceRef: string; readonly code: "unknown" }
    | InvoiceUnsupported
  >;
}
