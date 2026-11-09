import { createHash, randomUUID } from "node:crypto";
import { Pool, type QueryConfig } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { PostgresTransferError } from "@openlup/platform/portability";
import type { ConnectedNativeStoreCapture } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { captureStoreJourney, journeyCensus, journeySelection, storeJourneyResources,
  type JourneyInstallation } from "../helpers/storeJourney.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";

const resources = storeJourneyResources();
const at = "2026-10-01T00:00:00Z", expires = "2027-01-01T00:00:00Z";
const sku = randomUUID(), list = randomUUID(), clients = [randomUUID(), randomUUID()], orders = [randomUUID(), randomUUID()];
const promotion = "synthetic-first-subscription";
let source: JourneyInstallation, empty: JourneyInstallation, target: JourneyInstallation;
let packet: ConnectedNativeStoreCapture, emptyPacket: ConnectedNativeStoreCapture, freshTarget: ConnectedNativeStoreCapture;
let targetNumber = 0;

async function parents(store: JourneyInstallation) {
  await store.owner.query(`INSERT INTO public.catalog_products(id,slug,name,created_at,updated_at)
    VALUES($1,'synthetic-claim-product','Synthetic product',$2,$2)`, [sku, at]);
  await store.owner.query(`INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription,created_at,updated_at)
    VALUES($1,$1,'SYNTHETIC-CLAIM','Synthetic SKU',true,$2,$2)`, [sku, at]);
  await store.owner.query(`INSERT INTO public.price_lists(id,name,region_code,currency,valid_from,created_at,updated_at)
    VALUES($1,'Synthetic prices','ZZ','XXX',$2,$2,$2)`, [list, at]);
  await store.owner.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,unit_price_minor,valid_from)
    VALUES($1,$2,'any',1000,$3)`, [list, sku, at]);
  const definition = { id: promotion, status: "active", code: null, name: "Synthetic first subscription",
    trigger_type: "automatic", discount_type: "percentage", discount_value: 10, applies_to_kind: "order_total",
    applies_to_payload: { cart_mode: "subscription" }, stacking_rule: "exclusive",
    eligibility: { first_subscription_purchase: true }, region_availability: ["ZZ"], valid_from: at, valid_to: null,
    redemption_limit_global: null, redemption_limit_per_customer: 1 };
  await store.owner.query(`INSERT INTO public.commerce_promotion_definitions(promotion_id,definition,active,created_at,updated_at)
    VALUES($1,$2,true,$3,$3)`, [promotion, definition, at]);
}

beforeAll(async () => {
  source = await resources.installation("claims-source");
  empty = await resources.installation("claims-empty");
  await parents(source); await parents(empty);
  for (const [index, order] of orders.entries()) {
    const db = await source.owner.connect();
    try {
      await db.query("BEGIN");
      await db.query("INSERT INTO public.clients(id,email,created_at,updated_at) VALUES($1,$2,$3,$3)",
        [clients[index], `synthetic-claims-${index}@example.invalid`, at]);
      await db.query(`INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor,created_at,updated_at)
        VALUES($1,$2,'pending_payment','XXX',900,$3,$3)`, [order, clients[index], at]);
      await db.query(`INSERT INTO public.commerce_order_items(order_id,line_ordinal,sku_id,quantity,unit_amount_minor,line_amount_minor,created_at)
        VALUES($1,1,$2,1,900,900,$3)`, [order, sku, at]);
      const adjustment = (await db.query(`INSERT INTO public.commerce_order_adjustments
        (order_id,kind,scope,amount_minor,promotion_id,definition_fingerprint,created_at)
        SELECT $1,'promotion_discount','order_total',100,promotion_id,definition_fingerprint,$2
        FROM public.commerce_promotion_definitions WHERE promotion_id=$3 RETURNING id`, [order, at, promotion])).rows[0].id;
      const claim = (await db.query(`INSERT INTO public.commerce_promotion_claims
        (promotion_id,definition_fingerprint,adjustment_id,order_id,client_id,amount_off_minor,reserved_at,expires_at,updated_at)
        SELECT promotion_id,definition_fingerprint,$1,$2,$3,100,$4,$5,$4
        FROM public.commerce_promotion_definitions WHERE promotion_id=$6 RETURNING id`,
      [adjustment, order, clients[index], at, expires, promotion])).rows[0].id;
      await db.query(`INSERT INTO public.commerce_promotion_claim_events(claim_id,event_key,transition,occurred_at)
        VALUES($1,$2,'reserved',$3)`, [claim, `reserved:${order}`, at]);
      await db.query("COMMIT");
    } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  }
  // Use the real status hook to redeem the first claim and append its event.
  await source.owner.query("UPDATE public.commerce_orders SET status='paid',paid_at=$2 WHERE id=$1", [orders[0], at]);
  packet = await captureStoreJourney(source.owner, "promotion-claims-source");
  emptyPacket = await captureStoreJourney(empty.owner, "promotion-claims-empty");
}, postgresSetupTimeoutMs);

beforeEach(async () => {
  target = await resources.installation(`claims-target-${++targetNumber}`);
  freshTarget = await captureStoreJourney(target.owner, "promotion-claims-target");
}, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);
const restore = (captured = packet, owner = target.owner, fresh = freshTarget) => restoreConnectedNativeStore({
  owner, installation: journeySelection, packet: captured, freshTarget: fresh,
});
function rehash(captured: ConnectedNativeStoreCapture) {
  const { sha256: _old, ...body } = captured;
  captured.sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return captured;
}
function observedOwner(onError: (error: unknown) => void): Pool {
  return { async connect() {
    const client = await target.owner.connect();
    return { async query(sql: string | QueryConfig, values?: unknown[]) {
      try { return typeof sql === "string" ? await client.query(sql, values) : await client.query(sql); }
      catch (error) { onError(error); throw error; }
    }, release: (destroy?: boolean) => client.release(destroy) };
  } } as unknown as Pool;
}

// The earlier two-installation spike measured 10.32 seconds including setup.
// Case bodies retain the 30-second transfer budget; the control installation
// in the redemption case has a 45-second budget (over four times that spike).
it("carries reserved and redeemed claims and their events byte-exactly and replays", async () => {
  const before = await journeyCensus(source.owner);
  expect(before.commerce_promotion_claims).toHaveLength(2);
  expect(before.commerce_promotion_claim_events).toHaveLength(3);
  expect((await source.owner.query("SELECT status FROM public.commerce_promotion_claims ORDER BY status")).rows)
    .toEqual([{ status: "redeemed" }, { status: "reserved" }]);
  for (const table of ["commerce_promotion_claims", "commerce_promotion_claim_events"] as const) {
    expect(packet.owned.find(value => value.table === table)?.rows).toEqual(before[table]);
  }
  expect(await restore()).toMatchObject({ replayed: false });
  expect(await journeyCensus(target.owner)).toEqual(before);
  expect(await restore()).toMatchObject({ replayed: true });
  expect(await journeyCensus(target.owner)).toEqual(before);
}, 30_000);

async function secondRedemption(store: JourneyInstallation) {
  const money = (amountMinor: number) => ({ amountMinor, currency: "XXX" });
  const quote = { currency: "XXX", taxIncluded: true, lines: [{ sku: "SYNTHETIC-CLAIM", productSlug: "synthetic-claim-product",
    quantity: 1, unitPriceGross: money(1000), lineSubtotalGross: money(1000), tax: { included: true, country: "ZZ",
      category: "standard", vatRateBps: 0, legalBasis: "Synthetic", netAmount: money(1000), vatAmount: money(0), grossAmount: money(1000) } }],
  discounts: [{ promotionId: promotion, name: "Synthetic first subscription", amountOffMinor: 100, appliesTo: "order_total", source: "automatic" }],
  context: { mode: "subscription", cadenceDays: 28, promoCodes: [] }, subtotalGross: money(1000), discountTotalGross: money(100),
  shippingGross: money(0), shippingDiscountGross: money(0), totalGross: money(900), netTotal: money(900), taxTotal: money(0) };
  const snapshot = { contractVersion: "commerce.v0", quote }, draft = { contractVersion: "commerce.v0",
    source: "commerce.order_draft.bff.v0", status: "draft", paymentStatus: "not_started", currency: "XXX", taxIncluded: true,
    lines: quote.lines, discounts: quote.discounts, context: quote.context, totals: { subtotalGross: quote.subtotalGross,
      discountTotalGross: quote.discountTotalGross, shippingGross: quote.shippingGross, shippingDiscountGross: quote.shippingDiscountGross,
      totalGross: quote.totalGross, netTotal: quote.netTotal, taxTotal: quote.taxTotal } };
  // Observe the public writer's exact SQL refusal, before adapter redaction.
  return store.runtime.query(`SELECT public.commerce_create_promoted_order_draft_with_outbox($1,$2::jsonb,$3::jsonb,$4::uuid) AS result`,
    [`synthetic-second:${randomUUID()}`, JSON.stringify(snapshot), JSON.stringify(draft), clients[0]]);
}
it("refuses a second first-subscription redemption while missing claim history permits it", async () => {
  expect(await restore()).toMatchObject({ replayed: false });
  const before = await journeyCensus(target.owner);
  await expect(secondRedemption(target)).rejects.toMatchObject({ code: "40001", message: "commerce_promotion_customer_limit_reached" });
  expect(await journeyCensus(target.owner)).toEqual(before);
  const control = await resources.installation("claims-missing-history");
  const fresh = await captureStoreJourney(control.owner, "promotion-claims-control");
  const missingHistory = structuredClone(packet);
  for (const rows of missingHistory.owned) if (["commerce_promotion_claims", "commerce_promotion_claim_events"].includes(rows.table)) rows.rows = [];
  expect(await restore(rehash(missingHistory), control.owner, fresh)).toMatchObject({ replayed: false });
  const created = await secondRedemption(control);
  expect(created.rows[0].result.orderDraft.replayed).toBe(false);
  expect((await control.owner.query("SELECT count(*)::int AS count FROM public.commerce_promotion_claims WHERE client_id=$1", [clients[0]])).rows)
    .toEqual([{ count: 1 }]);
}, 45_000);

for (const [table, field, constraint] of [
  ["commerce_promotion_claims", "order_id", "commerce_promotion_claims_order_id_fkey"],
  ["commerce_promotion_claims", "promotion_id", "commerce_promotion_claims_promotion_id_fkey"],
  ["commerce_promotion_claims", "adjustment_id", "commerce_promotion_claims_adjustment_id_fkey"],
  ["commerce_promotion_claim_events", "claim_id", "commerce_promotion_claim_events_claim_id_fkey"],
] as const) {
  it(`refuses a missing ${table}.${field} parent in a distinct target and rolls back`, async () => {
    const pristine = await journeyCensus(target.owner), corrupted = structuredClone(packet);
    expect(packet.observation.cluster).not.toBe(freshTarget.observation.cluster);
    const relation = corrupted.owned.find(value => value.table === table)!;
    const row = relation.rows[0], original = (JSON.parse(row) as Record<string, unknown>)[field];
    relation.rows[0] = row.replace(`"${field}": "${original}"`, `"${field}": "${field === "promotion_id" ? "synthetic-missing" : randomUUID()}"`);
    expect(relation.rows[0]).not.toBe(row);
    let referenceError: unknown;
    await expect(restore(rehash(corrupted), observedOwner(error => { referenceError = error; }))).rejects.toBeInstanceOf(PostgresTransferError);
    expect(referenceError).toMatchObject({ code: "23503", constraint });
    expect(await journeyCensus(target.owner)).toEqual(pristine);
  }, 30_000);
}
it("restores a store without claims or events unchanged", async () => {
  const before = await journeyCensus(empty.owner);
  expect(before.commerce_promotion_claims).toEqual([]); expect(before.commerce_promotion_claim_events).toEqual([]);
  expect(await restore(emptyPacket)).toMatchObject({ replayed: false });
  expect(await journeyCensus(target.owner)).toEqual(before);
  expect(await restore(emptyPacket)).toMatchObject({ replayed: true });
  expect(await journeyCensus(target.owner)).toEqual(before);
}, 30_000);
