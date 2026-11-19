import { expect, expectTypeOf, it } from "vitest";
import { assertEditIntent, assertEditQuoteCurrency, assertRecurringEditQuote, buildEditConsent, decodeEditResult, hashEditConsent, takeEditConsent, type EditConsentPricedLine } from "../../src/subscriptions/editConsent.js";
import { readCompleteEditBaseline, type EditAgreementBaseline } from "../../src/subscriptions/editConsentBaseline.js";
import { createClassicPackageRepricer, createClassicEditRepricer, hashPackageEditQuote } from "../../src/subscriptions/classicPackageQuote.js";
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
  return { subscription_id: ids.subscription,template_version: 1,template_currency: "XXX",agreement_currency: "XXX",
    accepted_lines: [{ lineId: old.lineId,variantId: ids.a,sku: ids.a,isAddon: false,quantity: 2,unitMinor: 100,currency: "XXX" }],
    term_lines: [{ ordinal: 1,sku: ids.a,quantity: 2,unitMinor: 100 }] };
}
const read = (row: unknown) => readCompleteEditBaseline({ query: async () => ({ rows: row ? [row as Record<string,unknown>] : [] }) },ids.subscription);
it.each(["empty", "equal", "different", "identity"] as const)("LC9-S-001 baseline rejects %s rows", async fault => {
  const record = state();
  expect(await read(record)).toMatchObject({ templateVersion: 1, currency: "XXX" });
  const wrong = { ...record, subscription_id: ids.b };
  const rows = fault === "empty" ? [] : fault === "equal" ? [record, record] : fault === "different" ? [record, wrong] : [wrong];
  await expect(readCompleteEditBaseline({ query: async () => ({ rows }) }, ids.subscription)).rejects.toThrow(/^agreement_baseline_unavailable$/u);
});

it.each([
  ["empty", "subscription_edit_quote_required"], ["duplicate", "subscription_edit_quote_required"],
  ["identity", "subscription_edit_quote_drift"], ["version-only disclosure", "subscription_edit_quote_required"],
  ["changed disclosure", "subscription_edit_quote_drift"], ["different request", "subscription_edit_quote_drift"],
] as const)("LC9-S-011/S-014 selected consent rejects %s", async (fault, reason) => {
  const editConsent = buildEditConsent(baseline(), digest, desired());
  const quoteHash = hashEditConsent(editConsent), actor = { actorId: ids.a, clientId: ids.b }, request = { planDays: 28 };
  const record = { id: ids.addon, subscription_id: ids.subscription, client_id: ids.b, action: "update_package_template",
    quote_hash: quoteHash, template_version: 1, quote_snapshot: { editConsent, consentRequest: request } };
  let rows: Record<string, unknown>[] = [record];
  const call = () => takeEditConsent({ query: async () => ({ rows: rows.map(preview => ({ preview })) }) }, actor,
    ids.subscription, "update_package_template", quoteHash, 1, "consent-selection-key", "2024-01-01T00:00:00Z", request);
  await expect(call()).resolves.toEqual(record);
  if (fault === "empty") rows = [];
  if (fault === "duplicate") rows.push(structuredClone(record));
  if (fault === "identity") record.subscription_id = ids.a;
  if (fault === "version-only disclosure") Object.assign(record.quote_snapshot, { editConsent: { version: 1 } });
  if (fault === "changed disclosure") editConsent.baselineFingerprint = digest.replace(/^a/u, "b");
  if (fault === "different request") record.quote_snapshot.consentRequest = { planDays: 30 };
  await expect(call()).rejects.toThrow(new Error(reason));
});
it.each(["empty", "two equal", "two different", "wrong owner", "wrong action", "malformed result"] as const)(
  "LC9-D-127 scalar delegate rejects %s", caseName => {
    const result = { status: "applied", subscriptionId: ids.subscription, action: "resize_bundle", subscriptionStatus: "active",
      nextCycleAt: "2026-12-01T00:00:00.000Z", templateVersion: 2, eventId: ids.a };
    const wrong = { ...result, subscriptionId: ids.b };
    const rows = caseName === "empty" ? [] : caseName === "two equal" ? [{ result }, { result }]
      : caseName === "two different" ? [{ result }, { result: wrong }] : caseName === "wrong owner" ? [{ result: wrong }]
      : caseName === "wrong action" ? [{ result: { ...result, action: "update_bundle" } }] : [{ result: { ...result, templateVersion: null } }];
    expect(decodeEditResult([{ result }], "result", ids.subscription, "resize_bundle")).toEqual(result);
    expect(() => decodeEditResult(rows, "result", ids.subscription, "resize_bundle")).toThrow(/^subscription_edit_result_unreadable$/u);
  },
);
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
it.each([false, true])("LC9-S-028 accepted role %s survives the role-free term join", async isAddon => {
  const row = state(); row.accepted_lines[0].isAddon = isAddon;
  expect((await read(row)).lines).toMatchObject([{ sku: ids.a, quantity: 2, unitMinor: 100, isAddon }]);
});
it.each([false, true])("LC9-D-027 add-existing refuses independently of agreed add-on role %s", isAddon => {
  const agreed = { ...baseline(), lines: [{ ...old, isAddon }] };
  expect(() => assertEditIntent(agreed, { action: "add_addon", variantId: ids.b })).not.toThrow();
  expect(() => assertEditIntent(agreed, { action: "add_addon", variantId: old.variantId.toUpperCase() }))
    .toThrow(/^subscription_reprice_duplicate_variant$/u);
});

