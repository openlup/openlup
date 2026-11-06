import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createPostgresAccountReadSources, createPostgresCustomerOrderHistoryReadStore } from "@openlup/platform/account-support";
import { api, purchase, admin, at, checkout, days, deps, executor, facts, identity, now, payments, rpc, runtime, runtimeUrl, transaction } from "./subscriptionPublicRenewalFixture.js";
import { captureSandboxPurchase } from "../helpers/captureSandboxPurchase.js";
import { allPublicRows } from "./subscriptionStockWaitCases.js";
import type { RenewalRetainedTerms } from "@openlup/platform/subscriptions/contracts";

const list = "33333333-3333-4333-8333-333333333333", variant = "22222222-2222-4222-8222-222222222222";
const extraLists: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  if (extraLists.length) await admin.query("UPDATE public.price_lists SET status='archived' WHERE id=ANY($1::uuid[])", [extraLists.splice(0)]);
  await admin.query("UPDATE public.price_lists SET status='active' WHERE id=$1", [list]);
});
async function candidate(price = 100) {
  const id = randomUUID(); extraLists.push(id);
  await admin.query("INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES($1,'Synthetic alternative','ZZ','XXX','2026-01-01T00:00:00Z')", [id]);
  await admin.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,'any',$3,'2026-01-01T00:00:00Z')", [id, variant, price]);
  return id;
}
async function activate(p: Awaited<ReturnType<typeof purchase>>, renewalTerms?: RenewalRetainedTerms) {
  const result = await api.activateNativePurchaseWithRenewal(executor, { ...p, facts: { ...facts, ...(renewalTerms ? { renewalTerms } : {}) } });
  expect(result.renewalAttachment).toBe("complete");
  return { ...p, subscriptionId: String(result.activation.subscriptionId) };
}
async function state(id: string) {
  return (await runtime.query("SELECT price_list_id,currency_code,status,next_cycle_at::text,template_version FROM public.subscriptions WHERE id=$1", [id])).rows[0];
}
async function accountLines(f: Awaited<ReturnType<typeof activate>>) {
  const principalId = String((await runtime.query("SELECT principal_id FROM public.clients WHERE id=$1", [f.clientId])).rows[0].principal_id);
  const scope = { principalId, clientId: f.clientId };
  const sources = createPostgresAccountReadSources(executor, { ...scope,
    orders: createPostgresCustomerOrderHistoryReadStore(executor, { ...scope, readInvoiceSummaries: async () => new Map() }),
    orderProjection: { automaticHoldSource: "synthetic.hold", automaticReleaseSource: "synthetic.release", orderReference: id => id,
      presentation: { display: () => ({ title: "Refill", variantName: null, productSlug: null, displayLabel: null, accentColor: null }) },
      fulfillmentEvidence: () => ({ trackingReferences: [], trackingNumbers: [], trackingNumber: null, trackingUrl: null, carrierKind: null, service: null, trackingTimeline: [] }) },
    additional: { readExtension: async () => null, readNextCharges: async () => new Map() }, now: () => at });
  return (await sources.readSubscriptionLines([f.subscriptionId])).get(f.subscriptionId);
}
async function edit(f: Awaited<ReturnType<typeof activate>>) {
  const store = api.createPostgresSubscriptionCommandStore({ withTransaction: transaction });
  const input = { actorId: randomUUID(), clientId: f.clientId, subscriptionId: f.subscriptionId,
    idempotencyKey: randomUUID(), action: "resize_bundle", now: days(at, 1),
    payload: { expectedTemplateVersion: 1, cadenceDays: 28, coreLines: [{ variantId: variant, qty: 3 }], compositionConstraint: { kind: "units", value: 3 } } };
  const preview = await store.preview(input);
  if (preview.status !== "previewed") return preview;
  return store.apply({ ...input, payload: { ...input.payload, acceptedQuoteHash: preview.quoteHash } });
}

