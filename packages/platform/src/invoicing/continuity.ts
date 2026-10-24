import { collectInvoiceDuties } from "./dutyCollector.js";

/** Explicit independent host invocation, never an inline fulfillment/payment hook.
 * Durable source receipts and fact leases own replay, backoff and fault ceilings.
 * A collector outage remains visible and can be retried by the host later.
 * @consumer Reference native accounting runtime and installed cold consumer.
 */
export function createIndependentInvoiceDutyBinding(input: Parameters<typeof collectInvoiceDuties>[0]) {
  return {
    async collect(): Promise<Awaited<ReturnType<typeof collectInvoiceDuties>> | { kind: "unavailable"; code: "retryable" }> {
      try { return await collectInvoiceDuties(input); }
      catch { return { kind: "unavailable", code: "retryable" }; }
    },
  };
}
