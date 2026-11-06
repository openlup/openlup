import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createPostgresAccountReadSources, createPostgresCustomerOrderHistoryReadStore } from "@openlup/platform/account-support";
import { api, purchase, admin, at, checkout, days, deps, executor, facts, fulfillment, identity, now, payments, destinations, rpc, runtime, runtimeUrl, transaction } from "./subscriptionPublicRenewalFixture.js";
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
async function activate(p: Awaited<ReturnType<typeof purchase>>, renewalTerms?: RenewalRetainedTerms, lines = facts.lines) {
  const result = await api.activateNativePurchaseWithRenewal(executor, { ...p, facts: { ...facts, lines, ...(renewalTerms ? { renewalTerms } : {}) } });
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
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const p = await purchase(), f = await activate(p), before = await state(f.subscriptionId);
  expect(log.mock.calls).toEqual([]);
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

async function prepared() {
  const p = await purchase();
  const writer = api.createPostgresPurchaseRenewalWriter(executor);
  await writer.register(p.orderId, facts);
  const activation = await rpc<{ subscriptionId: string }>("subscription_activate_from_captured_payment", [p.idempotencyKey, p.orderId,
    createHash("sha256").update(p.capturedReference).digest("hex")]);
  return { ...p, writer, subscriptionId: activation.subscriptionId };
}

it("keeps completion when a line constraint fails, then materializes once on replay", async () => {
  const f = await prepared(), before = await state(f.subscriptionId);
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  await admin.query("ALTER TABLE public.subscription_lines ADD CONSTRAINT synthetic_template_fault CHECK (quantity<>2) NOT VALID");
  try { expect(await f.writer.complete(f.orderId)).toEqual({ subscriptionId: f.subscriptionId, replayed: false }); }
  finally { await admin.query("ALTER TABLE public.subscription_lines DROP CONSTRAINT synthetic_template_fault"); }
  expect(await state(f.subscriptionId)).toEqual(before);
  expect((await runtime.query("SELECT 1 FROM public.subscription_renewal_terms WHERE subscription_id=$1", [f.subscriptionId])).rows).toHaveLength(1);
  expect(await f.writer.pending()).not.toContainEqual(expect.objectContaining({ orderId: f.orderId }));
  expect(log.mock.calls).toEqual([["subscription_template_unavailable", "23514"]]);
  expect(await f.writer.complete(f.orderId)).toEqual({ subscriptionId: f.subscriptionId, replayed: true });
  expect(await accountLines(f)).toMatchObject([{ qty: 2 }]);
  const completed = await allPublicRows(admin);
  expect(await f.writer.complete(f.orderId)).toEqual({ subscriptionId: f.subscriptionId, replayed: true });
  expect(await allPublicRows(admin)).toEqual(completed);
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

it("keeps completed service when price reads fail, then recovers the template on replay", async () => {
  const f = await prepared(), before = await state(f.subscriptionId);
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  await admin.query("REVOKE SELECT ON public.price_lists,public.price_entries FROM service_role");
  try {
    expect(await f.writer.complete(f.orderId)).toEqual({ subscriptionId: f.subscriptionId, replayed: false });
    expect(await accountLines(f)).toBeUndefined();
    expect(await state(f.subscriptionId)).toEqual(before);
    expect(await edit(f)).toMatchObject({ status: "refused", reason: "subscription_edit_invalid_request" });
    expect(log.mock.calls).toEqual([["subscription_template_unavailable", "42501"]]);
  } finally { await admin.query("GRANT SELECT ON public.price_lists,public.price_entries TO service_role"); }
  expect(await f.writer.complete(f.orderId)).toEqual({ subscriptionId: f.subscriptionId, replayed: true });
  expect(await accountLines(f)).toMatchObject([{ qty: 2 }]);
  const once = await allPublicRows(admin);
  expect(await f.writer.complete(f.orderId)).toMatchObject({ replayed: true });
  expect(await allPublicRows(admin)).toEqual(once);
});

it("retries an interruption after completion and keeps a later edit", async () => {
  const f = await prepared(), before = await state(f.subscriptionId);
  const interruption = new Error("synthetic_template_interruption");
  const failing = api.createPostgresPurchaseRenewalWriter({ query(sql, values) {
    if (sql.includes("SELECT sku.id AS variant_id")) throw interruption;
    return executor.query(sql, values);
  } });
  await expect(failing.complete(f.orderId)).rejects.toBe(interruption);
  expect(await accountLines(f)).toBeUndefined();
  expect(await f.writer.pending()).not.toContainEqual(expect.objectContaining({ orderId: f.orderId }));
  expect((await runtime.query("SELECT 1 FROM public.subscription_renewal_terms WHERE subscription_id=$1", [f.subscriptionId])).rows).toHaveLength(1);
  expect(await f.writer.complete(f.orderId)).toMatchObject({ replayed: true });
  expect(await accountLines(f)).toMatchObject([{ qty: 2 }]);
  expect(await edit(f)).toMatchObject({ status: "applied", templateVersion: 2 });
  const edited = await accountLines(f);
  expect(await f.writer.complete(f.orderId)).toMatchObject({ replayed: true });
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
  const queries: string[] = [], savepointErrors: unknown[] = [];
  const narrowed = api.createPostgresPurchaseRenewalWriter({ async query(sql, values) {
    queries.push(sql);
    try { return await executor.query(sql, values); }
    catch (error) {
      if (sql === "SAVEPOINT native_purchase_template") savepointErrors.push(error && typeof error === "object" && "code" in error ? error.code : undefined);
      throw error;
    }
  } });
  try {
    await admin.query("REVOKE UPDATE ON public.subscriptions FROM service_role; GRANT UPDATE(updated_at) ON public.subscriptions TO service_role");
    if (scope === "template") await admin.query(`
      REVOKE SELECT,INSERT ON public.subscription_lines FROM service_role;
      REVOKE SELECT ON public.subscription_activations,public.commerce_orders,public.subscriptions FROM service_role;
      GRANT SELECT(id,client_id,status,created_at,updated_at) ON public.commerce_orders TO service_role;
      GRANT SELECT(id,client_id,updated_at,cadence_days,template_version,currency_code,status,next_cycle_at) ON public.subscriptions TO service_role`);
    expect((await runtime.query("SELECT has_column_privilege(current_user,'public.subscriptions','price_list_id','UPDATE') AS allowed")).rows[0].allowed).toBe(false);
    expect(await narrowed.complete(p.orderId)).toMatchObject({ subscriptionId: id, replayed: false });
    expect(savepointErrors).toEqual(["25P01"]);
    expect(queries.filter(sql => sql.includes("SAVEPOINT"))).toEqual(["SAVEPOINT native_purchase_template"]);
    expect(await observe()).toEqual(before);
    expect(before).toMatchObject({ status: "active", price_list_id: null, currency_code: null });
    expect((await admin.query("SELECT 1 FROM public.subscription_lines WHERE subscription_id=$1", [id])).rows).toEqual([]);
    expect(log.mock.calls).toEqual([["subscription_template_unavailable", "42501"]]);
    const completed = await allPublicRows(admin);
    log.mockClear(); queries.length = 0; savepointErrors.length = 0;
    expect(await narrowed.complete(p.orderId)).toMatchObject({ subscriptionId: id, replayed: true });
    expect(await allPublicRows(admin)).toEqual(completed);
    expect(savepointErrors).toEqual(["25P01"]);
    expect(queries.filter(sql => sql.includes("SAVEPOINT"))).toEqual(["SAVEPOINT native_purchase_template"]);
    expect(log.mock.calls).toEqual([["subscription_template_unavailable", "42501"]]);
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
    expect(log.mock.calls).toEqual([["subscription_template_unavailable", "42501"]]);
  } finally {
    if (permission === "read") await admin.query("REVOKE SELECT(id,client_id,cadence_days,template_version,next_cycle_at,updated_at) ON public.subscriptions FROM service_role; GRANT SELECT ON public.subscriptions TO service_role");
    await admin.query("REVOKE UPDATE(cadence_days,template_version,updated_at) ON public.subscriptions FROM service_role; GRANT UPDATE ON public.subscriptions TO service_role");
  }
});


// Same definition/quote fixture shape as m19CheckoutShipping; order positions
// are produced by the public checkout writer, never inserted by this witness.
async function draftedPurchase(mode: "subscription" | "one_time", discount = 0,
  positions = [{ sku: "G7-REFILL", quantity: 2, unitPrice: 100 }]) {
  const accounts = identity.createPostgresAccountLinkStore({ connectionString: runtimeUrl });
  let clientId: string;
  try { clientId = (await accounts.createAccount({ email: `${randomUUID()}@example.invalid`, principalId: randomUUID(), acquisitionSource: "fixture", lifecycleStage: "customer" })).id; }
  finally { await accounts.close(); }
  const key = randomUUID(), promotionId = `promotion-${key}`, money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
  if (discount) await admin.query("INSERT INTO public.commerce_promotion_definitions(promotion_id,definition,active) VALUES($1,$2,true)", [promotionId, {
    id: promotionId, status: "active", name: "Configured benefit", code: null, trigger_type: "automatic", discount_type: "fixed_amount", discount_value: discount,
    applies_to_kind: "order_total", applies_to_payload: {}, stacking_rule: "exclusive", eligibility: {}, valid_from: "2020-01-01T00:00:00Z", valid_to: null,
    region_availability: ["ZZ"], redemption_limit_global: null, redemption_limit_per_customer: null }]);
  const subtotal = positions.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  const made = await checkout.createPostgresNativeCheckoutPersistence(executor).createOrderDraft({ idempotencyKey: key,
    quoteSnapshot: { contractVersion: "commerce.v0", quote: { currency: "XXX", taxIncluded: true,
      lines: positions.map(line => ({ sku: line.sku, productSlug: "g7-refill", quantity: line.quantity,
        unitPriceGross: money(line.unitPrice), lineSubtotalGross: money(line.unitPrice * line.quantity),
        tax: { included: true, country: "ZZ", category: "standard", vatRateBps: 0, legalBasis: "Synthetic test tax",
          netAmount: money(line.unitPrice * line.quantity), vatAmount: money(0), grossAmount: money(line.unitPrice * line.quantity) } })),
      discounts: discount ? [{ promotionId, appliesTo: "order_total", amountOffMinor: discount, reasonCode: "configured" }] : [],
      context: { mode, cadenceDays: 28, promoCodes: [] }, subtotalGross: money(subtotal), discountTotalGross: money(discount),
      shippingGross: money(0), shippingDiscountGross: money(0), totalGross: money(subtotal - discount), netTotal: money(subtotal - discount), taxTotal: money(0) } } }, { clientId });
  const orderId = String(made.orderDraft.orderId).replace(/^order_/, "");
  const intent = await rpc<{ settlement: { id: string } }>("commerce_open_settlement_intent", [`open:${key}`, orderId, "sandbox", subtotal - discount, "XXX", "{}", at]);
  expect(await captureSandboxPurchase(payments.createPostgresSandboxPaymentSimulator(executor,
    { dunningTemplateSlug: "failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" }),
    { settlementIntentId: intent.settlement.id, key, at })).toMatchObject({ status: 200 });
  await destinations.createPostgresDestinationPort(executor).registerOrder({ idempotencyKey: `destination:${key}`, orderId,
    address: { recipientName: "Synthetic recipient", line1: "Synthetic street 1", city: "Fixture", postalCode: "00000", country: "ZZ" }, now: at });
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

it.each(['public.subscription_renewal_purchase_terms(uuid)', 'pg_catalog.jsonb_extract_path(jsonb,text[])',
  'pg_catalog.jsonb_extract_path_text(jsonb,text[])', 'pg_catalog.jsonb_array_elements(jsonb)',
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
    expect(log.mock.calls).toEqual([["subscription_template_unavailable", "42501"]]);
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


it("aggregates repeated admitted SKUs at one price without losing quantity or using the aggregated tier for resolution", async () => {
  const p = await draftedPurchase("subscription", 0, [
    { sku: "G7-REFILL", quantity: 1, unitPrice: 100 }, { sku: "G7-REFILL", quantity: 2, unitPrice: 100 }]);
  // A tier that would apply to the SUM must not replace either original admission line's price.
  const tier = randomUUID();
  await admin.query("INSERT INTO public.price_entries(id,price_list_id,variant_id,mode,min_qty,unit_price_minor,valid_from) VALUES($1,$2,$3,'any',3,90,'2026-01-01')", [tier, list, variant]);
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const f = await activate(p, undefined, [{ ...facts.lines[0], quantity: 3 }]);
    expect(await accountLines(f)).toMatchObject([{ variantId: variant, qty: 3, sortOrder: 0, unitPrice: { amountMinor: 100 } }]);
    expect(await accountLines(f)).toHaveLength(1);
    expect(await state(f.subscriptionId)).toMatchObject({ price_list_id: list, currency_code: "XXX" });
    expect(log.mock.calls).toEqual([]);
  } finally { await admin.query("DELETE FROM public.price_entries WHERE id=$1", [tier]); }
});

it("skips the entire template and pair for different admitted prices of the same SKU", async () => {
  const tier = randomUUID();
  await admin.query("INSERT INTO public.price_entries(id,price_list_id,variant_id,mode,min_qty,unit_price_minor,valid_from) VALUES($1,$2,$3,'any',2,90,'2026-01-01')", [tier, list, variant]);
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const p = await draftedPurchase("subscription", 0, [
      { sku: "G7-REFILL", quantity: 1, unitPrice: 100 }, { sku: "G7-REFILL", quantity: 2, unitPrice: 90 }]);
    const f = await activate(p, undefined, [{ ...facts.lines[0], quantity: 3 }]);
    expect(await accountLines(f)).toBeUndefined();
    expect(await state(f.subscriptionId)).toMatchObject({ status: "active", price_list_id: null, currency_code: null });
    expect(await api.createPostgresPurchaseRenewalWriter(executor).pending()).not.toContainEqual(expect.objectContaining({ orderId: p.orderId }));
    expect(log.mock.calls).toEqual([["subscription_template_unavailable", "ambiguous_line_price"]]);
  } finally { await admin.query("DELETE FROM public.price_entries WHERE id=$1", [tier]); }
});

it("keeps completion and its due anchor when a summed admitted quantity exceeds the template limit", async () => {
  const p = await draftedPurchase("subscription", 0, [
    { sku: "G7-REFILL", quantity: 50, unitPrice: 100 }, { sku: "G7-REFILL", quantity: 50, unitPrice: 100 }]);
  const writer = api.createPostgresPurchaseRenewalWriter(executor);
  await writer.register(p.orderId, { ...facts, lines: [{ ...facts.lines[0], quantity: 100 }] });
  const activation = await rpc<{ subscriptionId: string }>("subscription_activate_from_captured_payment", [p.idempotencyKey, p.orderId,
    createHash("sha256").update(p.capturedReference).digest("hex")]);
  const f = { ...p, subscriptionId: activation.subscriptionId }, before = await state(f.subscriptionId);
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await writer.complete(p.orderId)).toMatchObject({ replayed: false });
  expect(await state(f.subscriptionId)).toEqual(before);
  expect(await accountLines(f)).toBeUndefined();
  expect(before).toMatchObject({ status: "active", price_list_id: null, currency_code: null });
  expect(log.mock.calls).toEqual([["subscription_template_unavailable", "23514"]]);
  expect(await writer.pending()).not.toContainEqual(expect.objectContaining({ orderId: p.orderId }));
});

it.each(["40001", "40P01", "57014", "08006", "53100", "XX000"])("propagates %s from the template unit after completing the attachment", async code => {
  const f = await prepared(), failure = Object.assign(new Error("synthetic failure"), { code });
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const writer = api.createPostgresPurchaseRenewalWriter({ query(sql, values) {
    if (sql.includes("SELECT sku.id AS variant_id")) throw failure;
    return executor.query(sql, values);
  } });
  await expect(writer.complete(f.orderId)).rejects.toBe(failure);
  expect(await f.writer.pending()).not.toContainEqual(expect.objectContaining({ orderId: f.orderId }));
  expect(await accountLines(f)).toBeUndefined();
  expect(log.mock.calls).toEqual([]);
});

it("rolls back a swallowed data error to a savepoint on a caller-bound transaction", async () => {
  const f = await prepared(), log = vi.spyOn(console, "warn").mockImplementation(() => {}), queries: string[] = [];
  await transaction(async db => {
    const writer = api.createPostgresPurchaseRenewalWriter({ query(sql, values) {
      queries.push(sql);
      return sql.includes("WITH locked AS MATERIALIZED") ? db.query("SELECT 1/0") : db.query(sql, values);
    } });
    expect(await writer.complete(f.orderId)).toEqual({ subscriptionId: f.subscriptionId, replayed: false });
    expect((await db.query("SELECT 1 AS usable")).rows).toEqual([{ usable: 1 }]);
    expect((await db.query("SELECT public.subscription_renewal_purchase_terms($1::uuid) AS facts", [f.subscriptionId])).rows[0].facts).not.toBeNull();
  });
  expect(queries).toContain("SAVEPOINT native_purchase_template");
  expect(queries).toContain("ROLLBACK TO SAVEPOINT native_purchase_template");
  expect(queries).toContain("RELEASE SAVEPOINT native_purchase_template");
  expect(log.mock.calls).toEqual([["subscription_template_unavailable", "22012"]]);
  expect(await accountLines(f)).toBeUndefined();
  expect(await f.writer.complete(f.orderId)).toMatchObject({ replayed: true });
  expect(await accountLines(f)).toMatchObject([{ qty: 2 }]);
});


it("keeps a retained acquisition add-on at attach and matches graduation from an absent template", async () => {
  const addon = "44444444-4444-4444-8444-444444444444";
  await admin.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,'synthetic-addon','Addon')", [addon]);
  // Catalogue role deliberately differs; the retained purchase price role is authoritative.
  await admin.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,is_addon,sellable_in_subscription) VALUES($1,$1,'SYNTHETIC-ADDON','Addon',false,true)", [addon]);
  await admin.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,'any',40,'2026-01-01')", [list, addon]);
  await fulfillment.createPostgresFulfillmentStockSyncPort(executor, { sourceKey: facts.stockSourceKey, readLocalInventoryStock: async () => [] })
    .recordProviderStockCurrent({ requestKey: `addon-stock:${randomUUID()}`, snapshot: { providerRef: "synthetic-addon", collectedAt: at,
      sourceRevision: null, revisionSource: "collection", quantityKind: "snapshot", skuRef: "SYNTHETIC-ADDON", totalQuantity: 1000,
      forSaleQuantity: 1000, reservedOrUnavailableQuantity: 0, syncRunId: "addon-fixture" }, inventoryClass: "sellable", lastSyncedAt: at, staleAfter: "2027-01-01T00:00:00Z" });
  const retained = retainedTerms();
  retained.linePricing = [{ sku: "G7-REFILL", quantity: 2, unitAmountMinor: 100, isAddon: false, quoteLine: {} },
    { sku: "SYNTHETIC-ADDON", quantity: 1, unitAmountMinor: 40, isAddon: true, quoteLine: {} }];
  retained.starterPack!.delivery2.basisSubtotalMinor = 240;
  const results: unknown[] = [];
  for (const materialized of [true, false]) {
    const p = await draftedPurchase("subscription", 0, [{ sku: "G7-REFILL", quantity: 2, unitPrice: 100 },
      { sku: "SYNTHETIC-ADDON", quantity: 1, unitPrice: 40 }]);
    const bound = materialized ? executor : { query(sql: string, values?: unknown[]) {
      if (sql.includes("SELECT sku.id AS variant_id")) throw Object.assign(new Error("synthetic access denial"), { code: "42501" });
      return executor.query(sql, values);
    } };
    const attached = await api.activateNativePurchaseWithRenewal(bound, { ...p, facts: { ...facts, renewalTerms: retained,
      lines: [...facts.lines, { lineOrdinal: 2, sku: "SYNTHETIC-ADDON", quantity: 1, unitAmountMinor: 40 }] } });
    expect(attached.renewalAttachment).toBe("complete");
    const f = { ...p, subscriptionId: String(attached.activation.subscriptionId) };
    expect(await accountLines(f)).toEqual(materialized ? expect.arrayContaining([expect.objectContaining({ variantId: addon, isAddon: true })]) : undefined);
    const d = await deps(f.subscriptionId, "succeeded", now);
    d.input.store = api.createPostgresRenewalStore(executor, d.codec, transaction);
    d.input.settlement = api.createPostgresRenewalSettlementPort(executor, d.codec, transaction);
    expect(await api.runOneAutomaticSubscriptionRenewal(d.input, d.due, now)).toMatchObject({ status: "succeeded" });
    const before = await state(f.subscriptionId), nextAt = new Date(String(before.next_cycle_at)).toISOString();
    const snapshot = await d.input.store.buildCycleSnapshots({ subscriptionId: f.subscriptionId, scheduledAt: nextAt, scheduledInstant: Date.parse(nextAt) });
    expect(await state(f.subscriptionId)).toMatchObject({ next_cycle_at: before.next_cycle_at, status: "active" });
    const lines = (await runtime.query("SELECT k.sku,l.quantity,l.is_addon FROM public.subscription_lines l JOIN public.catalog_skus k ON k.id=l.variant_id WHERE subscription_id=$1 ORDER BY l.sort_order", [f.subscriptionId])).rows;
    expect(lines).toEqual([{ sku: "G7-REFILL", quantity: 3, is_addon: false }, { sku: "SYNTHETIC-ADDON", quantity: 1, is_addon: true }]);
    results.push({ template: snapshot.templateSnapshot, pricing: snapshot.pricingSnapshot, lines });
  }
  expect(results[0]).toEqual(results[1]);
});