it("materializes the purchased account template and admits an edit before delivery two without changing the due anchor", async () => {
  const p = await purchase(), f = await activate(p), before = await state(f.subscriptionId);
  expect(before).toMatchObject({ price_list_id: list, currency_code: "XXX", status: "active", template_version: 1 });
  expect(await accountLines(f)).toMatchObject([{ variantId: variant, qty: 2, sortOrder: 0, isAddon: false, unitPrice: { amountMinor: 100, currency: "XXX" } }]);
  expect((await runtime.query("SELECT line_ordinal,sku,quantity,unit_amount_minor::int FROM public.subscription_renewal_term_lines WHERE subscription_id=$1", [f.subscriptionId])).rows).toEqual([
    { line_ordinal: 1, sku: "G7-REFILL", quantity: 2, unit_amount_minor: 100 }]);
  expect(await edit(f)).toMatchObject({ status: "applied", templateVersion: 2 });
  const edited = await accountLines(f);
  expect(edited).toMatchObject([{ qty: 3 }]);
  expect(await api.createPostgresPurchaseRenewalWriter(executor).complete(p.orderId)).toMatchObject({ replayed: true });
  expect(await accountLines(f)).toEqual(edited);
  expect(await state(f.subscriptionId)).toMatchObject({ next_cycle_at: before.next_cycle_at, status: "active" });
  expect((await runtime.query("SELECT 1 FROM public.subscription_pause_windows WHERE subscription_id=$1", [f.subscriptionId])).rows).toEqual([]);
});

it.each(["missing", "ambiguous"])("keeps account lines and refuses edits with a neutral %s price-list reason", async reason => {
  const p = await purchase();
  if (reason === "missing") await admin.query("UPDATE public.price_lists SET status='archived' WHERE id=$1", [list]);
  else await candidate();
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  await admin.query("REVOKE UPDATE ON public.subscriptions FROM service_role; GRANT UPDATE(updated_at) ON public.subscriptions TO service_role");
  try {
    const f = await activate(p), before = await state(f.subscriptionId);
    expect(before).toMatchObject({ price_list_id: null, currency_code: null, status: "active" });
    expect(await accountLines(f)).toMatchObject([{ qty: 2, sortOrder: 0, isAddon: false }]);
    expect(await edit(f)).toMatchObject({ status: "refused", reason: "subscription_edit_invalid_request" });
    expect(log.mock.calls).toEqual([["subscription_price_list_unresolved", reason]]);
    expect(await state(f.subscriptionId)).toEqual(before);
  } finally {
    await admin.query("REVOKE UPDATE(updated_at) ON public.subscriptions FROM service_role; GRANT UPDATE ON public.subscriptions TO service_role");
  }
});

it("honors exact-mode, minimum-quantity and id precedence before comparing admitted unit prices", async () => {
  const p = await purchase();
  const wrongMode = await candidate(), wrongTier = await candidate(), wrongId = await candidate();
  await admin.query(`INSERT INTO public.price_entries(id,price_list_id,variant_id,mode,min_qty,unit_price_minor,valid_from)
    VALUES('00000000-0000-4000-8000-000000000001',$1,$4,'subscription',1,99,'2026-01-01T00:00:00Z'),
      ('00000000-0000-4000-8000-000000000002',$2,$4,'any',2,99,'2026-01-01T00:00:00Z'),
      ('00000000-0000-4000-8000-000000000003',$3,$4,'any',1,99,'2026-01-01T00:00:00Z')`, [wrongMode, wrongTier, wrongId, variant]);
  const f = await activate(p);
  expect(await state(f.subscriptionId)).toMatchObject({ price_list_id: list, currency_code: "XXX" });
});

