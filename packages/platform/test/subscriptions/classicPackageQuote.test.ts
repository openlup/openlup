import { describe, expect, it, vi } from "vitest";
import { createClassicPackageRepricer, hashPackageEditQuote } from "../../src/subscriptions/classicPackageQuote.js";
import { createPostgresPackageEditReadPort } from "../../src/subscriptions/packageEditRead.js";
import { createDbBackedCommerceQuotePort } from "../../src/pricing/index.js";
import type { CommerceQuoteCatalogItem, CommercePriceAuthorityPort } from "../../src/pricing/index.js";
import type { PackageEditQuotePorts, PackageEditReadPort, PackageEditSubscription } from "../../src/subscriptions/packageEditContracts.js";

const id = "11111111-1111-4111-8111-111111111111", addon = "22222222-2222-4222-8222-222222222222";
const money = (amountMinor: number, currency = "XXX") => ({ amountMinor, currency });
const request = () => ({ subscriptionId: id, planDays: 14, base: [{ variantId: id, qty: 14 }], addons: [] });
function fixture() {
  const subscription: PackageEditSubscription = { cadenceDays: 30, templateVersion: 3, compositionConstraint: { kind: "plan_days", value: 14 } };
  const readPort: PackageEditReadPort = { readSubscription: vi.fn(async () => subscription), readLines: vi.fn(async () => [
    { lineId: "base", variantId: id, quantity: 14, sortOrder: 0, isAddon: false, frozenLineSubtotalGross: money(1400) },
    { lineId: "extra", variantId: addon, quantity: 3, sortOrder: 1, isAddon: true, frozenLineSubtotalGross: money(300) }]), readMinimumBaseUnits: vi.fn(async () => 14) };
  const ports: PackageEditQuotePorts = {
    quoteCatalogReadPort: { listQuoteCatalogItems: vi.fn(async () => [id, addon].map(variantId => ({ variantId, skuCode: variantId, sellability: { subscription: true } }))) },
    quotePort: { createServerAuthoritativeQuote: vi.fn(async input => {
      const lines = input.lines.map(row => ({ sku: row.sku, quantity: row.quantity, unitPriceGross: money(100),
        lineSubtotalGross: money(row.quantity * 100), pricingComponents: [{ componentType: "base_unit", amountMinor: row.quantity * 125 }] }));
      return { quote: { lines, totalGross: money(lines.reduce((sum, line) => sum + line.lineSubtotalGross.amountMinor, 0)),
        subtotalGross: money(lines.reduce((sum, line) => sum + line.lineSubtotalGross.amountMinor, 0)), discountTotalGross: money(0) } };
    }) },
    compositionRulesPort: { validateComposition: vi.fn(async () => ({ ok: true as const })), resizeComposition: vi.fn(async input => ({
      coreLines: input.coreLines.map(line => ({ ...line, qty: 999 })),
      constraint: { ...input.constraint, data: { ...input.constraint.data, value: input.lever.value } } })) },
    constraintMapper: { toCore: stored => ({ kind: "synthetic.rules", version: 1, data: stored ?? {} }), fromCore: constraint => constraint.data,
      nominalPlanDays: stored => stored?.kind === "plan_days" ? Number(stored.value) : null },
  };
  return { subscription, readPort, ports, quote: createClassicPackageRepricer({ ...ports, readPort }).quote };
}

