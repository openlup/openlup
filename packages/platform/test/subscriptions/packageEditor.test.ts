import { expect, it, vi } from "vitest";
import { createPostgresPackageEditor } from "../../src/subscriptions/packageEditor.js";
import { mapPackageEditError } from "../../src/subscriptions/packageEditErrors.js";
import type { PackageEditorOptions, PackageEditRequest } from "../../src/subscriptions/packageEditContracts.js";

const id = "11111111-1111-4111-8111-111111111111", client = "22222222-2222-4222-8222-222222222222", actor = { actorId: id, clientId: client };
const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
const request: PackageEditRequest = { subscriptionId: id, planDays: 20, base: [{ variantId: id, qty: 6 }], addons: [], expectedTemplateVersion: 1 };
function fixture() {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const row = { id, status: "active", next_cycle_at: "2026-12-01T00:00:00Z", edit_window_hours: 72, template_version: 1,
    cadence_days: 20, composition_constraint: null, method_healthy: true, payment_blocked: false, cycle_locked: false };
  let missing = false;
  const options: PackageEditorOptions = {
    now: () => "2026-11-05T00:00:00Z", limits: { maximumPlanDays: 45, maximumBaseLines: 3, maximumAddonLines: 5, maximumQuantity: 50 },
    async withTransaction(work) { return work({ async query(sql, values) {
      calls.push({ sql, values });
      if (sql.startsWith("SELECT s.*")) return { rows: missing ? [] : [row] };
      if (sql.startsWith("SELECT cadence_days")) return { rows: [row] };
      if (sql.startsWith("SELECT l.*")) return { rows: [{ id, variant_id: id, quantity: 4, sort_order: 0, is_addon: false, frozen_gross: "400", frozen_currency: "XXX" }] };
      if (sql.startsWith("SELECT value_text")) return { rows: [{ value_text: "4" }] };
      if (sql.includes("AS response")) return { rows: [{ response: { status: "applied", action: "update_package_template", subscriptionId: id,
        subscriptionStatus: "active", nextCycleAt: "2026-12-01T00:00:00Z", templateVersion: 2, eventId: id } }] };
      return { rows: [] };
    } }); },
    quoteCatalogReadPort: { listQuoteCatalogItems: async () => [{ variantId: id, skuCode: "REFILL", sellability: { subscription: true } }] },
    quotePort: { createServerAuthoritativeQuote: vi.fn(async input => {
      const lines = input.lines.map(line => ({ sku: line.sku, quantity: line.quantity, unitPriceGross: money(137), lineSubtotalGross: money(line.quantity * 137) }));
      const total = money(lines.reduce((sum, line) => sum + line.lineSubtotalGross.amountMinor, 0));
      return { quote: { lines, totalGross: total, subtotalGross: total, discountTotalGross: money(0) } };
    }) },
    compositionRulesPort: { validateComposition: async () => ({ ok: true }), resizeComposition: async () => null },
    constraintMapper: { toCore: stored => ({ kind: "synthetic", version: 1, data: stored ?? {} }), fromCore: value => value.data, nominalPlanDays: () => null },
  };
  return { options, calls, row, editor: createPostgresPackageEditor(options), missing() { missing = true; } };
}
it("admits ownership before any pricing or durable preview work", async () => {
  const f = fixture(); f.missing();
  await expect(f.editor.preview(actor, request)).rejects.toThrow("subscription_command_forbidden");
  await expect(f.editor.apply(actor, "owned-apply", request)).rejects.toThrow("subscription_command_forbidden");
  expect(f.options.quotePort.createServerAuthoritativeQuote).not.toHaveBeenCalled();
  expect(f.calls.some(call => call.sql.includes("subscription_quote_preview_record"))).toBe(false);
});
it("records a content-keyed preview with effective request, complete snapshots, totals and pre-quote expiry", async () => {
  const f = fixture(), preview = await f.editor.preview(actor, request);
  expect(preview).toMatchObject({ preview: { canApply: true, templateVersion: 1 }, quoteExpiresAt: "2026-11-05T00:15:00.000Z",
    packageEdit: { currentRecurringPrice: money(548), newRecurringPrice: money(822), delta: money(274), effectiveCycleAt: "2026-12-01T00:00:00Z" } });
  const record = f.calls.find(call => call.sql.includes("subscription_quote_preview_record"))!;
  expect(record.values).toEqual([id, client, id, preview.quoteHash, 1, "2026-11-05T00:15:00.000Z",
    { planDays: 20, nominalPlanDays: 20, base: request.base, addons: [], expectedTemplateVersion: 1 },
    { baseLines: [{ ...request.base[0], quoteLine: { sku: "REFILL", quantity: 6, unitPriceGross: money(137), lineSubtotalGross: money(822) } }], addonLines: [], compositionConstraint: null },
    { currentRecurringPrice: money(548), newRecurringPrice: money(822), delta: money(274) }, "2026-11-05T00:00:00Z"]);
  const applied = await f.editor.apply(actor, "independent-apply-key", { ...request, acceptedQuoteHash: preview.quoteHash });
  expect(applied.status).toBe("applied");
  expect(f.calls.find(call => call.sql.includes("SELECT public.subscription_package_edit_apply"))!.values?.[2]).toBe("independent-apply-key");
});
it.each([
  [{ payment_blocked: true, cycle_locked: true, status: "cancelled" }, "payment_blocked"],
  [{ status: "cancelled" }, "not_active"], [{ cycle_locked: true, method_healthy: false }, "cycle_locked"],
  [{ method_healthy: false }, "missing_payment_method"], [{ next_cycle_at: "2026-11-06T00:00:00Z" }, "edit_window_closed"],
])("reports blocker precedence %j without quoting", async (change, reason) => {
  const f = fixture(); Object.assign(f.row, change);
  expect((await f.editor.preview(actor, request)).preview).toMatchObject({ canApply: false, blockedReason: reason });
  expect(f.options.quotePort.createServerAuthoritativeQuote).not.toHaveBeenCalled();
});
it("requires a fresh equal quote before any non-replay apply and never accepts browser money", async () => {
  const f = fixture(), preview = await f.editor.preview(actor, request);
  vi.mocked(f.options.quotePort.createServerAuthoritativeQuote).mockRejectedValue(new Error("fresh-price-failed"));
  await expect(f.editor.apply(actor, "fresh-apply-key", { ...request, acceptedQuoteHash: preview.quoteHash })).rejects.toThrow("fresh-price-failed");
  expect(f.calls.some(call => call.sql.includes("SELECT public.subscription_package_edit_apply"))).toBe(false);
  await expect(f.editor.preview(actor, { ...request, newRecurringPrice: money(1) } as PackageEditRequest)).rejects.toThrow("subscription_reprice_invalid_request");
});
it.each(["subscription_reprice_quote_not_accepted", "subscription_reprice_below_minimum_order_units", "subscription_reprice_unknown_variant:synthetic", "subscription_reprice_invalid_base_mix"])("maps %s to a customer request refusal", reason => {
  expect(mapPackageEditError(new Error(reason), "apply")).toMatchObject({ status: 400, code: "BAD_REQUEST", reason });
});
it.each(["subscription_edit_quote_drift", "subscription_edit_quote_expired", "subscription_edit_quote_already_used", "subscription_edit_quote_required",
  "subscription_edit_stale_template", "subscription_edit_window_closed", "subscription_command_payment_blocked", "subscription_lifecycle_payment_blocked", "subscription_command_forbidden", "subscription_command_idempotency_conflict"])("maps durable %s only on apply", reason => {
  expect(mapPackageEditError(new Error(reason), "apply")).toMatchObject({ status: 409, code: "CONFLICT", reason });
  expect(mapPackageEditError(new Error(reason), "preview")).toEqual({ status: 503, code: "UPSTREAM_UNAVAILABLE", message: "Customer subscription preview failed" });
});
it.each(["subscription_reprice_minimum_base_units_unavailable", "subscription_reprice_unavailable", "subscription_reprice_prices_undefined", "network failure"])("keeps unavailable/unknown %s generic", reason => {
  expect(mapPackageEditError(new Error(reason), "apply")).toEqual({ status: 503, code: "UPSTREAM_UNAVAILABLE", message: "Customer subscription action failed" });
});