it("rolls template and price context back on a line-write failure, then completes once", async () => {
  const p = await purchase();
  const writer = api.createPostgresPurchaseRenewalWriter(executor);
  await writer.register(p.orderId, facts);
  const activation = await rpc<{ subscriptionId: string }>("subscription_activate_from_captured_payment", [p.idempotencyKey, p.orderId, createHash("sha256").update(p.capturedReference).digest("hex")]);
  const before = await state(activation.subscriptionId);
  await admin.query(`ALTER TABLE public.subscription_lines ADD CONSTRAINT synthetic_template_fault CHECK (quantity<>2) NOT VALID`);
  try { await expect(writer.complete(p.orderId)).rejects.toMatchObject({ code: "23514" }); }
  finally { await admin.query("ALTER TABLE public.subscription_lines DROP CONSTRAINT synthetic_template_fault"); }
  expect(await state(activation.subscriptionId)).toEqual(before);
  expect((await runtime.query("SELECT 1 FROM public.subscription_renewal_terms WHERE subscription_id=$1", [activation.subscriptionId])).rows).toEqual([]);
  expect(await writer.pending()).toContainEqual({ orderId: p.orderId, subscriptionId: activation.subscriptionId, hasPurchaseFacts: true });
  expect(await writer.complete(p.orderId)).toMatchObject({ replayed: false });
  expect((await runtime.query("SELECT 1 FROM public.subscription_lines WHERE subscription_id=$1", [activation.subscriptionId])).rows).toHaveLength(1);
});

function retainedTerms(): RenewalRetainedTerms {
  return { version: "native.renewal-terms.v1", minimumPayableMinor: 1, normalCadenceDays: [30],
    starterPack: { schemaVersion: "1", starterIntervalDays: 28, basisTemplateVersion: 1,
      delivery2: { discountBps: 0, discountMinor: 0, basisSubtotalMinor: 200 },
      graduation: { cadenceDays: 30, lines: [{ sku: "G7-REFILL", qty: 3, sortOrder: 0, isAddon: false,
        quoteLine: { unitPriceGross: { amountMinor: 100 }, lineSubtotalGross: { amountMinor: 300 } } }] } } };
}

it("resolves an absent price context at graduation while retaining the due anchor and active service", async () => {
  const p = await purchase();
  const terms = retainedTerms();
  await admin.query("UPDATE public.price_lists SET status='archived' WHERE id=$1", [list]);
  const log = vi.spyOn(console, "warn").mockImplementation(() => {}), f = await activate(p, terms);
  expect(await state(f.subscriptionId)).toMatchObject({ price_list_id: null, currency_code: null });
  await admin.query("UPDATE public.price_lists SET status='active' WHERE id=$1", [list]);
  const d = await deps(f.subscriptionId, "succeeded", now);
  d.input.store = api.createPostgresRenewalStore(executor, d.codec, transaction);
  d.input.settlement = api.createPostgresRenewalSettlementPort(executor, d.codec, transaction);
  expect(await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now)).toMatchObject({ status: "succeeded" });
  const before = await state(f.subscriptionId), nextAt = new Date(String(before.next_cycle_at)).toISOString();
  const snapshot = await d.input.store.buildCycleSnapshots({ subscriptionId: f.subscriptionId, scheduledAt: nextAt, scheduledInstant: Date.parse(nextAt) });
  expect(snapshot.templateSnapshot).toMatchObject({ cadenceDays: 30, lines: [{ quantity: 3 }] });
  expect(await state(f.subscriptionId)).toMatchObject({ price_list_id: list, currency_code: "XXX", next_cycle_at: before.next_cycle_at, status: "active" });
  expect(log.mock.calls).toEqual([["subscription_price_list_unresolved", "missing"]]);
});