describe("classic full-package quote characterization", () => {
  it("quotes the full requested set, keeps an extended cadence and never resizes explicit quantities", async () => {
    const f = fixture(), result = await f.quote({ ...request(), addons: [{ variantId: addon, qty: 3 }] });
    expect(result).toMatchObject({ cadenceDays: 30, expectedTemplateVersion: 3, currentRecurringPrice: money(1700), newRecurringPrice: money(1700), delta: money(0),
      baseLines: [{ variantId: id, qty: 14 }], addonLines: [{ variantId: addon, qty: 3 }] });
    expect(f.ports.compositionRulesPort.resizeComposition).toHaveBeenCalledWith(expect.objectContaining({ lever: { kind: "planLengthConstraint", value: 14 } }));
    for (const [input] of vi.mocked(f.ports.quotePort.createServerAuthoritativeQuote).mock.calls) {
      expect(input).toMatchObject({ mode: "subscription", cadenceDays: 30, promoCodes: [] });
      expect(input.lines.map(line => line.quantity)).toEqual([14, 3]);
    }
  });
  it("changes only cadence and the nominal stamp on a plan-only edit", async () => {
    const f = fixture(), result = await f.quote({ ...request(), planDays: 21 });
    expect(result).toMatchObject({ cadenceDays: 21, compositionConstraint: { kind: "plan_days", value: 21 }, baseLines: [{ qty: 14 }], delta: money(-300) });
  });
  it("uses cadence as the nominal plan when the host has no plan-length constraint", async () => {
    const f = fixture(); f.subscription.compositionConstraint = null;
    vi.mocked(f.ports.compositionRulesPort.resizeComposition).mockResolvedValue(null);
    expect(await f.quote({ ...request(), planDays: 30 })).toMatchObject({ cadenceDays: 30, compositionConstraint: null });
  });
  it("lets a retired current line be removed and prices its comparison from frozen billing terms", async () => {
    const f = fixture(); vi.mocked(f.ports.quoteCatalogReadPort.listQuoteCatalogItems).mockResolvedValue([{ variantId: id, skuCode: id, sellability: { subscription: true } }]);
    expect(await f.quote(request())).toMatchObject({ currentRecurringPrice: money(1700), newRecurringPrice: money(1400), delta: money(-300) });
    expect(vi.mocked(f.ports.quotePort.createServerAuthoritativeQuote).mock.calls[0][0].lines).toHaveLength(1);
    await expect(f.quote({ ...request(), addons: [{ variantId: addon, qty: 3 }] })).rejects.toThrow(`subscription_reprice_unknown_variant:${addon}`);
  });
  it("uses wholly retired frozen prices without invoking a current quote and refuses incomplete evidence", async () => {
    const f = fixture(); vi.mocked(f.ports.quoteCatalogReadPort.listQuoteCatalogItems).mockResolvedValue([{ variantId: addon, skuCode: addon, sellability: { subscription: true } }]);
    vi.mocked(f.readPort.readLines).mockResolvedValue([{ lineId: "base", variantId: id, quantity: 14, sortOrder: 0, isAddon: false, frozenLineSubtotalGross: money(1400) }]);
    expect(await f.quote({ ...request(), base: [{ variantId: addon, qty: 14 }] })).toMatchObject({ currentRecurringPrice: money(1400) });
    expect(f.ports.quotePort.createServerAuthoritativeQuote).toHaveBeenCalledTimes(1);
    vi.mocked(f.readPort.readLines).mockResolvedValue([{ lineId: "base", variantId: id, quantity: 14, sortOrder: 0, isAddon: false }]);
    await expect(f.quote({ ...request(), base: [{ variantId: addon, qty: 14 }] })).rejects.toThrow("subscription_reprice_current_package_unpriceable");
  });
  it("refuses mixed-currency frozen comparisons", async () => {
    const f = fixture(); vi.mocked(f.ports.quoteCatalogReadPort.listQuoteCatalogItems).mockResolvedValue([{ variantId: id, skuCode: id, sellability: { subscription: true } }]);
    const lines = await f.readPort.readLines(id); lines[1].frozenLineSubtotalGross = money(300, "YYY");
    vi.mocked(f.readPort.readLines).mockResolvedValue(lines);
    await expect(f.quote(request())).rejects.toThrow("subscription_reprice_current_package_unpriceable");
  });
  it("refuses a requested below-minimum base set before the restamping lever, ignoring add-ons", async () => {
    const f = fixture(); await expect(f.quote({ ...request(), base: [{ variantId: id, qty: 13 }], addons: [{ variantId: addon, qty: 99 }] }))
      .rejects.toThrow("subscription_reprice_below_minimum_order_units");
    expect(f.ports.compositionRulesPort.resizeComposition).not.toHaveBeenCalled();
  });
  it.each([0, -1, NaN])("rejects invalid requested quantity %s", async qty => {
    await expect(fixture().quote({ ...request(), base: [{ variantId: id, qty }] })).rejects.toThrow("subscription_reprice_invalid_base_mix");
  });
  it("retains sanitizer truncation, duplicate refusal and host composition refusal", async () => {
    const f = fixture(); expect((await f.quote({ ...request(), base: [{ variantId: id, qty: 14.8 }] })).baseLines[0].qty).toBe(14);
    await expect(f.quote({ ...request(), base: [{ variantId: id, qty: 14 }, { variantId: id, qty: 14 }] })).rejects.toThrow("subscription_reprice_duplicate_variant");
    vi.mocked(f.ports.compositionRulesPort.validateComposition).mockResolvedValue({ ok: false, code: "subscription_reprice_not_a_base_variant" });
    await expect(f.quote(request())).rejects.toThrow("subscription_reprice_not_a_base_variant");
  });
  it("starts independent reads together and gives subscription errors precedence", async () => {
    const f = fixture(); vi.mocked(f.readPort.readSubscription).mockRejectedValue(new Error("header-failed"));
    vi.mocked(f.readPort.readLines).mockRejectedValue(new Error("lines-failed"));
    await expect(f.quote(request())).rejects.toThrow("header-failed"); expect(f.readPort.readLines).toHaveBeenCalledOnce();
  });
  it("observes both concurrently-started quotes and preserves the current failure", async () => {
    const f = fixture(); vi.mocked(f.ports.quotePort.createServerAuthoritativeQuote).mockRejectedValueOnce(new Error("current-failed")).mockRejectedValueOnce(new Error("desired-failed"));
    await expect(f.quote(request())).rejects.toThrow("current-failed"); expect(f.ports.quotePort.createServerAuthoritativeQuote).toHaveBeenCalledTimes(2);
  });
  it("rejects absent current base lines and a desired quote with a changed cardinality", async () => {
    const f = fixture(); vi.mocked(f.readPort.readLines).mockResolvedValue([]);
    await expect(f.quote(request())).rejects.toThrow("subscription_reprice_no_base_lines");
    const g = fixture(), before = await g.ports.quotePort.createServerAuthoritativeQuote({ mode: "subscription", cadenceDays: 14, compositionConstraint: null, promoCodes: [], lines: [] });
    vi.mocked(g.ports.quotePort.createServerAuthoritativeQuote).mockResolvedValue(before);
    await expect(g.quote(request())).rejects.toThrow("subscription_reprice_line_count_mismatch");
  });
  it("hashes the exact money/ordered pricing projection with absent components treated as an empty list", () => {
    const quote = { totalGross: money(100), subtotalGross: money(100), discountTotalGross: money(0),
      lines: [{ sku: id, quantity: 1, unitPriceGross: money(100), lineSubtotalGross: money(100) }] };
    expect(hashPackageEditQuote(quote)).toBe(hashPackageEditQuote({ ...quote, lines: [{ ...quote.lines[0], pricingComponents: [] }] }));
    expect(hashPackageEditQuote(quote)).not.toBe(hashPackageEditQuote({ ...quote, totalGross: money(101) }));
  });
  it.each([undefined, null, "0", "4.0", " 4", "4 ", "2147483648"])("refuses unavailable/malformed minimum %s with the shared configuration code", async raw => {
    const read = createPostgresPackageEditReadPort({ query: async () => ({ rows: raw === undefined ? [] : [{ value_text: raw }] }) });
    await expect(read.readMinimumBaseUnits()).rejects.toThrow("subscription_reprice_minimum_base_units_unavailable");
  });
  it("accepts alternate server minimums and refuses missing/invalid subscription versions", async () => {
    const read = createPostgresPackageEditReadPort({ query: async () => ({ rows: [{ value_text: "9" }] }) });
    expect(await read.readMinimumBaseUnits()).toBe(9);
    for (const rows of [[], [{ template_version: 0 }]]) {
      await expect(createPostgresPackageEditReadPort({ query: async () => ({ rows }) }).readSubscription(id)).rejects.toThrow(/subscription_reprice_(subscription_not_found|invalid_template_version)/);
    }
  });
  it("composes the existing strict recurring engine without promotion, acquisition or settings ports", async () => {
    const f = fixture(), tax = { included: true, country: "AA", category: "standard", vatRateBps: 0, legalBasis: "synthetic" } as const;
    const catalog: CommerceQuoteCatalogItem = { variantId: id, skuId: id, skuCode: id, productSlug: "refill", netWeightG: 1,
      isAddon: false, sellability: { oneTime: true, subscription: true }, documentRevision: { id, digest: "a".repeat(64) } };
    const authority: CommercePriceAuthorityPort = { async resolvePrice(input) {
      const base = { variantId: id, mode: "one_time" as const, matchedMinQty: 1, unitPriceMinor: 125, amountKind: "gross" as const,
        priceListId: id, priceEntryId: id, resolvedAt: "2026-11-05T12:00:00Z" };
      return input.mode === "one_time" ? { kind: "one_time", base, unitPriceMinor: 125 }
        : { kind: "subscription_legacy", base, unitPriceMinor: 100, legacyResolved: { ...base, mode: "subscription", unitPriceMinor: 100 } };
    } };
    const engine = createDbBackedCommerceQuotePort({ quoteCatalogReadPort: { listQuoteCatalogItems: async () => [catalog] },
      isStrictD1Quote: true, commercePriceAuthorityPort: authority, taxProfile: tax, supportedTaxProfiles: [tax], regionCode: "AA", currency: "XXX",
      hasPromotionCodePort: false, resolveAutomaticQuotePromotions: async () => ({ discounts: [], codeRejections: [] }),
      applyPromotionCodesV2: async () => ({ discounts: [], codeRejections: [], codeRejectionDetails: [] }), lineContext: () => ({}),
      quoteContext: input => () => ({ mode: input.mode, cadenceDays: input.cadenceDays, promoCodes: input.promoCodes }) });
    const quote = await createClassicPackageRepricer({ ...f.ports, quotePort: engine, quoteCatalogReadPort: { listQuoteCatalogItems: async () => [catalog] }, readPort: f.readPort }).quote(request());
    expect(quote.newRecurringPrice).toEqual(money(1400));
    expect(quote.baseLines[0].quoteLine).toMatchObject({ unitPriceGross: money(100), lineSubtotalGross: money(1400) });
  });
});

it("uses live recurring prices for sellable comparison lines even when their agreed amounts differ", async () => {
  const f = fixture(), lines = await f.readPort.readLines(id); lines[0].frozenLineSubtotalGross = money(600);
  vi.mocked(f.readPort.readLines).mockResolvedValue(lines);
  expect((await f.quote(request())).currentRecurringPrice).toEqual(money(1700));
});
