import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createPostgresSandboxPaymentSimulator } from "@openlup/platform/payments";
import { captureSandboxPurchase } from "../helpers/captureSandboxPurchase.js";
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
  const client = randomUUID(), principal = randomUUID(), sku = randomUUID(), priceList = randomUUID(), key = randomUUID();
  const at = "2026-09-01T12:00:00.000Z";
  await h.pool.query("INSERT INTO public.clients(id,email,principal_id) VALUES($1,$2,$3)", [client, `${client}@example.invalid`, principal]);
  await h.pool.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Synthetic refill')", [sku, `refill-${sku}`]);
  await h.pool.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription) VALUES($1,$1,$2,'Synthetic refill',true)", [sku, `REFILL-${sku}`]);
  await h.pool.query("INSERT INTO public.price_lists(id,name,region_code,currency,valid_from) VALUES($1,'Synthetic list','ZZ','XXX','2026-01-01T00:00:00Z')", [priceList]);
  await h.pool.query("INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from) VALUES($1,$2,'any',100,'2026-01-01T00:00:00Z')", [priceList, sku]);
  // The public writer persists the same admitted draft source as the runtime.
  const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
  const quote = { context: { mode: "subscription", cadenceDays: 28 }, lines: [{ sku: `REFILL-${sku}`, quantity: 2,
    unitPriceGross: money(100), lineSubtotalGross: money(200) }], totalGross: money(200) };
  const draft = { contractVersion: "commerce.v0", source: "commerce.order_draft.bff.v0", status: "draft", paymentStatus: "not_started",
    currency: "XXX", context: quote.context, lines: quote.lines, totals: { totalGross: money(200) } };
  const made = await call(h.pool, "commerce_create_order_draft_with_outbox", [key, JSON.stringify({ quote }), JSON.stringify(draft), client]);
  const order = String(made.orderDraft.orderId).replace(/^order_/, "");
  const intent = await call(h.pool, "commerce_open_settlement_intent", [`open:${key}`, order, "sandbox", 200, "XXX", "{}", at]);
  await captureSandboxPurchase(createPostgresSandboxPaymentSimulator(h.pool,
    { dunningTemplateSlug: "failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "recovered" }),
    { settlementIntentId: intent.settlement.id, key, at });
  const settled = (await h.pool.query("SELECT external_ref,id FROM public.commerce_settlement_intents WHERE id=$1", [intent.settlement.id])).rows[0];
  await h.pool.query("UPDATE public.price_lists SET status='archived' WHERE id=$1", [priceList]);
  await call(h.pool, "subscription_declare_provisional_activation", [`declare:${key}`, order, 28, at]);
  const writer = createPostgresPurchaseRenewalWriter(h.pool);
  await writer.register(order, { settlementChannelKey: "sandbox", authorizationRef: "synthetic-authorization", unattendedChargeAuthorizedAt: at,
    payerAccountRef: null, methodRef: "synthetic-method", methodEvidenceRef: "synthetic-evidence", stockSourceKey: "synthetic-stock", templateId: "synthetic-template",
    cadenceDays: 28, currency: "XXX", lines: [{ lineOrdinal: 1, sku: `REFILL-${sku}`, quantity: 2, unitAmountMinor: 100 }], shippingAmountMinor: 0, acquisitionRef: null });
  const activation = await call(h.pool, "subscription_activate_from_captured_payment", [`activate:${key}`, order, createHash("sha256").update(settled.external_ref ?? settled.id).digest("hex")]);
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
