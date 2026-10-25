import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { checkReadiness, createSchemaProbe } from "@openlup/core/readiness";
import { createM11CommerceReferenceBinding } from "../../server/runtime/public-reference/m11CommerceBinding.js";
import { fixture, nativeHarness, openCase, replacement, units } from "../helpers/fulfillmentNative.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { AT, call, renewal, prepareOriginal } from "./subscriptionNativeFixture.js";

const h = nativeHarness("commerce-composition");
beforeAll(() => h.start(), postgresSetupTimeoutMs);
afterAll(() => h.stop(), postgresTeardownTimeoutMs);

async function bind() {
  const installed = await h.runner().status(); expect(installed.pending).toEqual([]);
  expect(installed.applied).toEqual(units.map(unit => unit.file));
  const catalogue = { version: createHash("sha256").update(JSON.stringify(units)).digest("hex"), migration: installed.applied[installed.applied.length - 1] };
  const version = JSON.parse(readFileSync("packages/platform/package.json", "utf8")).version as string;
  const probe = createSchemaProbe({ query: (text, values) => h.pool.query(text, values ? [...values] : undefined) },
    async () => ({ database: "owned-disposable", version: catalogue.version }));
  const binding = createM11CommerceReferenceBinding({ enabled: true, executor: h.pool, commerce: {}, requiredObjects: [], version, catalogue,
    readiness: async () => checkReadiness({
      candidate: { artifact: "fixture", configuration: "selected-commerce", environment: "disposable", database: "owned-disposable", schema: catalogue.version },
      inventoryComplete: true, loadedPackages: [{ name: "@openlup/core", version, kind: "kernel" }, { name: "@openlup/platform", version, kind: "rail", modules: ["commerce"] }],
      contributions: binding.contributions, vocabulary: [], exemptions: [],
      bindings: { ports: binding.ports, routes: binding.routes, triggers: binding.triggers, env: {} }, schemaProbe: probe,
    }),
  });
  return binding;
}

it("selects native checkout recovery, persists one reminder, replays it and preserves subscription reservations and alignment", async () => {
  const subscription = await renewal(h.pool), prepared = await prepareOriginal(h.pool, subscription);
  const held = await renewal(h.pool);
  await call(h.pool, "fulfillment_reserve_subscription_renewal", [held.operation, held.token, 900, AT]);
  const delivery = await fixture(h.pool);
  await openCase(h.pool, delivery, "protect");
  await replacement(h.pool, delivery);
  await h.pool.query("UPDATE public.commerce_settlement_intents SET status='failed' WHERE id=$1", [prepared.settlementIntentId]);
  await h.pool.query("UPDATE public.commerce_orders SET created_at=now()-interval '2 hours' WHERE id=$1", [prepared.orderId]);
  const order = randomUUID(), paid = randomUUID(), client = subscription.client;
  await h.pool.query(`INSERT INTO public.commerce_orders(id,client_id,status,created_at)
    VALUES($1,$3,'pending_payment',now()-interval '2 hours'),($2,$3,'paid',now()-interval '2 hours')`, [order, paid, client]);
  for (const id of [order, paid]) await h.pool.query(`INSERT INTO public.commerce_settlement_intents
    (order_id,channel_key,status,amount_minor,currency_code,open_idempotency_key) VALUES($1,'fixture','failed',200,'XXX',$2)`, [id, `settlement:${id}`]);
  const snapshot = async () => ({
    subscription: (await h.pool.query("SELECT * FROM public.subscriptions ORDER BY id")).rows,
    reservation: (await h.pool.query("SELECT * FROM public.fulfillment_inventory_reservations ORDER BY id")).rows,
    alignment: (await h.pool.query("SELECT * FROM public.subscription_delivery_alignment_cases ORDER BY id")).rows,
    shipments: (await h.pool.query("SELECT * FROM public.fulfillment_shipments ORDER BY id")).rows,
    orders: (await h.pool.query("SELECT * FROM public.commerce_orders WHERE id=ANY($1::uuid[]) ORDER BY id", [[order, paid, prepared.orderId]])).rows,
  });
  const before = await snapshot();
  expect(before.reservation.map(row => row.status).sort()).toEqual(["committed", "held"]);
  expect(before.subscription.every(row => row.status === "active")).toBe(true);
  expect(before.alignment).toHaveLength(1);
  const binding = await bind();
  expect(await binding.readiness()).toEqual({ kind: "ready" });
  expect(Object.keys(binding.ports)).toHaveLength(4);
  expect(await binding.services.recoveryReminders(10)).toEqual({ enqueued1h: 1, enqueued20h: 0 });
  const reminders = async () => (await h.pool.query("SELECT id,aggregate_id,idempotency_key,payload FROM public.outbox_events WHERE event_type='commerce.checkout_recovery' ORDER BY id")).rows;
  const first = await reminders();
  expect(first).toEqual([{ id: expect.any(String), aggregate_id: order, idempotency_key: `checkout_recovery:1h:${order}`,
    payload: { orderId: order, mode: "one_time", reminderHours: 1, expiresAt: expect.any(String) } }]);
  expect(await binding.services.recoveryReminders(10)).toEqual({ enqueued1h: 0, enqueued20h: 0 });
  expect(await reminders()).toEqual(first);
  await h.pool.query("UPDATE public.outbox_events SET status='processing',metadata=metadata||$2::jsonb WHERE id=$1", [first[0].id, { claimToken: "owned-claim" }]);
  expect(await binding.services.authorizeReminder({ eventId: first[0].id, claimToken: "wrong-claim" })).toEqual({ authorized: false, reason: "claim_not_active" });
  expect(await binding.services.authorizeReminder({ eventId: first[0].id, claimToken: "owned-claim" })).toEqual({ authorized: true,
    idempotencyKey: `checkout-reminder:${first[0].id}`, recipientReference: client, templateReference: "commerce-checkout-recovery" });
  expect(await snapshot()).toEqual(before);
});


