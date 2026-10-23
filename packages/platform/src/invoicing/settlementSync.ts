import type { InvoiceSettlementPort, InvoiceSettlementItem } from "./contracts/settlement.js";

/** Preserve each immutable balance item, nullable links and original host key.
 * Transport, resolution and richer durable item storage remain host-owned.
 * Legacy batch/payment receipts may collapse items: later reuse is returned as
 * identity_mismatch without another write; processing continues. Only an item-capable
 * recorder can produce distinct recorded receipts. This records bank evidence only and has no payment-success writer.
 */
export async function syncInvoicePayoutSettlements<Item>(input: {
  list(limit: number): Promise<readonly Item[]>;
  project(item: Item): InvoiceSettlementItem | Promise<InvoiceSettlementItem>;
  settlement: Pick<InvoiceSettlementPort, "record">;
  limit?: number;
}) {
  const items = await input.list(input.limit ?? 10);
  const result = { checked: items.length, recorded: 0, replayed: 0, items: [] as Awaited<ReturnType<InvoiceSettlementPort["record"]>>[] };
  const receipts = new Map<string, string>();
  for (const item of items) {
    const evidence = await input.project(item);
    const write = await input.settlement.record(evidence);
    if (write.kind !== "recorded" || write.itemRef !== evidence.itemRef) {
      // Unknown/conflict/unsupported are never counted as accepted evidence.
      throw new Error(write.kind === "conflict" ? write.code : write.kind === "unknown" ? "unknown" : "unsupported");
    }
    const scope = JSON.stringify([evidence.providerRef, evidence.batchRef, evidence.itemRef, evidence.providerPaymentRef]);
    const previous = receipts.get(write.settlementItemRef);
    if (previous !== undefined && previous !== scope) {
      result.items.push({ kind: "conflict", itemRef: evidence.itemRef, code: "identity_mismatch" });
      continue;
    }
    receipts.set(write.settlementItemRef, scope);
    result.items.push(write);
    if (write.replayed) result.replayed += 1;
    else result.recorded += 1;
  }
  return result;
}