it("keeps template lines visible when runtime price reads are unavailable, without trying a forbidden SELECT", async () => {
  const p = await purchase(), writer = api.createPostgresPurchaseRenewalWriter(executor);
  await writer.register(p.orderId, facts);
  const activation = await rpc<{ subscriptionId: string }>("subscription_activate_from_captured_payment", [p.idempotencyKey, p.orderId, createHash("sha256").update(p.capturedReference).digest("hex")]);
  const before = await state(activation.subscriptionId);
  // Narrow an existing qualified runtime grant for this witness; restore exactly
  // that existing grant afterwards. This does not provision a legacy runtime.
  await admin.query("REVOKE SELECT ON public.price_lists,public.price_entries,public.commerce_order_items FROM service_role");
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect((await runtime.query("SELECT has_table_privilege(current_user,'public.price_lists','SELECT') AS allowed")).rows[0].allowed).toBe(false);
    expect(await writer.complete(p.orderId)).toMatchObject({ replayed: false });
    const f = { ...p, subscriptionId: activation.subscriptionId };
    expect(await accountLines(f)).toMatchObject([{ qty: 2, isAddon: false }]);
    expect(await state(f.subscriptionId)).toEqual(before);
    expect(await edit(f)).toMatchObject({ status: "refused", reason: "subscription_edit_invalid_request" });
    expect(log.mock.calls).toEqual([["subscription_price_list_unresolved", "read_unavailable"]]);
  } finally { await admin.query("GRANT SELECT ON public.price_lists,public.price_entries,public.commerce_order_items TO service_role"); }
});


it("retries a failure between template materialization and completion without duplicates or overwriting an edit", async () => {
  const p = await purchase();
  const writer = api.createPostgresPurchaseRenewalWriter(executor);
  await writer.register(p.orderId, facts);
  const activation = await rpc<{ subscriptionId: string }>("subscription_activate_from_captured_payment", [p.idempotencyKey, p.orderId,
    createHash("sha256").update(p.capturedReference).digest("hex")]);
  const f = { ...p, subscriptionId: activation.subscriptionId }, before = await state(f.subscriptionId);
  const failing = api.createPostgresPurchaseRenewalWriter({ query(sql, values) {
    if (sql.includes("subscription_complete_renewal_attachment")) throw new Error("synthetic_completion_interruption");
    return executor.query(sql, values);
  } });
  await expect(failing.complete(p.orderId)).rejects.toThrow("synthetic_completion_interruption");
  const materialized = await accountLines(f);
  expect(materialized).toMatchObject([{ qty: 2, isAddon: false }]);
  expect(await writer.pending()).toContainEqual({ orderId: p.orderId, subscriptionId: f.subscriptionId, hasPurchaseFacts: true });
  expect((await runtime.query("SELECT 1 FROM public.subscription_renewal_terms WHERE subscription_id=$1", [f.subscriptionId])).rows).toEqual([]);
  expect(await writer.complete(p.orderId)).toMatchObject({ replayed: false });
  expect(await accountLines(f)).toEqual(materialized);
  expect(await edit(f)).toMatchObject({ status: "applied", templateVersion: 2 });
  const edited = await accountLines(f);
  expect(await writer.complete(p.orderId)).toMatchObject({ replayed: true });
  expect(await accountLines(f)).toEqual(edited);
  expect(await state(f.subscriptionId)).toMatchObject({ status: "active", next_cycle_at: before.next_cycle_at });
});


