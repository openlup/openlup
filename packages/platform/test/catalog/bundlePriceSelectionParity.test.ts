import { expect, it } from "vitest";
import { selectEffectiveBundleTargetPrice, createPostgresBundleCatalogStore, type BundleTargetPriceRow } from "../../src/catalog/index.js";
import * as legacy from "../../src/catalog/bundleCatalogQueries.js";
import * as effective from "../../src/catalog/effectiveBundleCatalogQueries.js";

const now = "2026-04-10T12:00:00Z";
const price: BundleTargetPriceRow = { mode: "one_time", targetPriceMinor: 1600, currency: "XXX", amountKind: "gross", active: true, validFrom: now, validTo: null };
const context = { priceListId: "list-p", currency: "XXX", mode: "one_time", atTime: now };
const row = (delta: Partial<BundleTargetPriceRow> = {}, priceListId = context.priceListId) => ({ price: { ...price, ...delta }, priceListId });
it("uses inclusive start and exclusive end, refusing invalid instants without selecting history", () => {
  expect(selectEffectiveBundleTargetPrice([row({ validTo: now, validFrom: "2026-04-01T00:00:00Z" }), row(), row({ validFrom: "2026-04-11T00:00:00Z" })], context)).toEqual(price);
  for (const atTime of ["invalid", "2026-04-09T00:00:00Z"]) expect(selectEffectiveBundleTargetPrice([row()], { ...context, atTime })).toBeNull();
});
it("prefers the exact mode, falls back to any, and never substitutes another purchase mode", () => {
  const any = row({ mode: "any", targetPriceMinor: 1500 });
  expect(selectEffectiveBundleTargetPrice([any, row()], context)).toEqual(price);
  expect(selectEffectiveBundleTargetPrice([any, row()], { ...context, mode: "subscription" })).toEqual(any.price);
  expect(selectEffectiveBundleTargetPrice([row()], { ...context, mode: "subscription" })).toBeNull();
});
it("filters list, currency, activity, gross and positive target before applying mode authority", () => {
  const invalid = [row({}, "other-list"), row({ currency: "YYY" }), row({ active: false }), row({ amountKind: "net" }), row({ targetPriceMinor: 0 }), row({ targetPriceMinor: -2 })];
  expect(selectEffectiveBundleTargetPrice(invalid, context)).toBeNull();
  expect(selectEffectiveBundleTargetPrice([...invalid, row()], context)).toEqual(price);
  expect(selectEffectiveBundleTargetPrice([row()], { ...context, priceListId: null })).toBeNull();
  expect(selectEffectiveBundleTargetPrice([row()], { ...context, currency: null })).toBeNull();
});
it("refuses exact and fallback ambiguity rather than choosing newest history", () => {
  expect(() => selectEffectiveBundleTargetPrice([row(), row({ targetPriceMinor: 1550 })], context)).toThrow("bundle_price_ambiguous");
  expect(() => selectEffectiveBundleTargetPrice([row({ mode: "any" }), row({ mode: "any" })], context)).toThrow("bundle_price_ambiguous");
  expect(selectEffectiveBundleTargetPrice([row(), row({ mode: "any" }), row({ mode: "any" })], context)).toEqual(price);
});
it("preserves default SQL/read transcripts and refuses effective list identity drift", async () => {
  const transcript: { sql: string; values: unknown }[] = [];
  const bundle = { id: "bundle-p", code: "PARITY-SET", title: "Synthetic collection", status: "active", fulfillment_mode: "virtual", updated_at: now, component_count: 1, has_active_target_price: true };
  const executor = { query: async (sql: string, values?: readonly unknown[]) => {
    transcript.push({ sql, values });
    if (sql === legacy.DETAIL_SQL || sql === effective.DETAIL_SQL) return { rows: [bundle] };
    if (sql === legacy.CURRENCY_LIST_SQL || sql === effective.CURRENCY_LIST_SQL) return { rows: [{ id: "list-p", currency: "XXX" }] };
    if (sql === effective.OWN_LIST_SQL) return { rows: [{ id: "old-list", currency: "XXX", region_code: "ZZ", mode: "one_time" }] };
    if (sql === effective.FEED_SQL) return { rows: [{ ...bundle, currency: "XXX", region_code: "ZZ", price_list_id: "old-list", mode: "one_time" }] };
    return { rows: [] };
  } };
  const implicit = createPostgresBundleCatalogStore(executor);
  const explicit = createPostgresBundleCatalogStore(executor, {});
  async function run(port: typeof implicit) {
    const output = [await port.listBundles({ status: "all", limit: 2, offset: 0 }), await port.getBundle({ code: bundle.code, currency: "XXX" }), await port.listActiveBundleCompositions({ currency: "XXX" }), await port.listBundleHistory({ code: bundle.code, limit: 2, offset: 0 })];
    return JSON.stringify(output);
  }
  const first = await run(implicit), calls = [...transcript]; transcript.length = 0;
  expect(await run(explicit)).toBe(first); expect(transcript).toEqual(calls);
  expect(calls.map(call => call.sql)).toEqual([legacy.LIST_SQL, legacy.COUNT_SQL, legacy.DETAIL_SQL, legacy.CURRENCY_LIST_SQL, legacy.COMPONENT_SQL, legacy.PRICE_SQL, legacy.FEED_SQL, legacy.HISTORY_SQL, legacy.HISTORY_COUNT_SQL]);
  const selected = createPostgresBundleCatalogStore(executor, { priceAuthority: "effective" });
  await expect(selected.getBundle({ code: bundle.code, atTime: now })).rejects.toThrow("bundle_price_list_changed");
  await expect(selected.listActiveBundleCompositions({ atTime: now })).rejects.toThrow("bundle_price_list_changed");
  const failure = new Error("synthetic read failure");
  await expect(createPostgresBundleCatalogStore({ query: async () => { throw failure; } }, { priceAuthority: "effective" }).getBundle({ code: "absent" })).rejects.toMatchObject({ name: "BundleCatalogReadError", message: failure.message });
});
