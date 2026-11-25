import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPostgresAccountReadSources, createPostgresCustomerOrderHistoryReadStore } from "@openlup/platform/account-support";
import type { CatalogFactsProvenance } from "@openlup/platform/pricing/contracts";
import { api, purchase, admin, at, checkout, days, deps, executor, facts, fulfillment, identity, now, payments, destinations, rpc, runtime, runtimeUrl, transaction } from "./subscriptionPublicRenewalFixture.js";
import { createPostgresCustomerSubscriptionControlPort } from "../../server/adapters/postgres/customerSubscriptionControl.js";
import { PLATFORM_DEFAULT_CURRENCY } from "../../src/lib/currency/settlementProfile.js";
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
async function edit(f: Pick<Awaited<ReturnType<typeof activate>>, "clientId" | "subscriptionId">,
  variantId = variant, editNow = days(at, 1)) {
  const store = api.createPostgresSubscriptionCommandStore({ withTransaction: transaction });
  const input = { actorId: randomUUID(), clientId: f.clientId, subscriptionId: f.subscriptionId,
    idempotencyKey: randomUUID(), action: "resize_bundle", now: editNow,
    payload: { expectedTemplateVersion: 1, cadenceDays: 28, coreLines: [{ variantId, qty: 3 }], compositionConstraint: { kind: "units", value: 3 } } };
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
type PurchasePosition = { sku: string; quantity: number; unitPrice: number; catalogFacts?: CatalogFactsProvenance };
async function draftedPurchase(mode: "subscription" | "one_time", discount = 0,
  positions: PurchasePosition[] = [{ sku: "G7-REFILL", quantity: 2, unitPrice: 100 }],
  purchaseClock = async () => at) {
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
        ...(line.catalogFacts ? { catalogFacts: line.catalogFacts } : {}),
        tax: { included: true, country: "ZZ", category: "standard", vatRateBps: 0, legalBasis: "Synthetic test tax",
          netAmount: money(line.unitPrice * line.quantity), vatAmount: money(0), grossAmount: money(line.unitPrice * line.quantity) } })),
      discounts: discount ? [{ promotionId, appliesTo: "order_total", amountOffMinor: discount, reasonCode: "configured" }] : [],
      context: { mode, cadenceDays: 28, promoCodes: [] }, subtotalGross: money(subtotal), discountTotalGross: money(discount),
      shippingGross: money(0), shippingDiscountGross: money(0), totalGross: money(subtotal - discount), netTotal: money(subtotal - discount), taxTotal: money(0) } } }, { clientId });
  const orderId = String(made.orderDraft.orderId).replace(/^order_/, "");
  const purchaseAt = await purchaseClock();
  const intent = await rpc<{ settlement: { id: string } }>("commerce_open_settlement_intent", [`open:${key}`, orderId, "sandbox", subtotal - discount, "XXX", "{}", purchaseAt]);
  expect(await captureSandboxPurchase(payments.createPostgresSandboxPaymentSimulator(executor,
    { dunningTemplateSlug: "failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" }),
    { settlementIntentId: intent.settlement.id, key, at: purchaseAt })).toMatchObject({ status: 200 });
  await destinations.createPostgresDestinationPort(executor).registerOrder({ idempotencyKey: `destination:${key}`, orderId,
    address: { recipientName: "Synthetic recipient", line1: "Synthetic street 1", city: "Fixture", postalCode: "00000", country: "ZZ" }, now: purchaseAt });
  await rpc("subscription_declare_provisional_activation", [`declare:${key}`, orderId, 28, purchaseAt]);
  const settled = (await runtime.query("SELECT external_ref,id FROM public.commerce_settlement_intents WHERE id=$1", [intent.settlement.id])).rows[0];
  return { orderId, clientId, capturedReference: settled.external_ref ?? settled.id, idempotencyKey: `activate:${key}`, purchaseAt };
}