it("starts preview expiry before quoting but records and applies with the subsequent server clock", async () => {
  const f = fixture(); let clock = "2026-11-05T00:00:00Z"; f.options.now = () => clock;
  const quote = f.options.quotePort.createServerAuthoritativeQuote;
  f.options.quotePort.createServerAuthoritativeQuote = async input => { const result = await quote(input); clock = "2026-11-05T00:20:00Z"; return result; };
  const preview = await f.editor.preview(actor, request), record = f.calls.find(call => call.sql.includes("subscription_quote_preview_record"))!;
  expect(preview.quoteExpiresAt).toBe("2026-11-05T00:15:00.000Z"); expect(record.values?.[9]).toBe("2026-11-05T00:20:00Z");
  await f.editor.apply(actor, "clock-apply-key", { ...request, acceptedQuoteHash: preview.quoteHash });
  expect(f.calls.find(call => call.sql.includes("SELECT public.subscription_package_edit_apply"))!.values?.[5]).toBe("2026-11-05T00:20:00Z");
});

it("retains a string reprice reason but exposes only the matched durable token from RPC diagnostics", () => {
  expect(mapPackageEditError("subscription_reprice_invalid_addons", "apply")).toMatchObject({ status: 400, reason: "subscription_reprice_invalid_addons" });
  expect(mapPackageEditError({ message: "RPC failed: subscription_edit_quote_expired; private diagnostic" }, "apply"))
    .toMatchObject({ status: 409, reason: "subscription_edit_quote_expired" });
});