it.each(["template", "context"])("completes without materialization when %s privileges are unavailable and replays without writes", async scope => {
  const p = await purchase(), writer = api.createPostgresPurchaseRenewalWriter(executor);
  await writer.register(p.orderId, facts);
  const activation = await rpc<{ subscriptionId: string }>("subscription_activate_from_captured_payment", [p.idempotencyKey, p.orderId,
    createHash("sha256").update(p.capturedReference).digest("hex")]);
  const id = activation.subscriptionId;
  const observe = () => admin.query("SELECT status,next_cycle_at::text,price_list_id,currency_code FROM public.subscriptions WHERE id=$1", [id]).then(r => r.rows[0]);
  const before = await observe(), log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const queries: string[] = [];
  const narrowed = api.createPostgresPurchaseRenewalWriter({ query(sql, values) { queries.push(sql); return executor.query(sql, values); } });
  try {
    await admin.query("REVOKE UPDATE ON public.subscriptions FROM service_role; GRANT UPDATE(updated_at) ON public.subscriptions TO service_role");
    if (scope === "template") await admin.query(`
      REVOKE SELECT,INSERT ON public.subscription_lines FROM service_role;
      REVOKE SELECT ON public.subscription_activations,public.commerce_orders,public.subscriptions FROM service_role;
      GRANT SELECT(id,client_id,status,created_at,updated_at) ON public.commerce_orders TO service_role;
      GRANT SELECT(id,client_id,updated_at,cadence_days,template_version,currency_code,status,next_cycle_at) ON public.subscriptions TO service_role`);
    expect((await runtime.query("SELECT has_column_privilege(current_user,'public.subscriptions','price_list_id','UPDATE') AS allowed")).rows[0].allowed).toBe(false);
    expect(await narrowed.complete(p.orderId)).toMatchObject({ subscriptionId: id, replayed: false });
    expect(queries).toHaveLength(scope === "template" ? 2 : 3);
    expect(queries.some(sql => sql.includes("WITH pending AS MATERIALIZED"))).toBe(false);
    expect(await observe()).toEqual(before);
    expect(before).toMatchObject({ status: "active", price_list_id: null, currency_code: null });
    expect((await admin.query("SELECT 1 FROM public.subscription_lines WHERE subscription_id=$1", [id])).rows).toEqual([]);
    expect(log.mock.calls).toEqual([["subscription_template_unavailable", "privileges_unavailable"]]);
    const completed = await allPublicRows(admin);
    log.mockClear(); queries.length = 0;
    expect(await narrowed.complete(p.orderId)).toMatchObject({ subscriptionId: id, replayed: true });
    expect(await allPublicRows(admin)).toEqual(completed);
    expect(queries.some(sql => sql.includes("WITH pending AS MATERIALIZED"))).toBe(false);
    expect(log.mock.calls).toEqual([["subscription_template_unavailable", "privileges_unavailable"]]);
  } finally {
    if (scope === "template") await admin.query(`
      REVOKE SELECT(id,client_id,status,created_at,updated_at) ON public.commerce_orders FROM service_role;
      REVOKE SELECT(id,client_id,updated_at,cadence_days,template_version,currency_code,status,next_cycle_at) ON public.subscriptions FROM service_role;
      GRANT SELECT ON public.commerce_orders,public.subscriptions,public.subscription_activations TO service_role;
      GRANT SELECT,INSERT ON public.subscription_lines TO service_role`);
    await admin.query("REVOKE UPDATE(updated_at) ON public.subscriptions FROM service_role; GRANT UPDATE ON public.subscriptions TO service_role");
  }
});

it.each(["read", "write"])("graduates without the new pair %s grant without blocking the existing graduation", async permission => {
  const p = await purchase();
  await admin.query("UPDATE public.price_lists SET status='archived' WHERE id=$1", [list]);
  const f = await activate(p, retainedTerms());
  await admin.query("UPDATE public.price_lists SET status='active' WHERE id=$1", [list]);
  const d = await deps(f.subscriptionId, "succeeded", now);
  d.input.store = api.createPostgresRenewalStore(executor, d.codec, transaction);
  d.input.settlement = api.createPostgresRenewalSettlementPort(executor, d.codec, transaction);
  expect(await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now)).toMatchObject({ status: "succeeded" });
  const before = await state(f.subscriptionId), nextAt = new Date(String(before.next_cycle_at)).toISOString();
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await admin.query("REVOKE UPDATE ON public.subscriptions FROM service_role; GRANT UPDATE(cadence_days,template_version,updated_at) ON public.subscriptions TO service_role");
    if (permission === "read") await admin.query("REVOKE SELECT ON public.subscriptions FROM service_role; GRANT SELECT(id,client_id,cadence_days,template_version,next_cycle_at,updated_at) ON public.subscriptions TO service_role");
    const snapshot = await d.input.store.buildCycleSnapshots({ subscriptionId: f.subscriptionId, scheduledAt: nextAt, scheduledInstant: Date.parse(nextAt) });
    expect(snapshot.templateSnapshot).toMatchObject({ cadenceDays: 30, lines: [{ quantity: 3 }] });
    expect((await admin.query("SELECT price_list_id,currency_code,next_cycle_at::text,status FROM public.subscriptions WHERE id=$1", [f.subscriptionId])).rows[0])
      .toMatchObject({ price_list_id: null, currency_code: null, next_cycle_at: before.next_cycle_at, status: "active" });
    expect(log.mock.calls).toEqual([["subscription_price_list_unresolved", permission === "read" ? "read_unavailable" : "write_unavailable"]]);
  } finally {
    if (permission === "read") await admin.query("REVOKE SELECT(id,client_id,cadence_days,template_version,next_cycle_at,updated_at) ON public.subscriptions FROM service_role; GRANT SELECT ON public.subscriptions TO service_role");
    await admin.query("REVOKE UPDATE(cadence_days,template_version,updated_at) ON public.subscriptions FROM service_role; GRANT UPDATE ON public.subscriptions TO service_role");
  }
});