describe("derived renewal price context in PostgreSQL", () => {
  const skuId = randomUUID(), sku = "SYNTHETIC-DERIVED-REFILL";
  const storedId = randomUUID(), storedSku = "SYNTHETIC-STORED-REFILL";
  const base = 125, derived = 110;
  let baseId: string, policy: { id: string; digest: string };
  const clock = async () => (await admin.query<{ at: Date }>("SELECT clock_timestamp() AS at")).rows[0]!.at.toISOString();

  async function recordStock(skuRef: string) {
    const { collected, stale } = (await admin.query<{ collected: Date; stale: Date }>(
      "SELECT now() AS collected,now()+interval '90 days' AS stale")).rows[0]!;
    const stock = fulfillment.createPostgresFulfillmentStockSyncPort(executor, { sourceKey: facts.stockSourceKey, readLocalInventoryStock: async () => [] });
    await stock.recordProviderStockCurrent({ requestKey: `derived-stock:${skuRef}`, snapshot: { providerRef: "sandbox-stock",
      collectedAt: collected.toISOString(), sourceRevision: null, revisionSource: "collection", quantityKind: "snapshot", skuRef,
      totalQuantity: 1000, forSaleQuantity: 1000, reservedOrUnavailableQuantity: 0, syncRunId: "derived-renewal" },
    inventoryClass: "sellable", lastSyncedAt: collected.toISOString(), staleAfter: stale.toISOString() });
  }

  async function newDerivedPurchase(editPrice?: number) {
    const id = randomUUID(), code = `Example-${id}`, quantity = 1;
    await admin.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription)
      SELECT $2,product_id,$3,'Refill',true FROM public.catalog_skus WHERE id=$1`, [variant, id, code]);
    const { id: entryId } = (await admin.query<{ id: string }>(`INSERT INTO public.price_entries
      (price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,'one_time',$3,now()) RETURNING id`,
    [list, id, base])).rows[0]!;
    if (editPrice !== undefined) await admin.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
      VALUES($1,$2,'subscription',$3,now())`, [list, id, editPrice]);
    await recordStock(code);
    const p = await draftedPurchase("subscription", 0, [{ sku: code, quantity, unitPrice: derived, catalogFacts: {
      version: "catalog_facts_v2", skuId: id, documentRevisionId: randomUUID(), documentDigest: "a".repeat(64),
      basePriceEntryId: entryId, baseUnitAmountMinor: base, policyRevisionId: policy.id, policyDigest: policy.digest,
      resolvedUnitAmountMinor: derived, resolvedLineAmountMinor: derived * quantity, currency: "XXX", mode: "subscription", atTime: await clock(),
    } }], clock);
    return { p, id, code, entryId, lines: [{ lineOrdinal: 1, sku: code, quantity, unitAmountMinor: derived }] };
  }

  async function replaceBase(id: string, entryId: string) {
    const db = await admin.connect();
    try {
      await db.query("BEGIN");
      const { cutoff } = (await db.query<{ cutoff: string }>("SELECT clock_timestamp()::text AS cutoff")).rows[0]!;
      await db.query("UPDATE public.price_entries SET active=false,valid_to=$2,updated_at=$2 WHERE id=$1", [entryId, cutoff]);
      await db.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
        VALUES($1,$2,'one_time',230,$3)`, [list, id, cutoff]);
      await db.query("COMMIT");
      return cutoff;
    } catch (error) { await db.query("ROLLBACK"); throw error; }
    finally { db.release(); }
  }

  async function waitForCutoff(cutoff: string) {
    await expect.poll(async () => {
      const { rows: [check] } = await admin.query(`SELECT date_trunc('milliseconds',clock_timestamp()) >= $1::timestamptz AS ready,
        clock_timestamp()::text AS observed`, [cutoff]);
      return check.ready ? "ready" : `cutoff ${cutoff}, database clock ${check.observed}`;
    }, { interval: 5, timeout: 1000 }).toBe("ready");
  }

  beforeAll(async () => {
    await admin.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription)
      SELECT position.id,k.product_id,position.sku,'Refill',true FROM public.catalog_skus k
      CROSS JOIN (VALUES ($2::uuid,$3::text),($4::uuid,$5::text)) position(id,sku) WHERE k.id=$1`, [variant, skuId, sku, storedId, storedSku]);
    baseId = (await admin.query<{ id: string }>(`INSERT INTO public.price_entries
      (price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,'one_time',$3,now()) RETURNING id`,
      [list, skuId, base])).rows[0]!.id;
    await admin.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
      VALUES($1,$2,'subscription',100,now())`, [list, storedId]);
    policy = (await admin.query<{ id: string; digest: string }>(`WITH revision AS (SELECT gen_random_uuid() AS id,now() AS starts)
      INSERT INTO public.subscription_price_policy_revisions
        (id,price_list_id,region_code,currency,channel,revision_no,discount_bps,rounding_quantum_minor,rounding_rule,effective_from,digest)
      SELECT r.id,l.id,l.region_code,l.currency,'D2C',1,500,10,'FLOOR_TO_QUANTUM',r.starts,
        public.catalog_price_setup_policy_digest(r.id,1,l.id,l.region_code,l.currency,'D2C',r.starts,NULL,500,10,'FLOOR_TO_QUANTUM')
      FROM revision r JOIN public.price_lists l ON l.id=$1 RETURNING id,digest`, [list])).rows[0]!;
    for (const skuRef of [storedSku, sku]) await recordStock(skuRef);
  });

  type EditLine = { variantId: string; qty: number };
  type EditFixture = Awaited<ReturnType<typeof editFixture>>;
  async function editFixture() {
    const f = await activate(await draftedPurchase("subscription", 0, [{ sku: storedSku, quantity: 2, unitPrice: 100 }], clock),
      undefined, [{ lineOrdinal: 1, sku: storedSku, quantity: 2, unitAmountMinor: 100 }]);
    const principal = (await admin.query("SELECT principal_id FROM public.clients WHERE id=$1", [f.clientId])).rows[0].principal_id;
    return { ...f, principal, commandActor: randomUUID() };
  }

  async function editSku(priceList = list, base?: number, id: string = randomUUID()) {
    const code = `Example-${id}`;
    await admin.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription)
      SELECT $2,product_id,$3,'Refill',true FROM public.catalog_skus WHERE id=$1`, [variant, id, code]);
    const entry = base === undefined ? undefined : (await admin.query(`INSERT INTO public.price_entries
      (price_list_id,variant_id,mode,unit_price_minor) VALUES($1,$2,'one_time',$3) RETURNING id`, [priceList, id, base])).rows[0].id;
    return { id, code, entry };
  }

  async function editList(region: string, currency = "XXX", discount = 500, quantum = 10) {
    const id = randomUUID();
    extraLists.push(id);
    await admin.query("INSERT INTO public.price_lists(id,name,region_code,currency) VALUES($1,'Fixture',$2,$3)", [id, region, currency]);
    await admin.query(`WITH revision AS (SELECT gen_random_uuid() AS id,now() AS starts)
      INSERT INTO public.subscription_price_policy_revisions
        (id,price_list_id,region_code,currency,channel,revision_no,discount_bps,rounding_quantum_minor,rounding_rule,effective_from,digest)
      SELECT r.id,l.id,l.region_code,l.currency,'D2C',1,$2,$3,'FLOOR_TO_QUANTUM',r.starts,
        public.catalog_price_setup_policy_digest(r.id,1,l.id,l.region_code,l.currency,'D2C',r.starts,NULL,$2,$3,'FLOOR_TO_QUANTUM')
      FROM revision r JOIN public.price_lists l ON l.id=$1`, [id, discount, quantum]);
    return id;
  }

  async function asEditActor<T>(f: EditFixture, run: (db: PoolClient) => Promise<T>) {
    const db = await admin.connect();
    try {
      await db.query("BEGIN");
      await db.query("SET LOCAL ROLE authenticated");
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.principal, role: "authenticated" })]);
      const answer = await run(db);
      await db.query("COMMIT");
      return answer;
    } catch (error) { await db.query("ROLLBACK"); throw error; }
    finally { db.release(); }
  }

  function request(f: EditFixture, core: EditLine[], addons: EditLine[] = [], key = randomUUID()) {
    const actorParams = [f.subscriptionId, key, JSON.stringify(core), JSON.stringify(addons), "{}", 28, 1];
    const payload = { expectedTemplateVersion: 1, cadenceDays: 28, coreLines: core, addonLines: addons, compositionConstraint: {} };
    return {
      key,
      actorPreview: () => asEditActor(f, async db => (await db.query(`SELECT
        public.customer_subscription_preview_bundle_as_actor($1,$2,$3,$4,$5,$6,$7)->'preview' AS result`, actorParams)).rows[0].result),
      actorApply: (hash: string) => asEditActor(f, async db => (await db.query(`SELECT
        public.customer_subscription_apply_bundle_as_actor($1,$2,$3,$4,$5,$6,$7,$8)->'subscriptionAction' AS result`,
      [...actorParams.slice(0, 2), hash, ...actorParams.slice(2)])).rows[0].result),
      commandPreview: async () => (await runtime.query(`SELECT
        public.subscription_command_preview($1,$2,$3,$4,'update_package_template',$5,$6) AS result`,
      [f.commandActor, f.clientId, key, f.subscriptionId, payload, await clock()])).rows[0].result,
      commandApply: async (hash: string) => rpc("subscription_command_apply", [f.commandActor, f.clientId, key, f.subscriptionId,
        "update_package_template", { ...payload, acceptedQuoteHash: hash }, await clock()]),
    };
  }

  async function editRows(f: EditFixture) {
    const { rows: [row] } = await admin.query(`SELECT s.next_cycle_at::text AS anchor,s.template_version AS version,
      (SELECT to_jsonb(t) FROM public.subscription_renewal_terms t WHERE t.subscription_id=s.id) AS header,
      ARRAY(SELECT to_jsonb(l) FROM public.subscription_renewal_term_lines l WHERE l.subscription_id=s.id ORDER BY line_ordinal) AS terms,
      ARRAY(SELECT to_jsonb(l) FROM public.subscription_lines l WHERE l.subscription_id=s.id ORDER BY sort_order) AS template,
      ARRAY(SELECT to_jsonb(q) FROM public.subscription_edit_quotes q WHERE q.subscription_id=s.id ORDER BY id) AS quotes,
      ARRAY(SELECT to_jsonb(e) FROM public.subscription_events e WHERE e.subscription_id=s.id ORDER BY id) AS events
      FROM public.subscriptions s WHERE id=$1`, [f.subscriptionId]);
    return row;
  }

  async function setContext(f: EditFixture, priceList: string, currency: string) {
    await admin.query("UPDATE public.subscriptions SET price_list_id=$2,currency_code=$3 WHERE id=$1", [f.subscriptionId, priceList, currency]);
    await admin.query("UPDATE public.subscription_renewal_terms SET currency_code=$2 WHERE subscription_id=$1", [f.subscriptionId, currency]);
  }

  async function renewalSnapshot(f: EditFixture) {
    const { rows: [schedule] } = await admin.query(`SELECT to_char(next_cycle_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM public.subscriptions WHERE id=$1`, [f.subscriptionId]);
    const store = api.createPostgresRenewalStore(executor, api.createNativeRenewalCodec(), transaction);
    const snapshot = await store.buildCycleSnapshots({ subscriptionId: f.subscriptionId, scheduledAt: schedule.at, scheduledInstant: Date.parse(schedule.at) });
    return { snapshot, claim: () => store.claimDue({ snapshot, workerId: "fixture-renewal", now: schedule.at }) };
  }

  const catalogRefusal = { code: "22023", message: "subscription_edit_catalog_unavailable" };
  const contextRefusal = { code: "22023", message: "subscription_edit_price_context_missing" };
  const commandCatalogRefusal = { status: "refused", canApply: false, reason: catalogRefusal.message };
  const money = (amountMinor: number, currency = "XXX") => ({ amountMinor, currency });

  it("prices mixed bundle lines independently and scopes derivation to the subscription context", async () => {
    const otherList = await editList("ZY");
    const other = await editSku(otherList, 125);
    const mixed = [{ variantId: storedId, qty: 3 }], addons = [{ variantId: skuId, qty: 2 }];
    const expected = [
      { variantId: storedId, quantity: 3, unitPriceMinor: 100, sortOrder: 0, currency: "XXX", isAddon: false },
      { variantId: skuId, quantity: 2, unitPriceMinor: 110, sortOrder: 1, currency: "XXX", isAddon: true },
    ];
    for (const path of ["actor", "command"] as const) {
      const f = await editFixture(), edit = request(f, mixed, addons);
      const absent = request(f, [{ variantId: other.id, qty: 2 }]);
      const wrongCurrency = request(f, [{ variantId: skuId, qty: 2 }]);
      if (path === "actor") await expect(absent.actorPreview()).rejects.toMatchObject(catalogRefusal);
      else expect(await absent.commandPreview()).toEqual(commandCatalogRefusal);
      await setContext(f, otherList, "XXX");
      const rightList = request(f, [{ variantId: other.id, qty: 2 }]);
      if (path === "actor") expect(await rightList.actorPreview()).toMatchObject({ canApply: true, newTotal: money(220) });
      else expect(await rightList.commandPreview()).toMatchObject({ canApply: true, newTotalMinor: 220 });
      await setContext(f, list, "XYY");
      if (path === "actor") await expect(wrongCurrency.actorPreview()).rejects.toMatchObject(catalogRefusal);
      else expect(await wrongCurrency.commandPreview()).toEqual(commandCatalogRefusal);
      await setContext(f, list, "XXX");
      const preview = path === "actor" ? await edit.actorPreview() : await edit.commandPreview();
      expect(preview).toMatchObject(path === "actor" ? { canApply: true, newTotal: money(520) }
        : { canApply: true, newTotalMinor: 520, lines: expected });
      const result = path === "actor" ? await edit.actorApply(preview.quoteHash) : await edit.commandApply(preview.quoteHash);
      expect(result).toMatchObject({ status: "applied", templateVersion: 2 });
      const saved = await editRows(f);
      expect(saved.quotes).toContainEqual(expect.objectContaining({ status: "accepted", proposed_lines: expected }));
      expect(saved.template).toMatchObject(expected.map(line => ({ variant_id: line.variantId, quantity: line.quantity,
        unit_price_minor: line.unitPriceMinor, currency_code: line.currency, sort_order: line.sortOrder, is_addon: line.isAddon })));
      expect(saved.terms).toMatchObject([{ line_ordinal: 1, sku: storedSku, quantity: 3, unit_amount_minor: 100 },
        { line_ordinal: 2, sku, quantity: 2, unit_amount_minor: 110 }]);
      expect(saved.header.currency_code).toBe("XXX");
    }
  });

  it("ranks stored entries and keeps actor renewals payable", async () => {
    const ranked = await editSku(list, 125);
    const ids = Array.from({ length: 6 }, () => randomUUID()).sort();
    await admin.query(`INSERT INTO public.price_entries(id,price_list_id,variant_id,mode,min_qty,unit_price_minor,valid_from)
      VALUES ($3,$1,$2,'subscription',3,11,now()-interval '1 hour'),
        ($4,$1,$2,'subscription',3,0,now()-interval '1 hour'),
        ($5,$1,$2,'subscription',3,22,now()-interval '2 hours'),
        ($6,$1,$2,'subscription',1,33,now()-interval '1 minute'),
        ($7,$1,$2,'subscription',4,44,now()-interval '1 minute'),
        ($8,$1,$2,'any',3,55,now()-interval '1 minute')`, [list, ranked.id, ids[2], ids[1], ids[0], ...ids.slice(3)]);
    const f = await editFixture(), core = [{ variantId: ranked.id, qty: 3 }], addons = [{ variantId: skuId, qty: 1 }];
    const q = request(f, core, addons);
    const command = await q.commandPreview();
    expect(command).toMatchObject({ canApply: true, newTotalMinor: 110, lines: [{ unitPriceMinor: 0 }, { unitPriceMinor: 110 }] });
    const actor = request(f, core, addons);
    const preview = await actor.actorPreview();
    expect(preview).toMatchObject({ canApply: true, newTotal: money(110) });
    const payable = await editFixture(), initial = await renewalSnapshot(payable), before = await editRows(payable);
    expect(initial.snapshot.pricingSnapshot).toMatchObject({ totalAmountMinor: 200, shippingAmountMinor: 0, currency: "XXX" });
    await expect(request(payable, core).actorPreview()).rejects.toMatchObject(catalogRefusal);
    expect(await editRows(payable)).toEqual(before);
    const original = await renewalSnapshot(payable);
    expect(original.snapshot).toEqual(initial.snapshot);
    await original.claim();
    expect((await editRows(payable)).anchor).toBe(before.anchor);
    expect(await actor.actorApply(preview.quoteHash)).toMatchObject({ status: "applied" });
    const persisted = await editRows(f);
    expect(persisted.quotes).toContainEqual(expect.objectContaining({ status: "accepted",
      proposed_lines: [expect.objectContaining({ unitPriceMinor: 0 }), expect.objectContaining({ unitPriceMinor: 110 })] }));
    expect(persisted.template).toMatchObject([{ variant_id: ranked.id, unit_price_minor: 0 }, { unit_price_minor: 110 }]);
    expect(persisted.terms).toMatchObject([{ sku: ranked.code, unit_amount_minor: 0 }, { unit_amount_minor: 110 }]);
    const mixed = await renewalSnapshot(f);
    expect(mixed.snapshot).toMatchObject({ templateSnapshot: { lines: [{ sku: ranked.code, unitAmountMinor: 0 }, { sku, unitAmountMinor: 110 }] },
      pricingSnapshot: { totalAmountMinor: 110, currency: "XXX" } });
    await mixed.claim();
    for (const [fixture, snapshot] of [[payable, original.snapshot], [f, mixed.snapshot]] as const) {
      const { rows: [operation] } = await admin.query(`SELECT scheduled_at=(SELECT next_cycle_at FROM public.subscriptions WHERE id=$1) AS same_schedule,
        cycle_snapshot FROM public.subscription_renewal_operations WHERE subscription_id=$1`, [fixture.subscriptionId]);
      expect(operation).toMatchObject({ same_schedule: true, cycle_snapshot: { templateSnapshot: snapshot.templateSnapshot,
        pricingSnapshot: snapshot.pricingSnapshot, scheduledAt: snapshot.scheduledAt } });
    }
    await admin.query("UPDATE public.price_entries SET active=false WHERE variant_id=$1 AND mode='subscription'", [ranked.id]);
    const fallback = request(await editFixture(), core, addons);
    expect(await fallback.actorPreview()).toMatchObject({ canApply: true, newTotal: money(275) });
    expect(await fallback.commandPreview()).toMatchObject({ canApply: true, newTotalMinor: 275, lines: [{ unitPriceMinor: 55 }, { unitPriceMinor: 110 }] });
  });

  it.each(["derived-only", "legacy stored"] as const)("keeps the saved quote and refuses a deleted %s SKU", async source => {
    const f = await editFixture(), priceList = await editList("ZY", PLATFORM_DEFAULT_CURRENCY);
    const subject = await editSku(priceList, source === "derived-only" ? 125 : undefined);
    await setContext(f, priceList, PLATFORM_DEFAULT_CURRENCY);
    if (source === "legacy stored") {
      await admin.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor)
        VALUES($1,$2,'subscription',150)`, [priceList, subject.id]);
    }
    const coreLines = [{ variantId: subject.id, qty: 2, isAddon: false as const }];
    const edit = request(f, coreLines);
    const port = createPostgresCustomerSubscriptionControlPort({
      rpc: (name, args) => asEditActor(f, async db => {
        expect(name).toBe("customer_subscription_preview_bundle_as_actor");
        const { rows: [row] } = await db.query(`SELECT
          public.customer_subscription_preview_bundle_as_actor($1,$2,$3,$4,$5,$6,$7) AS data`,
        [args?.p_subscription_id, args?.p_idempotency_key, args?.p_core_lines, args?.p_addon_lines,
          args?.p_composition_constraint, args?.p_cadence_days, args?.p_expected_template_version]);
        return { data: row.data, error: null };
      }),
    });
    const rePreview = () => port.previewAction(f.principal, { subscriptionAction: {
      action: "update_bundle", subscriptionId: f.subscriptionId, idempotencyKey: edit.key,
      coreLines, addonLines: [], compositionConstraint: {}, cadenceDays: 28, expectedTemplateVersion: 1,
    } });
    const original = (await rePreview())?.preview;
    expect(original).toMatchObject({ canApply: true, newTotal: money(source === "derived-only" ? 220 : 300, PLATFORM_DEFAULT_CURRENCY),
      catalogAvailability: { status: "available", blockedReason: null } });
    if (!original?.quoteHash) throw new Error("Expected a saved actor quote");
    const before = await editRows(f);
    expect(before.quotes).toHaveLength(1);
    expect(before.template).toMatchObject([{ variant_id: storedId }]);
    expect((await admin.query("DELETE FROM public.catalog_skus WHERE id=$1 RETURNING id", [subject.id])).rows)
      .toEqual([{ id: subject.id }]);

    const preview = (await rePreview())?.preview;
    const [apply] = await Promise.allSettled([edit.actorApply(original.quoteHash)]);
    expect.soft(preview).toEqual({ ...original, canApply: false,
      catalogAvailability: { status: "blocked", blockedReason: null } });
    expect.soft(apply).toMatchObject({ status: "rejected", reason: catalogRefusal });
    expect(await editRows(f)).toEqual(before);
  });

  it("refuses case-equivalent variant IDs across core and add-on lines without saving a quote", async () => {
    const f = await editFixture();
    const { id } = await editSku(list, 125, randomUUID().replace(/^./u, "a"));
    const edit = request(f, [{ variantId: id, qty: 2 }], [{ variantId: id.toUpperCase(), qty: 1 }]);
    const before = await editRows(f);
    const [actor] = await Promise.allSettled([edit.actorPreview()]);
    expect.soft(actor).toMatchObject({ status: "rejected",
      reason: { code: "22023", message: "subscription_edit_duplicate_variant" } });
    expect(await edit.commandPreview()).toMatchObject({ status: "refused", canApply: false, reason: "subscription_edit_invalid_lines" });
    expect(await editRows(f)).toEqual(before);
  });

  it("replays and applies frozen quotes after catalogue replacement", async () => {
    for (const path of ["actor", "command"] as const) {
      const f = await editFixture(), subject = await editSku(list, 125);
      const core = [{ variantId: subject.id, qty: 2 }], edit = request(f, core);
      const preview = (candidate: typeof edit) => path === "actor" ? candidate.actorPreview() : candidate.commandPreview();
      const original = await preview(edit);
      expect(original).toMatchObject(path === "actor" ? { canApply: true, newTotal: money(220) }
        : { canApply: true, newTotalMinor: 220 });
      const saved = await editRows(f);
      await replaceBase(subject.id, subject.entry);
      const fresh = await preview(request(f, core));
      expect(fresh).toMatchObject(path === "actor" ? { canApply: true, newTotal: money(420) }
        : { canApply: true, newTotalMinor: 420 });
      await admin.query("UPDATE public.price_entries SET active=false WHERE variant_id=$1", [subject.id]);
      if (path === "actor") await expect(preview(request(f, core))).rejects.toMatchObject(catalogRefusal);
      else expect(await preview(request(f, core))).toEqual(commandCatalogRefusal);
      expect(await preview(edit)).toEqual(original);
      expect((await editRows(f)).quotes).toContainEqual(saved.quotes[0]);
      const apply = () => path === "actor" ? edit.actorApply(original.quoteHash) : edit.commandApply(original.quoteHash);
      const applied = await apply(), appliedRows = await editRows(f);
      expect(applied).toMatchObject({ status: "applied", templateVersion: 2, eventId: expect.any(String) });
      const receipts = async () => (await admin.query(`SELECT to_jsonb(r) AS row FROM public.subscription_command_receipts r
        WHERE subscription_id=$1 AND idempotency_key=$2`, [f.subscriptionId, edit.key])).rows;
      const firstReceipt = await receipts();
      expect(firstReceipt).toHaveLength(path === "actor" ? 0 : 1);
      expect(await apply()).toMatchObject({ status: "replayed", templateVersion: 2, eventId: applied.eventId });
      expect(await editRows(f)).toEqual(appliedRows);
      expect(await receipts()).toEqual(firstReceipt);
      expect(appliedRows).toMatchObject({ anchor: saved.anchor, version: 2,
        template: [{ quantity: 2, unit_price_minor: 110, currency_code: "XXX" }],
        terms: [{ sku: subject.code, quantity: 2, unit_amount_minor: 110 }] });
      expect(appliedRows.quotes).toContainEqual(expect.objectContaining({ id: saved.quotes[0].id, accepted_event_id: applied.eventId }));
      expect(appliedRows.events).toHaveLength(saved.events.length + 1);
    }
  });

  it.each(["actor", "command"] as const)("prices stored and derived lines at the same instant after a lock wait (%s)", async path => {
    const f = await editFixture(), subject = await editSku(list, 125), stored = await editSku(list, 125);
    const before = await editRows(f), core = [{ variantId: subject.id, qty: 2 }, { variantId: stored.id, qty: 3 }];
    const blocker = await admin.connect(), waiter = await (path === "actor" ? admin : runtime).connect();
    let pending: Promise<{ rows: Record<string, unknown>[] }> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM public.subscriptions WHERE id=$1 FOR UPDATE", [f.subscriptionId]);
      await waiter.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await waiter.query("SET LOCAL statement_timeout='10s'");
      if (path === "actor") {
        await waiter.query("SET LOCAL ROLE authenticated");
        await waiter.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.principal, role: "authenticated" })]);
      }
      const { rows: [waiterRow] } = await waiter.query("SELECT pg_backend_pid() AS pid,(now()-interval '1 minute')::text AS at");
      const { rows: [blockerRow] } = await blocker.query("SELECT pg_backend_pid() AS pid");
      pending = path === "actor"
        ? waiter.query(`SELECT public.customer_subscription_preview_bundle_as_actor($1,$2,$3)->'preview' AS result, statement_timestamp()::text AS statement_at`,
          [f.subscriptionId, randomUUID(), JSON.stringify(core)])
        : waiter.query(`SELECT public.subscription_command_preview($1,$2,$3,$4,'update_package_template',$5,$6) AS result`,
          [f.commandActor, f.clientId, randomUUID(), f.subscriptionId,
            { coreLines: core, expectedTemplateVersion: 1, compositionConstraint: {} }, waiterRow.at]);
      void pending.catch(() => {});
      await expect.poll(async () => (await blocker.query("SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked",
        [blockerRow.pid, waiterRow.pid])).rows[0].blocked, { timeout: 4000, interval: 20 }).toBe(true);
      const { rows: [cutover] } = await blocker.query(`SELECT stamp.at::text,stamp.at>a.query_start AS after_start
        FROM (SELECT clock_timestamp() AS at) stamp,pg_stat_activity a WHERE a.pid=$1`, [waiterRow.pid]);
      expect(cutover.after_start).toBe(true);
      await blocker.query("UPDATE public.price_entries SET active=false,valid_to=$2 WHERE id=$1", [subject.entry, cutover.at]);
      await blocker.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
        VALUES($1,$2,'one_time',230,$3),($1,$4,'subscription',77,$3)`, [list, subject.id, cutover.at, stored.id]);
      await blocker.query("COMMIT");
      const { result, statement_at } = (await pending).rows[0];
      const expiryClock = path === "actor" ? statement_at : waiterRow.at;
      expect((await blocker.query(`SELECT ($1::jsonb->>'quoteExpiresAt')::timestamptz=$2::timestamptz+interval '15 minutes' AS same`,
        [result, expiryClock])).rows).toEqual([{ same: true }]);
      await waiter.query("COMMIT");
      const after = await editRows(f);
      expect.soft(result).toMatchObject(path === "actor"
        ? { canApply: true, newTotal: money(651) } : { canApply: true, newTotalMinor: 651 });
      expect.soft(after.quotes).toMatchObject([{ proposed_lines: [
        { variantId: subject.id, unitPriceMinor: 210 }, { variantId: stored.id, unitPriceMinor: 77 },
      ] }]);
      expect({ ...after, quotes: before.quotes }).toEqual(before);
    } finally {
      await blocker.query("ROLLBACK");
      await pending?.catch(() => {});
      await waiter.query("ROLLBACK");
      blocker.release();
      waiter.release();
    }
  });

  it("refuses incomplete pricing and checks actor renewal context at preview and apply", async () => {
    const f = await editFixture(), missing = await editSku(), core = [{ variantId: skuId, qty: 1 }, { variantId: missing.id, qty: 1 }];
    const edit = request(f, core), before = await editRows(f);
    await expect(edit.actorPreview()).rejects.toMatchObject(catalogRefusal);
    expect(await edit.commandPreview()).toEqual(commandCatalogRefusal);
    expect(await editRows(f)).toEqual(before);
    await admin.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor) VALUES($1,$2,'one_time',125)", [list, missing.id]);
    expect(await edit.commandPreview()).toEqual(commandCatalogRefusal);
    const repaired = request(f, core), preview = await repaired.commandPreview();
    expect(preview).toMatchObject({ canApply: true, newTotalMinor: 220 });
    expect(await repaired.commandApply(preview.quoteHash)).toMatchObject({ status: "applied", templateVersion: 2 });

    const limits = await editFixture(), exactList = await editList("ZW", "XXX", 0, 1);
    await setContext(limits, exactList, "XXX");
    const exact = await editSku(exactList, 2_147_483_647), minimum = await editSku(exactList, 1);
    await admin.query("UPDATE public.catalog_skus SET min_order_qty=2 WHERE id=$1", [minimum.id]);
    const both = async (core: EditLine[], addons: EditLine[] = [], total?: number) => {
      const q = request(limits, core, addons);
      if (total === undefined) {
        await expect(q.actorPreview()).rejects.toMatchObject(catalogRefusal);
        expect(await q.commandPreview()).toEqual(commandCatalogRefusal);
      } else {
        expect(await q.actorPreview()).toMatchObject({ canApply: true, newTotal: money(total) });
        expect(await q.commandPreview()).toMatchObject({ canApply: true, newTotalMinor: total });
      }
    };
    await both([{ variantId: minimum.id, qty: 1 }]);
    await both([{ variantId: minimum.id, qty: 2 }], [], 2);
    await both([{ variantId: exact.id, qty: 1 }], [], 2_147_483_647);
    await both([{ variantId: exact.id, qty: 2 }]);
    await admin.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,amount_kind)
      VALUES($1,$2,'one_time',2,'net')`, [exactList, minimum.id]);
    await both([{ variantId: minimum.id, qty: 2 }]);
    const endpoints: EditLine[] = [];
    for (let index = 0; index <= 18; index++) endpoints.push({ variantId: (await editSku(exactList, 1)).id, qty: 99 });
    await both(endpoints.slice(0, 6), endpoints.slice(6, 18), 18 * 99);
    for (const [core, addons] of [
      [[], []], [endpoints.slice(0, 7), []], [endpoints.slice(0, 6), endpoints.slice(6)],
      [[{ ...endpoints[0], qty: 0 }], []], [[{ ...endpoints[0], qty: 100 }], []],
    ]) {
      const q = request(limits, core, addons);
      await expect(q.actorPreview()).rejects.toMatchObject({ code: "22023", message: "subscription_edit_invalid_lines" });
      expect(await q.commandPreview()).toMatchObject({ status: "refused", reason: "subscription_edit_invalid_lines" });
    }

    for (const invalid of ["absent", "other currency"] as const) {
      const invalidate = async (f: EditFixture) => {
        if (invalid === "absent") {
          await admin.query("DELETE FROM public.subscription_renewal_terms WHERE subscription_id=$1", [f.subscriptionId]);
        } else {
          await admin.query("UPDATE public.subscription_renewal_terms SET currency_code='XYY' WHERE subscription_id=$1", [f.subscriptionId]);
        }
      };
      const lines = [{ variantId: skuId, qty: 2 }];
      const fresh = await editFixture(), attempt = request(fresh, lines), header = (await editRows(fresh)).header;
      await invalidate(fresh);
      const withoutHeader = await editRows(fresh);
      await expect(attempt.actorPreview()).rejects.toMatchObject(contextRefusal);
      expect(await editRows(fresh)).toEqual(withoutHeader);
      if (invalid === "absent") {
        await admin.query(`INSERT INTO public.subscription_renewal_terms
          SELECT * FROM jsonb_populate_record(NULL::public.subscription_renewal_terms,$1)`, [header]);
      } else {
        await admin.query("UPDATE public.subscription_renewal_terms SET currency_code='XXX' WHERE subscription_id=$1", [fresh.subscriptionId]);
      }
      expect(await attempt.actorPreview()).toMatchObject({ canApply: true, newTotal: money(220) });
      const quoted = await editFixture(), acceptance = request(quoted, lines);
      const original = await acceptance.actorPreview();
      expect(original).toMatchObject({ canApply: true, newTotal: money(220) });
      await invalidate(quoted);
      const baseline = await editRows(quoted);
      expect(await acceptance.actorPreview()).toEqual({ ...original, canApply: false });
      await expect(acceptance.actorApply(original.quoteHash)).rejects.toMatchObject(contextRefusal);
      expect(await editRows(quoted)).toEqual(baseline);
    }
  });

  it("attaches the historical derived price and admits edits at the current stored price", async () => {
    const { p, id, code, entryId, lines } = await newDerivedPurchase(105);
    await waitForCutoff(await replaceBase(id, entryId));
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await api.activateNativePurchaseWithRenewal(executor, { ...p,
      facts: { ...facts, lines, unattendedChargeAuthorizedAt: p.purchaseAt } });
    expect(result.renewalAttachment).toBe("complete");
    const subscriptionId = String(result.activation.subscriptionId);
    const before = await state(subscriptionId);
    expect(before).toMatchObject({ price_list_id: list, currency_code: "XXX", template_version: 1 });
    expect(log.mock.calls).toEqual([]);
    expect((await runtime.query(`SELECT sku,quantity,unit_amount_minor::int FROM public.subscription_renewal_term_lines
      WHERE subscription_id=$1`, [subscriptionId])).rows).toEqual([{ sku: code, quantity: 1, unit_amount_minor: 110 }]);
    const editNow = await clock();
    expect((await admin.query(`SELECT $2::timestamptz < next_cycle_at-make_interval(hours=>edit_window_hours) AS in_window
      FROM public.subscriptions WHERE id=$1`, [subscriptionId, editNow])).rows).toEqual([{ in_window: true }]);
    expect((await runtime.query("SELECT health_state FROM public.subscription_method_states WHERE subscription_id=$1", [subscriptionId])).rows)
      .toEqual([{ health_state: "healthy" }]);
    const principal = (await admin.query("SELECT principal_id FROM public.clients WHERE id=$1", [p.clientId])).rows[0].principal_id;
    const db = await admin.connect();
    try {
      await db.query("BEGIN");
      await db.query("SET LOCAL ROLE authenticated");
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: principal, role: "authenticated" })]);
      const { rows: [preview] } = await db.query("SELECT public.customer_subscription_preview_bundle_as_actor($1,$2,$3) AS result",
        [subscriptionId, randomUUID(), JSON.stringify([{ variantId: id, qty: 3 }])]);
      expect(preview.result.preview).toMatchObject({ canApply: true });
      await db.query("COMMIT");
    } catch (error) { await db.query("ROLLBACK"); throw error; }
    finally { db.release(); }
    expect(await edit({ clientId: p.clientId, subscriptionId }, id, editNow)).toMatchObject({ status: "applied", templateVersion: 2 });
    expect(await state(subscriptionId)).toMatchObject({ next_cycle_at: before.next_cycle_at, template_version: 2 });
  });

  it("recovers historical derived context at delivery-three graduation without shifting the due anchor", async () => {
    const { p, id, code, entryId, lines } = await newDerivedPurchase();
    const terms = retainedTerms();
    terms.starterPack!.delivery2.basisSubtotalMinor = derived;
    terms.starterPack!.graduation.lines = [{ sku: code, qty: 1, sortOrder: 0, isAddon: false,
      quoteLine: { unitPriceGross: { amountMinor: derived }, lineSubtotalGross: { amountMinor: derived } } }];
    const result = await api.activateNativePurchaseWithRenewal(executor, { ...p,
      facts: { ...facts, lines, renewalTerms: terms, unattendedChargeAuthorizedAt: p.purchaseAt } });
    expect(result.renewalAttachment).toBe("complete");
    const subscriptionId = String(result.activation.subscriptionId);
    const bound = { price_list_id: list, currency_code: "XXX" };
    expect(await state(subscriptionId)).toMatchObject({ ...bound, template_version: 1 });
    const paidCycles = async () => (await admin.query(`SELECT c.id=o.subscription_cycle_id AS initial,c.status
      FROM public.subscription_cycles c JOIN public.subscription_activations a ON a.subscription_id=c.subscription_id
      JOIN public.commerce_orders o ON o.id=a.order_id
      WHERE c.subscription_id=$1 AND o.id=$2 ORDER BY c.scheduled_at`, [subscriptionId, p.orderId])).rows;
    expect(await paidCycles()).toEqual([{ initial: true, status: "paid" }]);
    const cutoff = await replaceBase(id, entryId);
    const asOf = (await admin.query<{ as_of: Date }>("SELECT next_cycle_at+interval '1 minute' AS as_of FROM public.subscriptions WHERE id=$1",
      [subscriptionId])).rows[0]!.as_of.toISOString();
    const renewal = await deps(subscriptionId, "succeeded", asOf);
    renewal.input.settlement = api.createPostgresRenewalSettlementPort(executor, renewal.codec, transaction);
    expect(await api.runOneAutomaticSubscriptionRenewal(renewal.input, renewal.due, asOf)).toMatchObject({ status: "succeeded" });
    expect(await paidCycles()).toEqual([{ initial: true, status: "paid" }, { initial: false, status: "paid" }]);
    expect(await state(subscriptionId)).toMatchObject(bound);
    await admin.query("UPDATE public.subscriptions SET price_list_id=NULL,currency_code=NULL WHERE id=$1", [subscriptionId]);
    const { rows: [anchor] } = await admin.query(`SELECT price_list_id,currency_code,next_cycle_at::text,
      to_char(next_cycle_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS scheduled
      FROM public.subscriptions WHERE id=$1`, [subscriptionId]);
    expect(anchor).toMatchObject({ price_list_id: null, currency_code: null });
    await waitForCutoff(cutoff);
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const snapshot = await renewal.input.store.buildCycleSnapshots({ subscriptionId, scheduledAt: anchor.scheduled,
      scheduledInstant: Date.parse(anchor.scheduled) });
    expect(snapshot.templateSnapshot).toMatchObject({ cadenceDays: 30, lines: [{ sku: code, quantity: 1, unitAmountMinor: 110 }] });
    expect(await state(subscriptionId)).toMatchObject({ ...bound, template_version: 2, next_cycle_at: anchor.next_cycle_at });
    expect(log.mock.calls).toEqual([]);
  });

  it.each([
    { name: "rebinds the list for a matching derived purchase", mixed: false, tampered: false },
    { name: "leaves the price context missing for a tampered derived purchase", mixed: false, tampered: true },
    { name: "binds a mixed purchase with the derived line second and refuses it after tampering", mixed: true, tampered: true },
  ])("$name", async ({ mixed, tampered }) => {
    const derivedLine: PurchasePosition = { sku, quantity: 1, unitPrice: derived, catalogFacts: {
      version: "catalog_facts_v2", skuId, documentRevisionId: randomUUID(), documentDigest: "a".repeat(64),
      basePriceEntryId: baseId, baseUnitAmountMinor: base, policyRevisionId: policy.id, policyDigest: policy.digest,
      resolvedUnitAmountMinor: derived, resolvedLineAmountMinor: derived, currency: "XXX", mode: "subscription", atTime: await clock(),
    } };
    const positions = mixed ? [{ sku: storedSku, quantity: 2, unitPrice: 100 }, derivedLine] : [derivedLine];
    const p = await draftedPurchase("subscription", 0, positions, clock);
    const { rows: [order] } = await admin.query("SELECT metadata#>'{orderDraftSnapshot,lines}' AS lines FROM public.commerce_orders WHERE id=$1", [p.orderId]);
    expect(order.lines.map((line: { sku: string; catalogFacts?: CatalogFactsProvenance }) => [line.sku, line.catalogFacts?.version]))
      .toEqual(mixed ? [[storedSku, undefined], [sku, "catalog_facts_v2"]] : [[sku, "catalog_facts_v2"]]);

    const terms = retainedTerms(), marker = terms.starterPack!;
    marker.delivery2.basisSubtotalMinor = positions.reduce((total, line) => total + line.quantity * line.unitPrice, 0);
    marker.graduation.lines = positions.map(({ sku, quantity, unitPrice }, sortOrder) => ({ sku, qty: quantity, sortOrder,
      isAddon: false, quoteLine: { unitPriceGross: { amountMinor: unitPrice }, lineSubtotalGross: { amountMinor: quantity * unitPrice } } }));
    const result = await api.activateNativePurchaseWithRenewal(executor, { ...p, facts: { ...facts, renewalTerms: terms,
      unattendedChargeAuthorizedAt: p.purchaseAt, lines: positions.map(({ sku, quantity, unitPrice }, index) => ({
        lineOrdinal: index + 1, sku, quantity, unitAmountMinor: unitPrice,
      })) } });
    expect(result.renewalAttachment).toBe("complete");
    const subscriptionId = String(result.activation.subscriptionId);
    const bound = { price_list_id: list, currency_code: "XXX" };
    const empty = { price_list_id: null, currency_code: null };
    expect(await state(subscriptionId)).toMatchObject(bound);

    const { rows: [firstDue] } = await admin.query<{ as_of: Date }>(
      "SELECT next_cycle_at+interval '1 minute' AS as_of FROM public.subscriptions WHERE id=$1", [subscriptionId]);
    const asOf = firstDue!.as_of.toISOString();
    const renewal = await deps(subscriptionId, "succeeded", asOf);
    renewal.input.settlement = api.createPostgresRenewalSettlementPort(executor, renewal.codec, transaction);
    expect(await api.runOneAutomaticSubscriptionRenewal(renewal.input, renewal.due, asOf)).toMatchObject({ status: "succeeded" });

    if (tampered) {
      const path = ["orderDraftSnapshot", "lines", String(positions.length - 1), "unitPriceGross", "amountMinor"];
      expect((await admin.query(`UPDATE public.commerce_orders SET metadata=jsonb_set(metadata,$2::text[],to_jsonb($3::int),false)
        WHERE id=$1 AND metadata#>>$2::text[]=$4 RETURNING metadata#>$2::text[] AS amount`,
      [p.orderId, path, derived + 1, String(derived)])).rows).toEqual([{ amount: derived + 1 }]);
    }
    await admin.query("UPDATE public.subscriptions SET price_list_id=NULL,currency_code=NULL WHERE id=$1", [subscriptionId]);
    expect(await state(subscriptionId)).toMatchObject(empty);
    const { rows: [next] } = await admin.query<{ next_cycle_at: Date }>("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [subscriptionId]);
    const scheduledAt = next!.next_cycle_at.toISOString();
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const snapshot = await renewal.input.store.buildCycleSnapshots({ subscriptionId, scheduledAt, scheduledInstant: Date.parse(scheduledAt) });
    expect(snapshot.templateSnapshot).toMatchObject({ cadenceDays: 30 });
    expect(await state(subscriptionId)).toMatchObject({ ...(tampered ? empty : bound), template_version: 2 });
    expect(log.mock.calls).toEqual(tampered ? [["subscription_price_list_unresolved", "missing"]] : []);
  });
});

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
      || sql.startsWith("SELECT currency_code,created_at::text AS created_at,")
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
