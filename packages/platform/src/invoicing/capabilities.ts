import type { InvoiceCapabilities, InvoiceCapabilitySelection } from "./contracts/capabilities.js";
/** @consumer Host readiness / installed cold consumer. Default off and explicit
 * provider selection precede capability use; construction never selects a provider.
 */
export function readInvoiceCapabilities(input: { readonly enabled?: boolean; readonly selection: { readonly providerRef: string } | null; readonly capability: InvoiceCapabilities | null }): InvoiceCapabilitySelection {
  if (input.enabled !== true) return { kind: "refused", code: "disabled", retryable: false, effectMayHaveSucceeded: false };
  if (!input.selection || !input.capability || input.selection.providerRef !== input.capability.providerRef) return { kind: "refused", code: "selection_required", retryable: false, effectMayHaveSucceeded: false };
  return { kind: "ready", capability: input.capability };
}
