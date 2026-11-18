import { expect, it } from "vitest";
import { assertEditQuoteCurrency, buildEditConsent, hashEditConsent, type EditConsentPricedLine } from "../../src/subscriptions/editConsent.js";
import { readCompleteEditBaseline, type EditAgreementBaseline } from "../../src/subscriptions/editConsentBaseline.js";
import { createClassicPackageRepricer, hashPackageEditQuote } from "../../src/subscriptions/classicPackageQuote.js";
import { createExactSubscriptionRepricer } from "../../src/subscriptions/exactEditQuote.js";
import { quoteSizedEdit } from "../../src/subscriptions/sizedEditQuote.js";
import { context, host, policy, ids } from "./sizedFixtures.js";

const money = (amountMinor: number, currency = "XXX") => ({ amountMinor,currency });
const old = { ordinal: 1,lineId: "line",variantId: ids.a,sku: ids.a,isAddon: false,quantity: 2,unitMinor: 100 };
const baseline = (): EditAgreementBaseline => ({ currency: "XXX",templateVersion: 1,lines: [{ ...old }],fingerprint: "b".repeat(64) });
const desired = (unit = 137, qty = 3, variantId: string = ids.a): EditConsentPricedLine[] => [{ variantId,qty,isAddon: false,
  quoteLine: { sku: variantId,quantity: qty,unitPriceGross: money(unit),lineSubtotalGross: money(unit * qty) } }];