// Same definition/quote fixture shape as m19CheckoutShipping; order positions
// are produced by the public checkout writer, never inserted by this witness.
async function draftedPurchase(mode: "subscription" | "one_time", discount = 0) {
  const accounts = identity.createPostgresAccountLinkStore({ connectionString: runtimeUrl });
  let clientId: string;
  try { clientId = (await accounts.createAccount({ email: `${randomUUID()}@example.invalid`, principalId: randomUUID(), acquisitionSource: "fixture", lifecycleStage: "customer" })).id; }
  finally { await accounts.close(); }
  const key = randomUUID(), promotionId = `promotion-${key}`, money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
  if (discount) await admin.query("INSERT INTO public.commerce_promotion_definitions(promotion_id,definition,active) VALUES($1,$2,true)", [promotionId, {
    id: promotionId, status: "active", name: "Configured benefit", code: null, trigger_type: "automatic", discount_type: "fixed_amount", discount_value: discount,
    applies_to_kind: "order_total", applies_to_payload: {}, stacking_rule: "exclusive", eligibility: {}, valid_from: "2020-01-01T00:00:00Z", valid_to: null,
    region_availability: ["ZZ"], redemption_limit_global: null, redemption_limit_per_customer: null }]);
  const made = await checkout.createPostgresNativeCheckoutPersistence(executor).createOrderDraft({ idempotencyKey: key,
    quoteSnapshot: { contractVersion: "commerce.v0", quote: { currency: "XXX", taxIncluded: true,
      lines: [{ sku: "G7-REFILL", productSlug: "g7-refill", quantity: 2, unitPriceGross: money(100), lineSubtotalGross: money(200),
        tax: { included: true, country: "ZZ", category: "standard", vatRateBps: 0, legalBasis: "Synthetic test tax", netAmount: money(200), vatAmount: money(0), grossAmount: money(200) } }],
      discounts: discount ? [{ promotionId, appliesTo: "order_total", amountOffMinor: discount, reasonCode: "configured" }] : [],
      context: { mode, cadenceDays: 28, promoCodes: [] }, subtotalGross: money(200), discountTotalGross: money(discount),
      shippingGross: money(0), shippingDiscountGross: money(0), totalGross: money(200 - discount), netTotal: money(200 - discount), taxTotal: money(0) } } }, { clientId });
  const orderId = String(made.orderDraft.orderId).replace(/^order_/, "");
  const intent = await rpc<{ settlement: { id: string } }>("commerce_open_settlement_intent", [`open:${key}`, orderId, "sandbox", 200 - discount, "XXX", "{}", at]);
  expect(await captureSandboxPurchase(payments.createPostgresSandboxPaymentSimulator(executor,
    { dunningTemplateSlug: "failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" }),
    { settlementIntentId: intent.settlement.id, key, at })).toMatchObject({ status: 200 });
  await rpc("subscription_declare_provisional_activation", [`declare:${key}`, orderId, 28, at]);
  const settled = (await runtime.query("SELECT external_ref,id FROM public.commerce_settlement_intents WHERE id=$1", [intent.settlement.id])).rows[0];
  return { orderId, clientId, capturedReference: settled.external_ref ?? settled.id, idempotencyKey: `activate:${key}` };
}

