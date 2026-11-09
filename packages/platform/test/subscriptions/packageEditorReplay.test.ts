import { expect, it, vi } from "vitest";
import { createPostgresPackageEditor } from "../../src/subscriptions/packageEditor.js";
import type { PackageEditApplyResult, PackageEditorOptions } from "../../src/subscriptions/packageEditContracts.js";

const id = "11111111-1111-4111-8111-111111111111", client = "22222222-2222-4222-8222-222222222222";
const saved: PackageEditApplyResult = { status: "applied", subscriptionId: id, action: "update_package_template", subscriptionStatus: "active",
  nextCycleAt: "2026-12-01T00:00:00Z", templateVersion: 2, eventId: id };

/** Frozen entry transcript: quote enrichment and acceptance precede the durable RPC. */
async function referenceEntry(input: { acceptedQuoteHash: string }, quote: () => Promise<{ quoteHash: string }>, durableApply: () => Promise<PackageEditApplyResult>) {
  const fresh = await quote();
  if (input.acceptedQuoteHash !== fresh.quoteHash) throw new Error("subscription_reprice_quote_not_accepted");
  return durableApply();
}
it("characterizes re-quote before durable replay: a completed apply can be reported as refused after a price change", async () => {
  const durable = vi.fn(async () => ({ ...saved, status: "replayed" as const }));
  const quote = vi.fn(async () => ({ quoteHash: "b".repeat(64) }));
  await expect(referenceEntry({ acceptedQuoteHash: "a".repeat(64) }, quote, durable)).rejects.toThrow("subscription_reprice_quote_not_accepted");
  expect(quote).toHaveBeenCalledOnce(); expect(durable).not.toHaveBeenCalled(); expect(saved.status).toBe("applied");
});
it("replays before re-quote or configuration and retains the originally recorded state", async () => {
  const calls: string[] = [];
  const quote = vi.fn(async (): Promise<never> => { throw new Error("subscription_reprice_prices_unavailable"); });
  const options: PackageEditorOptions = {
    limits: { maximumPlanDays: 90, maximumBaseLines: 6, maximumAddonLines: 12, maximumQuantity: 99 }, now: () => "2027-01-01T00:00:00Z",
    quotePort: { createServerAuthoritativeQuote: quote }, quoteCatalogReadPort: { listQuoteCatalogItems: vi.fn(async (): Promise<never> => { throw new Error("catalogue must not be read"); }) },
    compositionRulesPort: { validateComposition: vi.fn(async (): Promise<never> => { throw new Error("policy must not be read"); }), resizeComposition: async () => null },
    constraintMapper: { toCore: () => ({ kind: "configured", version: 1, data: {} }), fromCore: value => value.data, nominalPlanDays: () => null },
    async withTransaction(work) { return work({ async query(sql) {
      calls.push(sql);
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.startsWith("SELECT s.*")) return { rows: [{ id, status: "cancelled", template_version: 99, client_id: client }] };
      if (sql.includes("FROM public.subscription_command_receipts")) return { rows: [{ matches: true, status: "applied", result: saved }] };
      throw new Error("replay attempted a later read");
    } }); },
  };
  const result = await createPostgresPackageEditor(options).apply({ actorId: id, clientId: client }, "completed-package-key", {
    subscriptionId: id, planDays: 28, base: [{ variantId: id, qty: 6 }], addons: [], expectedTemplateVersion: 1, acceptedQuoteHash: "a".repeat(64) });
  expect(result).toEqual({ ...saved, status: "replayed", originalStatus: "applied" });
  expect(quote).not.toHaveBeenCalled(); expect(options.quoteCatalogReadPort.listQuoteCatalogItems).not.toHaveBeenCalled();
  expect(calls.some(sql => sql.includes("subscription_package_edit_apply("))).toBe(false);
});