const digest = "a".repeat(64);
function state() {
  return { template_version: 1,template_currency: "XXX",agreement_currency: "XXX",
    accepted_lines: [{ lineId: old.lineId,variantId: ids.a,sku: ids.a,isAddon: false,quantity: 2,unitMinor: 100,currency: "XXX" }],
    term_lines: [{ ordinal: 1,sku: ids.a,quantity: 2,unitMinor: 100 }] };
}
const read = (row: unknown) => readCompleteEditBaseline({ query: async () => ({ rows: row ? [row as Record<string,unknown>] : [] }) },ids.subscription);
it("edit_consent_missing_baseline_refuses", async () => {
  const row = state(); row.term_lines = []; await expect(read(row)).rejects.toThrow("agreement_baseline_unavailable");
});
it("edit_consent_partial_baseline_refuses", async () => {
  const row = state(); row.accepted_lines.push({ ...row.accepted_lines[0],lineId: "other",variantId: ids.b,sku: ids.b });
  await expect(read(row)).rejects.toThrow("agreement_baseline_unavailable");
});
it("edit_consent_duplicate_baseline_refuses", async () => {
  const row = state(); row.accepted_lines.push({ ...row.accepted_lines[0],lineId: "other",variantId: ids.b,sku: ids.b });
  row.term_lines.push({ ...row.term_lines[0] }); await expect(read(row)).rejects.toThrow("agreement_baseline_unavailable");
});
it("edit_consent_extra_baseline_line_refuses", async () => {
  const row = state(); row.accepted_lines.push({ ...row.accepted_lines[0],lineId: "unmatched-agreement-line",variantId: ids.b,sku: ids.b,quantity: 1,unitMinor: 0 });
  await expect(read(row)).rejects.toThrow("agreement_baseline_unavailable");
});
it("edit_consent_baseline_identity_role_quantity_refuses", async () => {
  for (const patch of [{ sku: ids.b },{ isAddon: null },{ quantity: 3 },{ unitMinor: 99 }]) {
    const row = state(); Object.assign(row.accepted_lines[0],patch); await expect(read(row)).rejects.toThrow("agreement_baseline_unavailable");
  }
});
it("edit_consent_missing_agreement_currency_refuses", async () => {
  const row = state(); row.agreement_currency = ""; await expect(read(row)).rejects.toThrow("agreement_currency_unavailable");
});
it("edit_consent_currency_mismatch_refuses", async () => {
  const row = state(); row.template_currency = "YYY"; await expect(read(row)).rejects.toThrow("agreement_currency_mismatch");
  const lines = desired(); lines[0].quoteLine.unitPriceGross.currency = "YYY";
  expect(() => buildEditConsent(baseline(),digest,lines)).toThrow("agreement_currency_mismatch");
});
it("edit_consent_real_zero_is_valid", async () => {
  const row = state(); row.term_lines[0].unitMinor = 0; row.accepted_lines[0].unitMinor = 0;
  expect((await read(row)).lines[0].unitMinor).toBe(0);
});
it("edit_consent_unsafe_money_refuses", () => {
  // Each line subtotal is safe; only their aggregate exceeds the exact-money bound.
  const lines = [...desired(Number.MAX_SAFE_INTEGER,1),...desired(1,1,ids.b)];
  expect(lines.every(line => Number.isSafeInteger(line.quoteLine.lineSubtotalGross.amountMinor))).toBe(true);
  expect(() => buildEditConsent(baseline(),digest,lines)).toThrow(/^agreement_baseline_unavailable$/);
});
it("edit_consent_absent_side_is_not_zero", () => {
  const old = baseline(); old.lines = [{ ...old.lines[0],unitMinor: 0 }];
  expect(buildEditConsent(old,digest,desired(0,2)).lines[0]).toMatchObject({ kind: "retained",agreedUnitMinor: 0,newUnitMinor: 0,deltaMinor: 0 });
  expect(buildEditConsent(old,digest,desired(0,2,ids.b)).lines).toMatchObject([
    { kind: "removed",newUnitMinor: null,deltaMinor: null },{ kind: "added",agreedUnitMinor: null,deltaMinor: null }]);
});
it("edit_consent_quantity_and_subtotal_reconcile", () => {
  const value = buildEditConsent(baseline(),digest,desired());
  expect(value).toMatchObject({ agreedTotalMinor: 200,newTotalMinor: 411,subtotalDeltaMinor: 211 });
  expect(value.lines[0]).toMatchObject({ agreedQuantity: 2,newQuantity: 3,deltaMinor: 37,subtotalDeltaMinor: 211 });
});
it("edit_consent_order_and_swap_are_deterministic", () => {
  const before = baseline(); before.lines = [{ ...old,ordinal: 1,variantId: ids.b,sku: ids.b },{ ...old,ordinal: 2 }];
  const lines = [...desired(137,3,ids.addon),...desired()];
  expect(buildEditConsent(before,digest,lines).lines.map(line => [line.kind,line.variantId])).toEqual([
    ["removed",ids.b],["retained",ids.a],["added",ids.addon]]);
});
it("edit_quote_hash_binds_agreed_baseline", async () => {
  const a = state(), b = state(); b.term_lines[0].unitMinor = 101; b.accepted_lines[0].unitMinor = 101;
  expect(hashEditConsent(buildEditConsent(await read(a),digest,desired()))).not.toBe(hashEditConsent(buildEditConsent(await read(b),digest,desired())));
  const reordered = state(); reordered.term_lines[0].ordinal = 2;
  const original = buildEditConsent(await read(a),digest,desired()), changed = buildEditConsent(await read(reordered),digest,desired());
  expect(changed.lines).toEqual(original.lines); expect(hashEditConsent(changed)).not.toBe(hashEditConsent(original));
});
it("edit_quote_hash_binds_complete_disclosure", () => {
  const value = buildEditConsent(baseline(),digest,desired());
  for (const patch of [{ reason: "price_changed" as const },{ newQuantity: 4 },{ variantId: ids.b },{ agreedUnitMinor: null }]) {
    const altered = structuredClone(value); Object.assign(altered.lines[0],patch); expect(hashEditConsent(altered)).not.toBe(hashEditConsent(value));
  }
});
it("edit_quote_hash_binds_version_and_currency", () => {
  const value = buildEditConsent(baseline(),digest,desired());
  expect(hashEditConsent({ ...value,currency: "YYY" })).not.toBe(hashEditConsent(value));
  expect(hashEditConsent({ ...value,version: 2 } as never)).not.toBe(hashEditConsent(value));
});
it("edit_consent_reasons_are_deterministic", () => {
  expect(buildEditConsent(baseline(),digest,desired(100,2)).lines[0].reason).toBe("unchanged");
  expect(buildEditConsent(baseline(),digest,desired(137,2)).lines[0].reason).toBe("price_changed");
});
const ports = () => ({ ...host(),readPort: {
  readSubscription: async () => ({ cadenceDays: 20,templateVersion: 1,compositionConstraint: null }),
  readLines: async () => [{ lineId: "line",variantId: ids.a,quantity: 4,sortOrder: 0,isAddon: false }],readMinimumBaseUnits: async () => 1 },
  quoteCatalogReadPort: { listQuoteCatalogItems: async () => [{ variantId: ids.a,skuCode: ids.a,sellability: { subscription: true } }] },
  compositionRulesPort: { validateComposition: async () => ({ ok: true as const }),resizeComposition: async () => null },
  constraintMapper: { toCore: () => ({ kind: "example",version: 1,data: {} }),fromCore: () => null,nominalPlanDays: () => 20 } });
