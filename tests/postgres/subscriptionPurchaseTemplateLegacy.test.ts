import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createPostgresPurchaseRenewalWriter } from "@openlup/platform/subscriptions";
import { createPostgresAccountReadSources, createPostgresCustomerOrderHistoryReadStore } from "@openlup/platform/account-support";
import { nativeHarness } from "../helpers/fulfillmentNative.js";
import { call } from "./subscriptionNativeFixture.js";

const h = nativeHarness("purchase-template");
beforeAll(() => h.start(), 120_000);
afterAll(() => h.stop());

it("shows the purchased package with unresolved context using the existing legacy owner harness", async () => {
  // The existing legacy harness uses its owner connection; no restricted legacy
  // runtime fixture supplies template/catalog grants. No such grants are added.
  // The qualified companion separately proves the real unavailable-read branch.
  const client = randomUUID(), principal = randomUUID(), sku = randomUUID(), order = randomUUID(), key = randomUUID();
  const at = "2026-09-01T12:00:00.000Z";
  await h.pool.query("INSERT INTO public.clients(id,email,principal_id) VALUES($1,$2,$3)", [client, `${client}@example.invalid`, principal]);
  await h.pool.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Synthetic refill')", [sku, `refill-${sku}`]);
  await h.pool.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription) VALUES($1,$1,$2,'Synthetic refill',true)", [sku, `REFILL-${sku}`]);
  // Same paid graph fixture style as the native lifecycle harness. The order's
  // admitted price list is no longer available when the attachment is drained.
  const db = await h.pool.connect();
  try {
  await db.query("BEGIN");
  await db.query("INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor,metadata) VALUES($1,$2,'paid','XXX',200,$3)", [order, client, { orderDraftSnapshot: { context: { mode: "subscription" } } }]);
  await db.query("INSERT INTO public.commerce_order_items(order_id,sku_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,$2,1,2,100,200)", [order, sku]);
  await db.query("INSERT INTO public.commerce_settlement_intents(order_id,channel_key,status,amount_minor,currency_code,settled_at,open_idempotency_key,external_ref) VALUES($1,'sandbox','settled',200,'XXX',$2,$3,$3)", [order, at, `open:${key}`]);
  await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  await call(h.pool, "subscription_declare_provisional_activation", [`declare:${key}`, order, 28, at]);
  const writer = createPostgresPurchaseRenewalWriter(h.pool);
  await writer.register(order, { settlementChannelKey: "sandbox", authorizationRef: "synthetic-authorization", unattendedChargeAuthorizedAt: at,
    payerAccountRef: null, methodRef: "synthetic-method", methodEvidenceRef: "synthetic-evidence", stockSourceKey: "synthetic-stock", templateId: "synthetic-template",
    cadenceDays: 28, currency: "XXX", lines: [{ lineOrdinal: 1, sku: `REFILL-${sku}`, quantity: 2, unitAmountMinor: 100 }], shippingAmountMinor: 0, acquisitionRef: null });
  const activation = await call(h.pool, "subscription_activate_from_captured_payment", [`activate:${key}`, order, createHash("sha256").update(`open:${key}`).digest("hex")]);
  const id = activation.subscriptionId as string;
  const state = () => h.pool.query("SELECT next_cycle_at::text,status,price_list_id,currency_code FROM public.subscriptions WHERE id=$1", [id]).then(r => r.rows[0]);
  const before = await state(), log = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await writer.complete(order)).toMatchObject({ replayed: false });
    const scope = { principalId: principal, clientId: client };
    const sources = createPostgresAccountReadSources(h.pool, { ...scope,
      orders: createPostgresCustomerOrderHistoryReadStore(h.pool, { ...scope, readInvoiceSummaries: async () => new Map() }),
      orderProjection: { automaticHoldSource: "synthetic.hold", automaticReleaseSource: "synthetic.release", orderReference: value => value,
        presentation: { display: () => ({ title: "Refill", variantName: null, productSlug: null, displayLabel: null, accentColor: null }) },
        fulfillmentEvidence: () => ({ trackingReferences: [], trackingNumbers: [], trackingNumber: null, trackingUrl: null, carrierKind: null, service: null, trackingTimeline: [] }) },
      additional: { readExtension: async () => null, readNextCharges: async () => new Map() }, now: () => at });
    expect((await sources.readSubscriptionLines([id])).get(id)).toMatchObject([{ variantId: sku, qty: 2, sortOrder: 0, isAddon: false }]);
    expect(await state()).toEqual(before);
    expect(await call(h.pool, "subscription_command_preview", [principal, client, randomUUID(), id, "resize_bundle",
      { expectedTemplateVersion: 1, coreLines: [{ variantId: sku, qty: 3 }], compositionConstraint: { kind: "units", value: 3 } }, "2026-09-02T12:00:00Z"]))
      .toMatchObject({ status: "refused", reason: "subscription_edit_invalid_request" });
    expect(log.mock.calls).toEqual([["subscription_price_list_unresolved", "missing"]]);
  } finally { log.mockRestore(); }
});