it("completes without any auxiliary function query before the protected work", async () => {
  const f = await prepared(), queries: string[] = [], log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const writer = api.createPostgresPurchaseRenewalWriter({ query(sql, values) {
    queries.push(sql);
    if (sql === "SELECT public.subscription_complete_renewal_attachment($1::uuid) AS response"
      || sql === "SAVEPOINT native_purchase_template" || sql.startsWith("SELECT sku.id AS variant_id")
      || sql.startsWith("SELECT list.id,list.currency") || sql.startsWith("WITH locked AS MATERIALIZED")) return executor.query(sql, values);
    throw Object.assign(new Error("synthetic auxiliary function denial"), { code: "42501" });
  } });
  expect(await writer.complete(f.orderId)).toEqual({ subscriptionId: f.subscriptionId, replayed: false });
  expect(queries.slice(0, 2)).toEqual(["SELECT public.subscription_complete_renewal_attachment($1::uuid) AS response", "SAVEPOINT native_purchase_template"]);
  expect(await accountLines(f)).toMatchObject([{ qty: 2 }]);
  expect(await state(f.subscriptionId)).toMatchObject({ price_list_id: list, currency_code: "XXX" });
  expect(log.mock.calls).toEqual([]);
});

it("propagates a savepoint error other than no active transaction without running template work", async () => {
  const f = await prepared(), queries: string[] = [], failure = Object.assign(new Error("synthetic savepoint failure"), { code: "42501" });
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const writer = api.createPostgresPurchaseRenewalWriter({ query(sql, values) {
    queries.push(sql);
    if (sql === "SAVEPOINT native_purchase_template") throw failure;
    return executor.query(sql, values);
  } });
  await expect(writer.complete(f.orderId)).rejects.toBe(failure);
  expect(queries).toEqual(["SELECT public.subscription_complete_renewal_attachment($1::uuid) AS response", "SAVEPOINT native_purchase_template"]);
  expect(log.mock.calls).toEqual([]);
});
