import { expect, it, vi } from "vitest";
import { createExactSubscriptionRepricer } from "../../src/subscriptions/exactEditQuote.js";
import { createSubscriptionSizingRules } from "../../src/subscriptions/subscriptionSizing.js";
import type { ExactSubscriptionEditRequest, SubscriptionPortionModes } from "../../src/subscriptions/contracts/exactEdit.js";
import type { PackageEditCurrentLine, PackageEditQuotePorts, PackageEditReadPort } from "../../src/subscriptions/packageEditContracts.js";

const base = "11111111-1111-4111-8111-111111111111", addon = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333", sub = "44444444-4444-4444-8444-444444444444";
const modes: SubscriptionPortionModes = { full: { mode: "full", factor: 1 }, reduced: { mode: "portion", factor: 0.5 } };
const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
function fixture() {
  const current: PackageEditCurrentLine[] = [
    { lineId: "base-id", variantId: base, quantity: 4, sortOrder: 3, isAddon: false },
    { lineId: "addon-id", variantId: addon, quantity: 3, sortOrder: 9, isAddon: true },
  ];
  const subscription = { cadenceDays: 10, templateVersion: 5, compositionConstraint: { kind: "plan_days", value: 10, need: 4 } as Record<string, unknown> };
  const minimum = vi.fn(async () => { throw new Error("unexpected minimum read"); });
  const readPort: PackageEditReadPort = { readLines: vi.fn(async () => current), readSubscription: vi.fn(async () => subscription), readMinimumBaseUnits: minimum };
  const composition = createSubscriptionSizingRules({ portionModes: modes, readDailyNeed: constraint => Number(constraint.data.need),
    isPlanLengthConstraint: constraint => constraint.data.kind === "plan_days",
    readUnitFacts: async ids => ids.filter(id => id === base || id === other).map(variantId => ({ variantId, demandPerUnit: 10, maximumQuantity: 99 })),
    quantityPolicy: async input => ({ totalUnits: Math.ceil(input.dailyNeed * input.planDays / 10), maxExceeded: false }) });
  const catalog = [base, addon, other].map(variantId => ({ variantId, skuCode: variantId, sellability: { subscription: true } }));
  const ports: PackageEditQuotePorts = { compositionRulesPort: composition,
    constraintMapper: { toCore: stored => ({ kind: "configured", version: 1, data: stored ?? {} }), fromCore: constraint => constraint.data, nominalPlanDays: () => 10 },
    quoteCatalogReadPort: { listQuoteCatalogItems: vi.fn(async () => catalog) },
    quotePort: { createServerAuthoritativeQuote: vi.fn(async input => {
      const lines = input.lines.map(line => ({ sku: line.sku, quantity: line.quantity, unitPriceGross: money(input.cadenceDays === 20 ? 131 : 137),
        lineSubtotalGross: money(line.quantity * (input.cadenceDays === 20 ? 131 : 137)) }));
      const total = money(lines.reduce((sum, line) => sum + line.lineSubtotalGross.amountMinor, 0));
      return { quote: { lines, totalGross: total, subtotalGross: total, discountTotalGross: money(0) } };
    }) } };
  return { current, subscription, ports, catalog, minimum, readPort, quote: (request: Omit<ExactSubscriptionEditRequest, "subscriptionId">) =>
    createExactSubscriptionRepricer({ ...ports, portionModes: modes, readPort }).quote({ ...request, subscriptionId: sub } as ExactSubscriptionEditRequest) };
}
it("swaps in place preserving identity, quantity, classification and order, including an add-on source", async () => {
  for (const from of [base, addon]) {
    const f = fixture(), result = await f.quote({ action: "swap_base_line", fromVariantId: from, toVariantId: other } as ExactSubscriptionEditRequest);
    const index = from === base ? 0 : 1;
    expect(result?.lines[index]).toMatchObject({ lineId: f.current[index].lineId, variantId: other, qty: f.current[index].quantity,
      isAddon: f.current[index].isAddon, sortOrder: f.current[index].sortOrder });
    expect(result?.expectedTemplateVersion).toBe(5); expect(f.minimum).not.toHaveBeenCalled();
  }
});
it.each(["swap_base_line", "remove_addon", "update_addon_quantity"] as const)("returns null for absent %s source", async action => {
  const f = fixture();
  const input = action === "swap_base_line" ? { action, fromVariantId: other, toVariantId: base } : { action, variantId: other, qty: 1 };
  expect(await f.quote(input as ExactSubscriptionEditRequest)).toBeNull();
  expect(f.ports.quotePort.createServerAuthoritativeQuote).not.toHaveBeenCalled();
});
it("appends a new add-on with null identity and the next order", async () => {
  const f = fixture(), result = await f.quote({ action: "add_addon", variantId: other, qty: 2 } as ExactSubscriptionEditRequest);
  expect(result?.lines[2]).toMatchObject({ lineId: null, variantId: other, qty: 2, sortOrder: 10, isAddon: true });
});
it("retains quantity-edit identity and removes a retired add-on without pricing it", async () => {
  const f = fixture();
  expect((await f.quote({ action: "update_addon_quantity", variantId: addon, qty: 2 } as ExactSubscriptionEditRequest))?.lines[1])
    .toMatchObject({ lineId: "addon-id", qty: 2, sortOrder: 9 });
  f.catalog[1].sellability.subscription = false;
  expect((await f.quote({ action: "remove_addon", variantId: addon } as ExactSubscriptionEditRequest))?.lines).toHaveLength(1);
  await expect(f.quote({ action: "update_addon_quantity", variantId: addon, qty: 2 } as ExactSubscriptionEditRequest)).rejects.toThrow("subscription_reprice_unknown_variant");
});
it("resizes plan length through host demand while relocking unchanged add-ons at the new band", async () => {
  const f = fixture(), result = await f.quote({ action: "update_plan_length", planDays: 20 } as ExactSubscriptionEditRequest);
  expect(result).toMatchObject({ cadenceDays: 20, compositionConstraint: { need: 4, value: 20 }, lines: [
    { lineId: null, variantId: base, qty: 8 }, { lineId: "addon-id", qty: 3, quoteLine: { unitPriceGross: money(131) } }] });
});
it("validates a fixed-total mix and permits replacement of a retired base", async () => {
  const f = fixture(); f.catalog[0].sellability.subscription = false;
  const result = await f.quote({ action: "update_base_mix", base: [{ variantId: other, qty: 4 }] } as ExactSubscriptionEditRequest);
  expect(result?.lines).toMatchObject([{ lineId: null, variantId: other, qty: 4 }, { lineId: "addon-id", qty: 3 }]);
  await expect(f.quote({ action: "update_base_mix", base: [{ variantId: other, qty: 5 }] } as ExactSubscriptionEditRequest)).rejects.toThrow("subscription_reprice_base_total_mismatch");
});
it("reduces portion units while keeping cadence and full demand stored", async () => {
  const f = fixture(), result = await f.quote({ action: "update_portion", portionMode: "portion" } as ExactSubscriptionEditRequest);
  expect(result).toMatchObject({ cadenceDays: 10, compositionConstraint: { need: 4, value: 10, mode: "portion", portionFactor: 0.5 },
    lines: [{ qty: 2 }, { lineId: "addon-id", qty: 3 }] });
});
it("refuses reduced mode without strict reduction and permits restoration to full", async () => {
  const f = fixture(); f.current[0].quantity = 2;
  await expect(f.quote({ action: "update_portion", portionMode: "portion" } as ExactSubscriptionEditRequest)).rejects.toThrow("subscription_reprice_portion_no_reduction");
  Object.assign(f.subscription.compositionConstraint, { mode: "portion", portionFactor: 0.5 });
  expect((await f.quote({ action: "update_portion", portionMode: "full" } as ExactSubscriptionEditRequest))?.lines[0].qty).toBe(4);
});
it("keeps a reduced factor through a plan-length resize", async () => {
  const f = fixture(); Object.assign(f.subscription.compositionConstraint, { mode: "portion", portionFactor: 0.5 });
  expect((await f.quote({ action: "update_plan_length", planDays: 20 } as ExactSubscriptionEditRequest))?.lines[0].qty).toBe(4);
});
it("refuses a portion mode outside the configured pair", async () => {
  const f = fixture();
  await expect(f.quote({ action: "update_portion", portionMode: "unknown" } as ExactSubscriptionEditRequest)).rejects.toThrow("subscription_reprice_invalid_portion_mode");
  expect(f.ports.quotePort.createServerAuthoritativeQuote).not.toHaveBeenCalled();
});
it.each(["update_plan_length", "update_portion"] as const)("refuses unconfigured demand and unservable %s", async action => {
  const f = fixture(), request = (action === "update_plan_length" ? { action, planDays: 20 } : { action, portionMode: "portion" }) as ExactSubscriptionEditRequest;
  delete f.subscription.compositionConstraint.need;
  await expect(f.quote(request)).rejects.toThrow("subscription_reprice_missing_daily_need");
  f.ports.compositionRulesPort.resizeComposition = async () => null;
  await expect(f.quote(request)).rejects.toThrow(action === "update_plan_length" ? "subscription_reprice_plan_length_unservable" : "subscription_reprice_portion_unservable");
});
it.each([
  [[{ variantId: base, qty: 2 }, { variantId: base, qty: 2 }], "duplicate_variant"],
  [[{ variantId: addon, qty: 4 }], "non_base_variant"],
  [[{ variantId: base, qty: 0 }], "invalid_base_mix"],
] as const)("refuses an invalid base set %j", async (lines, code) => {
  await expect(fixture().quote({ action: "update_base_mix", base: [...lines] } as ExactSubscriptionEditRequest)).rejects.toThrow(`subscription_reprice_${code}`);
});
it("hashes only recurring quotes with empty promotions and refuses changed quote cardinality", async () => {
  const f = fixture(), request = { action: "remove_addon", variantId: addon } as ExactSubscriptionEditRequest;
  const quote = await f.quote(request); expect(quote?.quoteHash).toMatch(/^[a-f0-9]{64}$/u);
  expect(f.ports.quotePort.createServerAuthoritativeQuote).toHaveBeenCalledWith(expect.objectContaining({ mode: "subscription", promoCodes: [] }));
  vi.mocked(f.ports.quotePort.createServerAuthoritativeQuote).mockResolvedValue({ quote: { lines: [], totalGross: money(0), subtotalGross: money(0), discountTotalGross: money(0) } });
  await expect(f.quote(request)).rejects.toThrow("subscription_reprice_line_count_mismatch");
});