it("classic_edit_consent_baseline_is_agreed_price", async () => {
  const quote = await createClassicPackageRepricer(ports()).quote({ subscriptionId: ids.subscription,planDays: 20,base: [{ variantId: ids.a,qty: 4 }] });
  const before = baseline(); before.lines = [{ ...old,quantity: 4,unitMinor: 73 }];
  const consent = buildEditConsent(before,quote.quoteHash,quote.baseLines.map(line => ({ ...line,isAddon: false })));
  expect(consent.lines[0]).toMatchObject({ agreedUnitMinor: 73,newUnitMinor: 137,deltaMinor: 64 });
});
it("exact_edit_discloses_unchanged_line_repricing", async () => {
  const deps = ports(); const resize = async (input: Parameters<import("../../src/subscriptions/packageEditContracts.js").PackageEditQuotePorts["compositionRulesPort"]["resizeComposition"]>[0]) => ({ coreLines: input.coreLines,constraint: input.constraint });
  const quote = await createExactSubscriptionRepricer({ ...deps,compositionRulesPort: { ...deps.compositionRulesPort,resizeComposition: resize } }).quote({ subscriptionId: ids.subscription,action: "update_plan_length",planDays: 30 });
  expect(quote?.lines.map(line => line.quoteLine.unitPriceGross.amountMinor)).toEqual([137]);
  const before = baseline(); before.lines = [{ ...old,quantity: 4 }];
  expect(buildEditConsent(before,quote!.quoteHash,quote!.lines).lines[0]).toMatchObject({ agreedUnitMinor: 100,newUnitMinor: 137 });
});
it("sized_edit_consent_unchanged", async () => {
  const current = context(), quote = await quoteSizedEdit({ db: { query: async () => ({ rows: [] }) },context: current,
    request: { subscriptionId: ids.subscription,action: "update_base_mix",base: [{ variantId: ids.a,qty: 4 }] },policy,host: host(),point: "preview" });
  const before = baseline(); before.lines = current.lines.map((line,index) => ({ ...old,ordinal: index+1,variantId: line.variantId,sku: line.sku,
    isAddon: line.isAddon,quantity: line.qty,unitMinor: line.quoteLine.unitPriceGross.amountMinor }));
  expect(buildEditConsent(before,quote.quoteHash,quote.lines).lines.every(line => line.deltaMinor === 0)).toBe(true);
});
it("edit_consent_original_inner_digest_bytes", () => {
  const line = desired()[0].quoteLine, quote = { lines: [line],totalGross: money(411),subtotalGross: money(411),discountTotalGross: money(0) };
  expect(hashPackageEditQuote(quote)).toBe("cd58208b061724c47d785c0a8449ad43a2bb628d754eac04bf590990ae43799b");
});

it("edit_consent_dependency_failure_is_not_missing_baseline", async () => {
  await expect(readCompleteEditBaseline({ query: async () => { throw new Error("offline"); } },ids.subscription)).rejects.toThrow("dependency_unavailable");
});
it("edit_consent_graduation_is_not_current_baseline", async () => {
  const row = state(); Object.assign(row,{ graduationLines: [{ ...row.term_lines[0],unitMinor: 999 }] });
  expect((await read(row)).lines[0].unitMinor).toBe(100);
});

it("edit_consent_summary_currency_mismatch_refuses", () => {
  for (const field of ["totalGross","subtotalGross","discountTotalGross"] as const) {
    const quote = { totalGross: money(100),subtotalGross: money(100),discountTotalGross: money(0) };
    quote[field].currency = "YYY";
    expect(() => assertEditQuoteCurrency("XXX",quote)).toThrow("agreement_currency_mismatch");
    quote[field].currency = "";
    expect(() => assertEditQuoteCurrency("XXX",quote)).toThrow("agreement_currency_unavailable");
  }
});
