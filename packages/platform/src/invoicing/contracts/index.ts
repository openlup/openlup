/** @consumer Frozen fact provider and installed declaration consumer. */
export type { InvoiceFacts, InvoiceLine, InvoiceSeller, InvoiceBuyer, InvoiceSellerRevision, InvoiceClaimedFacts } from "./facts.js";
/** @consumer A4 issue/correction bridge, adapters and operator proof readback. */
export type { InvoiceIdentity, InvoiceDocumentIdentity, InvoiceWriteResult, InvoiceReadbackResult, InvoiceProviderPort, InvoiceUnsupported, InvoiceDiagnosticCode, InvoiceProof } from "./provider.js";
/** @consumer Host artifact storage/download binding. */
export type { InvoiceArtifactResult, InvoiceClearanceObservation } from "./delivery.js";
/** @consumer Host payout item recorder and resolver. */
export type { InvoiceSettlementResult, InvoiceSettlementPort, InvoiceSettlementItem } from "./settlement.js";
/** @consumer Explicit host selection and readInvoiceCapabilities. */
export type { InvoiceCapabilities } from "./capabilities.js";
/** @consumer Injected registry adapter (A5). */
export type { InvoiceCompanyLookupPort } from "./companyLookup.js";
/** @consumer Managed/native persistence adapter and operator duty readback; no implementation supplied. */
export type { InvoiceStorePort, InvoiceDutyReadback } from "./store.js";
/** @consumer Host composition and offline port-fit witnesses. */
export type { InvoiceHostPorts, InvoiceServicesOptions } from "./host.js";