it("LC9-D-027 swap rejects an occupied target but retains a same-line noop", () => {
  const agreed = { ...baseline(), lines: [old, { ...old, variantId: ids.b, isAddon: true }] };
  expect(() => assertEditIntent(agreed, { action: "swap_base_line", fromVariantId: old.variantId, toVariantId: old.variantId })).not.toThrow();
  expect(() => assertEditIntent(agreed, { action: "swap_base_line", fromVariantId: old.variantId, toVariantId: ids.b }))
    .toThrow(/^subscription_reprice_duplicate_variant$/u);
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
it("LC9-S-008 disclosure tag identifies the present sides and reason", () => {
  const before = baseline();
  before.lines = [{ ...old,variantId: ids.b,sku: ids.b,ordinal: 1 }, { ...old,ordinal: 2 }];
  const result = buildEditConsent(before,digest,[...desired(0,3),...desired(0,1,ids.addon)]);
  for (const current of result.lines) switch (current.kind) {
    case "retained":
      expectTypeOf(current.newUnitMinor).toEqualTypeOf<number>();
      expectTypeOf(current.agreedUnitMinor).toEqualTypeOf<number>();
      expect(current).toMatchObject({ variantId: ids.a, agreedUnitMinor: 100, newUnitMinor: 0, reason: "quantity_changed" });
      break;
    case "removed":
      expectTypeOf(current.newUnitMinor).toEqualTypeOf<null>();
      expect(current).toMatchObject({ variantId: ids.b, newQuantity: null, newUnitMinor: null, reason: "removed" });
      break;
    case "added":
      expectTypeOf(current.agreedUnitMinor).toEqualTypeOf<null>();
      expect(current).toMatchObject({ variantId: ids.addon, agreedQuantity: null, agreedUnitMinor: null, newUnitMinor: 0, reason: "added" });
      break;
  }
  expect(result.lines.map(line => line.kind)).toEqual(["removed","retained","added"]);
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
it.each([
  ["LC9-D-018", false], ["LC9-D-019", false], ["LC9-D-020", true],
] as const)("%s classic consent prices only the requested set", async (_item, rejectDesired) => {
  const deps = ports();
  if (_item === "LC9-D-019") {
    // The removed line has no live SKU and its partial legacy comparison has no money.
    deps.readPort.readLines = async () => [{ lineId: "retired",variantId: ids.b,quantity: 4,sortOrder: 0,isAddon: false }];
  }
  const calls: number[] = [];
  const quote = createClassicEditRepricer({ ...deps, quotePort: {
    async createServerAuthoritativeQuote(request) {
      calls.push(request.cadenceDays);
      if (request.cadenceDays === 20) throw new Error("old_price_unavailable");
      if (rejectDesired) throw new Error("desired_price_unavailable");
      return deps.quotePort.createServerAuthoritativeQuote(request);
    },
  } }, money(400)).quote({ subscriptionId: ids.subscription, planDays: 30, base: [{ variantId: ids.a, qty: 4 }] });
  if (rejectDesired) await expect(quote).rejects.toThrow(/^desired_price_unavailable$/u);
  else await expect(quote).resolves.toMatchObject({ currentRecurringPrice: money(400), newRecurringPrice: money(548) });
  expect(calls).toEqual([30]);
});

it.each([
  ["LC9-D-022 total mismatch", "total", "subscription_reprice_quote_total_mismatch"],
  ["LC9-D-022 subtotal mismatch", "subtotal", "subscription_reprice_quote_total_mismatch"],
  ["LC9-D-022 adjustment", "discount", "subscription_reprice_quote_has_adjustments"],
  ["LC9-D-023 empty response", "missing", "subscription_reprice_line_count_mismatch"],
  ["LC9-D-023 extra response", "extra", "subscription_reprice_line_count_mismatch"],
  ["LC9-D-023 equal-quantity reorder", "reorder", "subscription_reprice_quote_line_mismatch"],
  ["LC9-D-023 wrong SKU", "sku", "subscription_reprice_quote_line_mismatch"],
  ["LC9-D-023 wrong quantity", "quantity", "subscription_reprice_quote_line_mismatch"],
] as const)("%s", (_item, alteration, reason) => {
  const quote = { totalGross: money(400), subtotalGross: money(400), discountTotalGross: money(0),
    lines: [...desired(100, 2), ...desired(100, 2, ids.b)].map(line => line.quoteLine) };
  const expected = quote.lines.map(({ sku, quantity }) => ({ sku, quantity }));
  expect(() => assertRecurringEditQuote("XXX", expected, quote)).not.toThrow();
  if (alteration === "total") quote.totalGross.amountMinor--;
  if (alteration === "subtotal") quote.subtotalGross.amountMinor--;
  if (alteration === "discount") quote.discountTotalGross.amountMinor++;
  if (alteration === "missing") quote.lines = [];
  if (alteration === "extra") quote.lines.push(quote.lines[0]);
  if (alteration === "reorder") quote.lines.reverse();
  if (alteration === "sku") quote.lines[0].sku = ids.addon;
  if (alteration === "quantity") quote.lines[0].quantity++;
  expect(() => assertRecurringEditQuote("XXX", expected, quote)).toThrow(new Error(reason));
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
it("LC9-S-026 sized inner digest keeps retained and changed quote bytes", async () => {
  const current = context(), db = { query: async () => ({ rows: [] }) };
  const hostPorts = host();
  const request = { subscriptionId: ids.subscription,action: "update_base_mix" as const,base: [{ variantId: ids.b,qty: 4 }] };
  const priced = await quoteSizedEdit({ db,context: current,request,policy,host: hostPorts,point: "preview" });
  expect(priced.lines.map(line => line.variantId)).toEqual([ids.b,ids.addon]);
  expect(priced.quote.lines[1]).toEqual(current.lines[1].quoteLine);
  expect(priced.quoteHash).toBe("024f2287cf738635ee9615c81bb598a328bdc1be68a91350dafd32eae951fdbe");
  const before = baseline(), changed = { ...before, fingerprint: "c".repeat(64) };
  const first = buildEditConsent(before,priced.quoteHash,priced.lines), second = buildEditConsent(changed,priced.quoteHash,priced.lines);
  expect(first.innerQuoteHash).toBe(second.innerQuoteHash);
  expect(first.lines).toEqual(second.lines);
  expect(hashEditConsent(first)).not.toBe(hashEditConsent(second));
  const original = hostPorts.quotePort.createServerAuthoritativeQuote;
  hostPorts.quotePort = { async createServerAuthoritativeQuote(input) {
    const outcome = await original(input);
    outcome.quote.lines[0].pricingComponents = [];
    return outcome;
  } };
  const noComponents = await quoteSizedEdit({ db,context: current,request,policy,host: hostPorts,point: "apply" });
  expect(noComponents.quoteHash).not.toBe(priced.quoteHash);
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
