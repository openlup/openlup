import type { InvoiceHostPorts, InvoiceStorePort, InvoiceServicesOptions, InvoiceWriteResult } from "./contracts/index.js";

const refusal: Extract<InvoiceWriteResult, { kind: "unsupported" }> = Object.freeze({ kind: "unsupported", code: "host_binding_required", retryable: false, effectMayHaveSucceeded: false });
/** @consumer Host native binding / installed cold consumer. No executor, inputs,
 * provider or storage is inspected: every missing native seam refuses before writes.
 */
export function createNativeUnsupportedInvoicePorts(): { host: InvoiceHostPorts; store: InvoiceStorePort; provider: NonNullable<InvoiceServicesOptions["provider"]> } {
  const unsupported = async () => refusal;
  return {
    host: {
      facts: { read: unsupported }, seller: { read: unsupported }, money: { read: unsupported }, fiscal: { verify: unsupported },
      artifacts: { read: unsupported, download: unsupported, persist: unsupported }, registry: { lookup: unsupported },
      delivery: { send: unsupported }, clearance: { observe: unsupported }, settlement: { record: unsupported, resolve: unsupported },
      policy: { decide: unsupported, receipts: unsupported }, accountHistory: { read: unsupported, resolveDownload: unsupported },
    },
    store: {
      captureDuty: unsupported, installFacts: unsupported, sweep: unsupported, prepareFacts: unsupported, finishFacts: unsupported,
      readDuties: unsupported, claim: unsupported, preflight: unsupported, finish: unsupported, fail: unsupported,
      requestReversal: unsupported, requestLocalDocument: unsupported, listClearanceTargets: unsupported,
      recordObservation: unsupported, claimDeliveries: unsupported, settleDelivery: unsupported,
    },
    provider: { issue: unsupported, correct: unsupported, read: unsupported, void: unsupported },
  };
}