it("selects abandoned reminder consent and terminal compaction with durable replay", async () => {
  const client = randomUUID(), principal = randomUUID(), order = randomUUID(), denied = randomUUID();
  await h.pool.query("INSERT INTO public.clients(id,email,principal_id) VALUES($1,$2,$3)", [client, `${client}@example.invalid`, principal]);
  await h.pool.query("INSERT INTO public.customer_communication_preferences(principal_id,marketing_newsletter_consent) VALUES($1,true)", [principal]);
  await h.pool.query(`INSERT INTO public.commerce_orders(id,client_id,status,created_at)
    VALUES($1,$3,'pending_payment',now()-interval '2 hours'),($2,$3,'pending_payment',now()-interval '2 hours')`, [order, denied, client]);
  await h.pool.query(`INSERT INTO public.commerce_order_draft_receipts(idempotency_key,request_fingerprint,order_id,response_payload)
    VALUES($1,$2,$3,'{}')`, [`draft:${order}`, "a".repeat(32), order]);
  const binding = await bind();
  expect(await binding.services.abandonedReminders(10, "")).toEqual({ enqueued1h: 1, enqueued24h: 0, enqueued72h: 0 });
  const rows = (await h.pool.query("SELECT id,aggregate_id,idempotency_key FROM public.outbox_events WHERE event_type='commerce.order_draft.abandoned.1h' ORDER BY id")).rows;
  expect(rows).toEqual([{ id: expect.any(String), aggregate_id: order, idempotency_key: `abandoned_1h:${order}` }]);
  expect(await binding.services.abandonedReminders(10, "")).toEqual({ enqueued1h: 0, enqueued24h: 0, enqueued72h: 0 });
  await h.pool.query("UPDATE public.outbox_events SET status='processing',metadata=metadata||$2::jsonb WHERE id=$1", [rows[0].id, { claimToken: "owned-claim" }]);
  expect(await binding.services.authorizeReminder({ eventId: rows[0].id, claimToken: "owned-claim" })).toMatchObject({ authorized: true });
  await h.pool.query("UPDATE public.customer_communication_preferences SET marketing_newsletter_consent=false WHERE principal_id=$1", [principal]);
  expect(await binding.services.authorizeReminder({ eventId: rows[0].id, claimToken: "owned-claim" })).toEqual({ authorized: false, reason: "abandoned_reminder_no_longer_allowed" });
  await h.pool.query("UPDATE public.outbox_events SET status='processed',processed_at=now()-interval '31 days' WHERE id=$1", [rows[0].id]);
  expect(await binding.services.pruneOutbox(10)).toEqual({ compacted: 1, processed: 1, discarded: 0 });
  expect((await h.pool.query("SELECT id,payload,metadata->>'retentionCompactedBy' AS owner FROM public.outbox_events WHERE id=$1", [rows[0].id])).rows)
    .toEqual([{ id: rows[0].id, payload: {}, owner: "commerce_outbox_compact_terminal" }]);
  expect(await binding.services.pruneOutbox(10)).toEqual({ compacted: 0, processed: 0, discarded: 0 });
});
