import { describe, expect, it, vi } from "vitest";
import { splitBySubscriptionAgreement, mergeSubscriptionAgreedQuote, agreedSubscriptionTotal } from "../../src/subscriptions/agreedPlanQuote.js";
import { createSizedEditContextScope, normalizeSizedEdit, sizedEditPhase } from "../../src/subscriptions/sizedEditContext.js";
import { createSizedCompositionRules } from "../../src/subscriptions/sizedComposition.js";
import { quoteSizedEdit, selectSizedAgreements, sizedCandidateCompatibility } from "../../src/subscriptions/sizedEditQuote.js";
import { createOfferDispatchedSubscriptionEditor, mapSizedEditError, createPostgresSizedEditor } from "../../src/subscriptions/sizedEditor.js";
import { SIZED_PARCEL_LEVER_KIND, type SizedEditRequest } from "../../src/subscriptions/contracts/sizedEdit.js";
import { agreed, catalog, context, fullQuote, host, ids, money, policy, quoteLine } from "./sizedFixtures.js";
const db = { query: vi.fn(async () => ({ rows: [] })) };
const coreConstraint = (value = 4) => ({ kind: "subscription.sized", version: 1, data: { kind: "unit_count", dailyNeed: 4, value } });
const parcel = (qty = 4): SizedEditRequest => ({ subscriptionId: ids.subscription, action: "resize_bundle", cadenceDays: 20,
  compositionConstraint: coreConstraint(qty).data, resizeLever: { kind: SIZED_PARCEL_LEVER_KIND, value: { coreLines: [{ variantId: ids.a, qty }] } } });
function rules(options: Partial<Parameters<typeof createSizedCompositionRules>[0]> = {}) {
  return createSizedCompositionRules({ policy, catalog: catalog(), baseline: [agreed()], exclusions: [], dailyNeed: 4, cadenceDays: 20,
    proposePortion: host().proposePortion, ...options });
}
const validate = (port: ReturnType<typeof rules>, lines = [{ variantId: ids.a, qty: 4, isAddon: false }]) => port.validateComposition({ coreLines: lines,
  constraint: coreConstraint(lines.reduce((sum, line) => sum + line.qty, 0)) });