it.each([
  { action: "update_plan_length", planDays: 20 },
  { action: "update_addon_quantity", variantId: addon, qty: 2 },
] as const)("admits the complete exact $action result before pricing", async fields => {
  const f = fixture(), admit = vi.fn(async () => { throw new Error("subscription_reprice_terms_not_admitted"); });
  f.ports.admitSubscriptionTerms = admit;
  await expect(f.quote(fields)).rejects.toThrow("subscription_reprice_terms_not_admitted");
  expect(admit).toHaveBeenCalledExactlyOnceWith({ subscriptionId: sub, nominalPlanDays: fields.action === "update_plan_length" ? 20 : 10,
    cadenceDays: fields.action === "update_plan_length" ? 20 : 10,
    base: [{ variantId: base, sku: base, qty: fields.action === "update_plan_length" ? 8 : 4 }],
    addons: [{ variantId: addon, sku: addon, qty: fields.action === "update_plan_length" ? 3 : 2 }] });
  expect(f.ports.quotePort.createServerAuthoritativeQuote).not.toHaveBeenCalled();
});
it("keeps the exact quote unchanged without admission and exposes nominal days independently of extended cadence", async () => {
  const f = fixture(); f.subscription.cadenceDays = 35;
  const fields = { action: "update_addon_quantity", variantId: addon, qty: 2 } as ExactSubscriptionEditRequest;
  const original = await f.quote(fields), admit = vi.fn(); f.ports.admitSubscriptionTerms = admit;
  expect(await f.quote(fields)).toEqual(original);
  expect(admit.mock.calls[0][0]).toMatchObject({ nominalPlanDays: 10, cadenceDays: 35 });
});

