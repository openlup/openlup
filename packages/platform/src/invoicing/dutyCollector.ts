import type { InvoiceStorePort, InvoiceUnsupported } from "./contracts/index.js";

/** Collect retained sources, then prepare each leased duty in separate transactions.
 * The host commits every store call; no money/parcel callback or provider I/O is
 * accepted here. Missing facts stay owed until the host installs their revision.
 * @consumer Independent invoice duty binding.
 */
export async function collectInvoiceDuties(input: {
  store: Pick<InvoiceStorePort, "sweep" | "prepareFacts" | "finishFacts">;
  limit?: number;
}): Promise<{ kind: "collected"; collected: number; prepared: number; failures: number } | InvoiceUnsupported> {
  const batch = await input.store.sweep(input.limit ?? 10);
  if ("kind" in batch) return batch;
  let prepared = 0, failures = 0;
  for (const claim of batch.claims) {
    try {
      const result = await input.store.prepareFacts(claim);
      if ("kind" in result) { failures++; continue; }
      if (result.status === "stale") continue;
      const finished = await input.store.finishFacts({ ...claim, result: { ...result, status: result.status } });
      if ("kind" in finished) failures++;
      else if (finished.status === "ready" || finished.status === "issued" || finished.status === "voided") prepared++;
      else if (finished.status !== "stale") failures++;
    } catch {
      // A failed prepare/finalize leaves the persisted lease reclaimable. Never
      // manufacture a successful finish or prevent another claim's progress.
      failures++;
    }
  }
  return { kind: "collected", collected: batch.collected, prepared, failures };
}
