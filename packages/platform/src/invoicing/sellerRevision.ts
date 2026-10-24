import type { InvoiceSellerRevision } from "./contracts/facts.js";
import type { InvoiceUnsupported } from "./contracts/provider.js";

/** Read the host selection before leasing. Persistence and race serialization
 * belong exclusively to the pinned SQL wrapper, never to an in-memory cache.
 * Unknown/unsupported selection consumes no claim and must be retried by the host.
 */
export async function claimInvoiceSellerRevision<Seller extends object>(read: () => Promise<
  | ({ readonly kind: "found" } & InvoiceSellerRevision<Seller>)
  | { readonly kind: "unknown"; readonly code: "unknown" }
  | InvoiceUnsupported
>) {
  const selected = await read();
  if (selected.kind !== "found") return selected;
  if (!selected.seller || typeof selected.seller !== "object" || Array.isArray(selected.seller)
    || typeof selected.revisionRef !== "string" || !selected.revisionRef.trim()) {
    return { kind: "unsupported", code: "host_binding_required", retryable: false, effectMayHaveSucceeded: false } as const;
  }
  return { kind: "found", seller: selected.seller, revisionRef: selected.revisionRef } as const;
}