it("refuses a fresh edit retaining an historical cadence while allowing a valid cadence repair", async () => {
  const f = fixture(); f.subscription.cadenceDays = 3661;
  await expect(f.quote({ action: "add_addon", variantId: other, qty: 1 } as ExactSubscriptionEditRequest))
    .rejects.toThrow("subscription_reprice_invalid_plan_length");
  expect(f.ports.quoteCatalogReadPort.listQuoteCatalogItems).not.toHaveBeenCalled();
  expect(f.ports.quotePort.createServerAuthoritativeQuote).not.toHaveBeenCalled();
  expect(await f.quote({ action: "update_plan_length", planDays: 20 } as ExactSubscriptionEditRequest)).toMatchObject({cadenceDays:20});
});

it.each([0, 3661])("refuses direct fresh exact cadence %i before dependency reads", async planDays => {
  const f = fixture();
  await expect(f.quote({ action: "update_plan_length", planDays } as ExactSubscriptionEditRequest)).rejects.toThrow("subscription_reprice_invalid_plan_length");
  expect(f.readPort.readSubscription).not.toHaveBeenCalled(); expect(f.readPort.readLines).not.toHaveBeenCalled();
  expect(f.ports.quoteCatalogReadPort.listQuoteCatalogItems).not.toHaveBeenCalled();
  expect(f.ports.quotePort.createServerAuthoritativeQuote).not.toHaveBeenCalled();
});
