/** @consumer Frozen fact provider and installed declaration consumer. */
export type { InvoiceFacts, InvoiceLine, InvoiceSeller, InvoiceBuyer } from "./facts.js";
/** @consumer Issue/correction bridge and exact readback adapter. */
export type { InvoiceIdentity, InvoiceWriteResult, InvoiceReadbackResult } from "./provider.js";
/** @consumer Host artifact storage/download binding. */
export type { InvoiceArtifactResult } from "./delivery.js";
/** @consumer Host payout item recorder and resolver. */
export type { InvoiceSettlementResult } from "./settlement.js";
/** @consumer Explicit host selection and readInvoiceCapabilities. */
export type { InvoiceCapabilities } from "./capabilities.js";
/** @consumer Injected registry adapter (A5). */
export type { InvoiceCompanyLookupPort } from "./companyLookup.js";
/** @consumer Managed/native persistence adapter; no implementation supplied. */
export type { InvoiceStorePort } from "./store.js";
/** @consumer Host composition and offline port-fit witnesses. */
export type { InvoiceHostPorts, InvoiceServicesOptions } from "./host.js";