it("keeps the full admitted quantity and catalogue price when a promoted order splits effective positions", async () => {
  const p = await draftedPurchase("subscription", 1);
  expect((await runtime.query("SELECT quantity,unit_amount_minor::int FROM public.commerce_order_items WHERE order_id=$1 ORDER BY unit_amount_minor", [p.orderId])).rows)
    .toEqual([{ quantity: 1, unit_amount_minor: 99 }, { quantity: 1, unit_amount_minor: 100 }]);
  const f = await activate(p);
  expect(await accountLines(f)).toMatchObject([{ variantId: variant, qty: 2, sortOrder: 0, unitPrice: { amountMinor: 100, currency: "XXX" }, lineSubtotal: { amountMinor: 200, currency: "XXX" } }]);
  expect(await state(f.subscriptionId)).toMatchObject({ price_list_id: list, currency_code: "XXX" });
});

it.each(['public.subscription_renewal_purchase_facts(uuid)', 'pg_catalog.jsonb_array_elements(jsonb)',
  'pg_catalog.gen_random_uuid()', 'pg_catalog.now()'])("completes without materialization when EXECUTE on %s is unavailable", async signature => {
  const p = await purchase(), writer = api.createPostgresPurchaseRenewalWriter(executor);
  await writer.register(p.orderId, facts);
  const activation = await rpc<{ subscriptionId: string }>("subscription_activate_from_captured_payment", [p.idempotencyKey, p.orderId,
    createHash("sha256").update(p.capturedReference).digest("hex")]);
  const before = await state(activation.subscriptionId), grantee = signature.startsWith("pg_catalog.") ? "PUBLIC" : "service_role";
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await admin.query(`REVOKE EXECUTE ON FUNCTION ${signature} FROM ${grantee}`);
    expect((await runtime.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') AS executable,has_table_privilege(current_user,'public.subscription_lines','INSERT') AS insertable", [signature])).rows[0])
      .toEqual({ executable: false, insertable: true });
    expect(await writer.complete(p.orderId)).toMatchObject({ subscriptionId: activation.subscriptionId, replayed: false });
    expect(await state(activation.subscriptionId)).toEqual(before);
    expect(before).toMatchObject({ status: "active", price_list_id: null, currency_code: null });
    expect((await admin.query("SELECT 1 FROM public.subscription_lines WHERE subscription_id=$1", [activation.subscriptionId])).rows).toEqual([]);
    expect(log.mock.calls).toEqual([["subscription_template_unavailable", "privileges_unavailable"]]);
  } finally { await admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${grantee}`); }
});

it("matches the one-time sellable flag independently of the subscription flag", async () => {
  try {
    await admin.query("UPDATE public.catalog_skus SET sellable_in_subscription=false WHERE id=$1", [variant]);
    const allowed = await activate(await draftedPurchase("one_time"));
    expect(await state(allowed.subscriptionId)).toMatchObject({ price_list_id: list, currency_code: "XXX" });
    const p = await draftedPurchase("one_time");
    await admin.query("UPDATE public.catalog_skus SET sellable_standalone=false WHERE id=$1", [variant]);
    const log = vi.spyOn(console, "warn").mockImplementation(() => {}), refused = await activate(p);
    expect(await state(refused.subscriptionId)).toMatchObject({ price_list_id: null, currency_code: null });
    expect(await accountLines(refused)).toMatchObject([{ qty: 2, unitPrice: { amountMinor: 100 } }]);
    expect(log.mock.calls).toEqual([["subscription_price_list_unresolved", "missing"]]);
  } finally { await admin.query("UPDATE public.catalog_skus SET sellable_in_subscription=true,sellable_standalone=true WHERE id=$1", [variant]); }
});