describe("full agreed pricing", () => {
  it("matches exact SKU, quantity and classification once and preserves every unchanged field", () => {
    const saved = agreed(), request = { mode: "subscription" as const, promoCodes: [], cadenceDays: 30,
      lines: [{ sku: saved.sku, quantity: 4, isAddon: false }, { sku: saved.sku, quantity: 4, isAddon: false }, { sku: saved.sku, quantity: 4, isAddon: true }] };
    const split = splitBySubscriptionAgreement(request, [saved]); expect(split.unchanged).toHaveLength(1); expect(split.changed).toHaveLength(2);
    const merged = mergeSubscriptionAgreedQuote({ request, ...split, currency: "XXX", changedQuote: fullQuote(split.changed.map(({ line }) => quoteLine(line.sku, line.quantity, 137))) });
    expect(merged.lines[0]).toBe(saved.quoteLine); expect(JSON.stringify(merged.lines[0])).toBe(JSON.stringify(saved.quoteLine));
    expect(merged.totalGross).toEqual(money(1496));
  });
  it("reprices the entire changed line, removes absent lines and never quotes a cadence-only change", async () => {
    const ports = host(), live = vi.spyOn(ports.quotePort, "createServerAuthoritativeQuote");
    const changed = await quoteSizedEdit({ db, context: context(), request: parcel(5), policy, host: ports, point: "preview" });
    expect(live.mock.calls[0][0].lines).toEqual([{ sku: ids.a, quantity: 5, modeAtLine: "subscription", isAddon: false }]);
    expect(changed.lines[1].quoteLine).toEqual(context().lines[1].quoteLine); expect(changed.newRecurringPrice).toEqual(money(785));
    live.mockClear(); const cadence = await quoteSizedEdit({ db, context: context(), request: { subscriptionId: ids.subscription, action: "update_plan_length", planDays: 30 }, policy, host: ports, point: "preview" });
    expect(live).not.toHaveBeenCalled(); expect(cadence.lines.map(line => line.qty)).toEqual([4, 1]); expect(cadence.changedLines).toBe(0);
  });
  it.each(["discount", "shipping", "shippingDiscount", "cardinality", "identity", "money", "currency"])("refuses changed quote %s corruption", reason => {
    const request = { mode: "subscription" as const, promoCodes: [], lines: [{ sku: ids.b, quantity: 4 }] };
    const quote = fullQuote([quoteLine(ids.b, 4)]);
    if (reason === "discount") quote.discountTotalGross = money(1);
    if (reason === "shipping") quote.shippingGross = money(1);
    if (reason === "shippingDiscount") quote.shippingDiscountGross = money(1);
    if (reason === "cardinality") quote.lines = [];
    if (reason === "identity") quote.lines[0].sku = ids.a;
    if (reason === "money") quote.lines[0].unitPriceGross.amountMinor = -1;
    if (reason === "currency") quote.lines[0].unitPriceGross.currency = "YYY";
    expect(() => mergeSubscriptionAgreedQuote({ request, currency: "XXX", unchanged: [], changedQuote: quote })).toThrow(/subscription_reprice/u);
  });
  it("refuses malformed or disagreeing saved agreements", () => {
    const line = agreed(); line.qty = 5; expect(() => agreedSubscriptionTotal([line])).toThrow("subscription_reprice_sized_agreed_price_unreadable");
  });
});
describe("request scope and derived phase", () => {
  it("memoizes subscription/opt-in per request, clones results, and reads on a new request", async () => {
    const read = vi.fn(async () => context()), scope = createSizedEditContextScope(read);
    const first = await scope(ids.subscription); first.lines[0].qty = 99;
    expect((await scope(ids.subscription)).lines[0].qty).toBe(4); await scope(ids.subscription, true); expect(read).toHaveBeenCalledTimes(2);
    await createSizedEditContextScope(read)(ids.subscription); expect(read).toHaveBeenCalledTimes(3);
  });
  it("uses frozen graduation core and current add-on agreements", () => {
    const current = context(); current.paidCycleCount = 2;
    current.marker = { basisTemplateVersion: 1, graduation: { cadenceDays: 30, lines: [] } }; current.graduationLines = [agreed(ids.b, 4)];
    expect(selectSizedAgreements(current, policy)).toEqual([current.graduationLines[0], current.lines[1]]);
    expect(sizedEditPhase(current, policy)).toBe("graduation_pending"); current.templateVersion = 2; expect(sizedEditPhase(current, policy)).toBe("none");
  });
  it("refuses opt-in in either introductory phase and normalizes frozen mix and portion actions", () => {
    const current = context(); current.binding = "classic"; current.marker = { basisTemplateVersion: 1, graduation: { cadenceDays: 30, lines: [] } };
    const request = parcel(); if (request.action !== "resize_bundle" || request.resizeLever.kind !== SIZED_PARCEL_LEVER_KIND) throw new Error("fixture");
    request.resizeLever.value.optInToSized = true;
    expect(() => normalizeSizedEdit(request, current, policy)).toThrow("subscription_edit_invalid_intro_fixed");
    current.paidCycleCount = 2; expect(() => normalizeSizedEdit(request, current, policy)).toThrow("subscription_edit_invalid_intro_fixed");
    current.binding = "sized.v1"; current.graduationLines = [agreed(ids.b, 4)];
    expect(normalizeSizedEdit({ subscriptionId: ids.subscription, action: "update_base_mix", base: [{ variantId: ids.a, qty: 4 }] }, current, policy)).toMatchObject({ action: "resize_bundle", cadenceDays: 30 });
    expect(normalizeSizedEdit({ subscriptionId: ids.subscription, action: "update_portion", portionMode: "partial" }, current, policy)).toMatchObject({ action: "resize_bundle", cadenceDays: 30, resizeLever: { kind: "portionMode", value: { planDays: 30 } } });
    expect(() => normalizeSizedEdit({ subscriptionId: ids.subscription, action: "add_addon", variantId: ids.addon, qty: 1 }, current, policy)).toThrow("subscription_edit_invalid_graduation_addon");
    expect(() => normalizeSizedEdit({ subscriptionId: ids.subscription, action: "update_bundle", coreLines: [{ variantId: ids.b, qty: 4 }], addonLines: [], compositionConstraint: coreConstraint().data }, current, policy)).toThrow("subscription_reprice_sized_graduation_addon_rewrite_unavailable");
    for (const invalid of [{ ...coreConstraint().data, dailyNeed: 999 }, { ...coreConstraint().data, value: 5 }])
      expect(() => normalizeSizedEdit({ subscriptionId: ids.subscription, action: "update_bundle", coreLines: [{ variantId: ids.b, qty: 4 }], compositionConstraint: invalid }, current, policy)).toThrow("subscription_reprice_sized_lever_mismatch");
  });
  it("derives opt-in need from the host and preserves the configured reduced portion", async () => {
    const current = context(); current.binding = "classic"; current.compositionConstraint = { dailyNeed: 999, mode: "partial" };
    const ports = host(), read = vi.spyOn(ports, "resolveOptInNeed");
    const request = parcel(); if (request.action !== "resize_bundle" || request.resizeLever.kind !== SIZED_PARCEL_LEVER_KIND) throw new Error("fixture");
    request.resizeLever.value.optInToSized = true; request.compositionConstraint = { kind: "unit_count", value: 4, dailyNeed: 4, mode: "partial", portionFactor: 0.5 };
    const quote = await quoteSizedEdit({ db, context: current, request, policy, host: ports, point: "preview" });
    expect(read).toHaveBeenCalledOnce(); expect(quote.compositionConstraint).toEqual(request.compositionConstraint);
    const ordinary = host(), forbid = vi.spyOn(ordinary, "resolveOptInNeed");
    await quoteSizedEdit({ db, context: context(), request: parcel(), policy, host: ordinary, point: "preview" }); expect(forbid).not.toHaveBeenCalled();
  });
});
describe("agreement-relative composition", () => {
  it.each([0, null])("keeps unchanged/reduced quantity at stock %s and refuses an increase", async stock => {
    const facts = catalog(); facts[0].sellableNow = stock; const port = rules({ catalog: facts, baseline: [agreed(ids.a, 6)] });
    expect(await validate(port, [{ variantId: ids.a, qty: 6, isAddon: false }])).toEqual({ ok: true });
    expect(await validate(port)).toEqual({ ok: true });
    expect(await validate(port, [{ variantId: ids.a, qty: 7, isAddon: false }])).toMatchObject({ code: "subscription_reprice_sized_stock_unavailable" });
  });
  it("uses the absolute stock cap, permits mixed physical sizes, and refuses two sizes in one group", async () => {
    const facts = catalog(); facts[0].sellableNow = 5;
    expect(await validate(rules({ catalog: facts }), [{ variantId: ids.a, qty: 6, isAddon: false }])).toMatchObject({ code: "subscription_reprice_sized_stock_unavailable" });
    const lines = [{ variantId: ids.a, qty: 2, isAddon: false }, { variantId: ids.b, qty: 2, isAddon: false }];
    expect(await validate(rules({ catalog: facts }), lines)).toEqual({ ok: true });
    facts[1].groupId = facts[0].groupId; expect(await validate(rules({ catalog: facts }), lines)).toMatchObject({ code: "subscription_reprice_sized_line_not_sellable" });
  });
  it("replaces the full count and applies the exact withdrawn-quantity rule", async () => {
    const facts = catalog(); facts[1].sellableNow = 3;
    expect(await validate(rules({ catalog: facts }), [{ variantId: ids.b, qty: 4, isAddon: false }])).toMatchObject({ code: "subscription_reprice_sized_stock_unavailable" });
    facts[0].sellable = false; const port = rules({ catalog: facts, baseline: [agreed(ids.a, 6)] });
    expect(await validate(port, [{ variantId: ids.a, qty: 6, isAddon: false }])).toEqual({ ok: true });
    expect(await validate(port)).toMatchObject({ code: "subscription_reprice_sized_line_not_sellable" });
  });
  it.each(["minimum", "quantity", "duplicate", "addon", "missing", "unverified", "identity", "document"])("refuses invalid %s composition/facts", async reason => {
    const facts = catalog(); const lines = [{ variantId: ids.a, qty: 4, isAddon: false }];
    if (reason === "minimum") lines[0].qty = 3;
    if (reason === "quantity") lines[0].qty = 13;
    if (reason === "duplicate") lines.push({ ...lines[0] });
    if (reason === "addon") lines[0].isAddon = true;
    if (reason === "missing") facts.shift();
    if (reason === "unverified") facts[0].verified = false;
    if (reason === "identity") facts.push({ ...facts[0] });
    if (reason === "document") facts[0].documentDigest = "invalid";
    if (["unverified", "identity", "document"].includes(reason)) expect(() => rules({ catalog: facts })).toThrow(/subscription_reprice_sized/u);
    else expect(await validate(rules({ catalog: facts }), lines)).toMatchObject({ ok: false });
  });
  it("keeps agreed exclusion exceptions but refuses increases and explicit cadence edits", async () => {
    const facts = catalog(); facts[0].exclusions = ["restricted"];
    const port = rules({ catalog: facts, exclusions: ["restricted"], baseline: [agreed(ids.a, 6)] });
    expect(await validate(port)).toEqual({ ok: true });
    expect(await validate(port, [{ variantId: ids.a, qty: 7, isAddon: false }])).toMatchObject({ code: "subscription_reprice_sized_exclusion_conflict" });
    await expect(port.resizeComposition({ coreLines: [{ variantId: ids.a, qty: 6, isAddon: false }], constraint: coreConstraint(6), lever: { kind: "planLength", value: 30 } })).rejects.toThrow("subscription_reprice_sized_exclusion_conflict");
    expect(sizedCandidateCompatibility(facts, { subscriptionId: ids.subscription, clientId: ids.client, subjectRef: "owned", exclusions: ["restricted"], snapshot: {} })[0].selectable).toBe(false);
    facts[0].exclusions = null; expect(await validate(rules({ catalog: facts }))).toMatchObject({ code: "subscription_reprice_sized_exclusion_facts_unreadable" });
  });
  it("checks configured cadence, portion reduction and the generated proposal again", async () => {
    const port = rules({ baseline: [agreed(ids.a, 8)] });
    const resize = (mode: string) => port.resizeComposition({ coreLines: [{ variantId: ids.a, qty: 8, isAddon: false }], constraint: coreConstraint(8), lever: { kind: "portionMode", value: { portionMode: mode, planDays: 20 } } });
    expect((await resize("partial"))?.coreLines[0].qty).toBe(4); expect((await resize("complete"))?.coreLines[0].qty).toBe(8);
    await expect(rules({ baseline: [agreed(ids.a, 8)], proposePortion: async () => [{ variantId: ids.a, qty: 8 }] }).resizeComposition({ coreLines: [{ variantId: ids.a, qty: 8 }], constraint: coreConstraint(8), lever: { kind: "portionMode", value: { portionMode: "partial", planDays: 20 } } })).rejects.toThrow("subscription_reprice_sized_portion_no_reduction");
    await expect(port.resizeComposition({ coreLines: [], constraint: coreConstraint(), lever: { kind: "planLength", value: 17 } })).rejects.toThrow(/subscription_reprice_sized/u);
    const facts = catalog(); facts[1].exclusions = ["restricted"];
    await expect(rules({ catalog: facts, exclusions: ["restricted"], baseline: [agreed(ids.a, 8)], proposePortion: async () => [{ variantId: ids.b, qty: 4 }] }).resizeComposition({ coreLines: [{ variantId: ids.a, qty: 8 }], constraint: coreConstraint(8), lever: { kind: "portionMode", value: { portionMode: "partial", planDays: 20 } } })).rejects.toThrow("subscription_reprice_sized_exclusion_conflict");
  });
});
it("dispatches ordinary classic/lifecycle without sized reads and never falls back after a binding failure", async () => {
  const classic = { preview: vi.fn(async () => "classic"), apply: vi.fn(async () => "classic") }, sized = { preview: vi.fn(async () => "sized"), apply: vi.fn(async () => "sized") };
  const read = vi.fn(async () => "classic" as "classic" | "sized.v1" | null);
  const dispatcher = createOfferDispatchedSubscriptionEditor({ readBinding: read, classic, sized: sized as never }), actor = { clientId: ids.client, actorId: ids.actor };
  expect(await dispatcher.preview(actor, parcel())).toBe("classic");
  const optIn = parcel();
  if (optIn.action === "resize_bundle" && optIn.resizeLever.kind === SIZED_PARCEL_LEVER_KIND) optIn.resizeLever.value.optInToSized = true;
  expect(await dispatcher.preview(actor, optIn)).toBe("sized");
  read.mockResolvedValue("sized.v1"); expect(await dispatcher.preview(actor, { subscriptionId: ids.subscription, action: "cancel" })).toBe("classic");
  expect(await dispatcher.preview(actor, parcel())).toBe("sized");
  read.mockRejectedValueOnce(new Error("binding unavailable")); await expect(dispatcher.preview(actor, parcel())).rejects.toThrow("binding unavailable");
  read.mockResolvedValue(null); await expect(dispatcher.preview(actor, parcel())).rejects.toThrow("subscription_command_forbidden");
  read.mockResolvedValue("sized.v1"); await expect(dispatcher.preview(actor, { subscriptionId: ids.subscription, action: "update_package_template" })).rejects.toThrow("configured_offer_action_mismatch");
});
it("keeps unavailable stock as infrastructure error and maps bounded policy and binding refusals", () => {
  expect(mapSizedEditError(new Error("subscription_reprice_sized_stock_unavailable"), "preview").status).toBe(503);
  expect(mapSizedEditError(new Error("subscription_reprice_sized_exclusion_conflict"), "preview").status).toBe(400);
  expect(mapSizedEditError(new Error("subscription_edit_invalid_intro_fixed"), "preview").status).toBe(409);
  expect(mapSizedEditError(new Error("subscription_edit_invalid_agreed_price"), "preview")).toMatchObject({ status: 400, reason: "subscription_reprice_sized_agreed_price_unreadable" });
});
it("refuses caller price and subject evidence before database access", async () => {
  const transaction = vi.fn(async () => { throw new Error("database must not run"); });
  const editor = createPostgresSizedEditor({ ...host(), policy, now: () => "2026-11-06T12:00:00Z", withTransaction: transaction });
  await expect(editor.preview({ actorId: ids.actor, clientId: ids.client }, { ...parcel(), subjectFacts: {} } as never)).rejects.toThrow("subscription_reprice_invalid_request");
  expect(transaction).not.toHaveBeenCalled();
});
it("refuses unreadable/foreign host facts and invalid frozen need", async () => {
  for (const kind of ["missing", "foreign", "exclusions", "need"]) {
    const current = context(), ports = host();
    if (kind === "missing") ports.readFacts = async () => ({}) as never;
    if (kind === "foreign") ports.readFacts = async () => ({ clientId: ids.actor, subscriptionId: ids.subscription, subjectRef: "foreign", exclusions: [], snapshot: {} });
    if (kind === "exclusions") ports.readFacts = async () => ({ clientId: ids.client, subscriptionId: ids.subscription, subjectRef: "owned", exclusions: undefined as never, snapshot: {} });
    if (kind === "need") current.compositionConstraint!.dailyNeed = 0;
    await expect(quoteSizedEdit({ db, context: current, request: parcel(), policy, host: ports, point: "preview" })).rejects.toThrow(/subscription_reprice_sized_/u);
  }
});
