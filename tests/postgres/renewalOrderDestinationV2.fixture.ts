import { randomUUID } from "node:crypto";
import { canonicalCatalogDraftJson } from "@openlup/platform/catalog";
import type { Pool, PoolClient } from "pg";
import type { JourneyInstallation } from "../helpers/storeJourney.js";
import {
  bindDestinationOrder, destinationContext, destinationHash, snapshot, snapshotCommand, snapshotPreimage, testServicePin,
} from "./destinationDocumentFixture.js";
import { insert } from "./orderMoneyV2Storage.fixture.js";
import { AT, call, sandboxRenewal, type Db } from "./subscriptionNativeFixture.js";

export const registerSignature = "public.commerce_register_renewal_order_destination_v2(jsonb,uuid,uuid,uuid,jsonb,jsonb)";
export const registerName = registerSignature.split("(")[0]!.slice("public.".length);
export const checkoutSignature = "public.commerce_register_order_destination_v2(jsonb,uuid,text,uuid,uuid,jsonb,jsonb)";
type Context = Awaited<ReturnType<typeof destinationContext>>;
export type Destination = {
  binding: Awaited<ReturnType<typeof snapshot>>["binding"];
  selectionRevision: string;
  service: typeof testServicePin;
};
const digest = "a".repeat(64);
const expires = "2099-01-01T00:00:00Z";
const port = "renewal-destination-carrier";
const amount = 200;

export async function activate(db: Db, ctx: Context, order: string) {
  await insert(db, "subscription_activations", {
    order_id: order, client_id: ctx.clientId, subscription_id: ctx.scopeRef, cadence_days: 28, state: "active",
    payment_fingerprint: digest, activation_idempotency_key: randomUUID(), declare_idempotency_key: randomUUID(), activated_at: AT,
  });
}

export async function subject({ owner, runtime }: Pick<JourneyInstallation, "owner" | "runtime">) {
  const root = await sandboxRenewal(owner);
  const context = await destinationContext(owner, root.client);
  const ctx = { ...context, scopeRef: root.subscription, owner: { ...context.owner, principalKind: "customer" as const } };
  await owner.query("UPDATE public.subscriptions SET next_cycle_at=clock_timestamp()+interval '28 days' WHERE id=$1", [root.subscription]);
  await call(owner, "fulfillment_reserve_subscription_renewal", [root.operation, root.token, 900, AT]);
  const reserve = await owner.query<{ id: string }>(`UPDATE public.fulfillment_inventory_reservations
    SET expires_at=$2 WHERE renewal_operation_id=$1 RETURNING id`, [root.operation, expires]);
  const reservation = reserve.rows[0]!.id;
  const checkout = { ...ctx, scopeRef: randomUUID() };
  const { command } = snapshotCommand(checkout);
  const address = { line1: "Sample Lane", city: "Albany", countryCode: "US", subdivisionCode: "NY", postalCode: "12207" };
  const contact = { recipientName: "Sample Recipient", contactPhone: "+15550100101" };
  const nyCommand = { ...command, original: { address, contact }, validated: { ...command.validated, address, contact } };
  const issued = await snapshot(runtime, checkout, {
    ...nyCommand, requestDigest: destinationHash(canonicalCatalogDraftJson(snapshotPreimage(checkout, nyCommand))),
  });
  const origin = await bindDestinationOrder(owner, checkout, issued);
  await activate(owner, ctx, origin);
  const ny: Destination = { binding: issued.binding, selectionRevision: issued.selection.selectionRevision, service: testServicePin };
  const cycleKey = randomUUID();
  const pair = { operation_id: root.operation, commercial_generation_id: root.operation, cycle_key: cycleKey };
  await owner.query(`INSERT INTO public.subscription_cycle_occurrences(cycle_key,subscription_id,client_id,original_anchor_at,
    effective_due_at,cadence_seconds,rail,lifecycle,is_current) VALUES($1,$2,$3,$4,$4,2419200,'v3','active',true)`, [cycleKey, root.subscription, root.client, AT]);
  await insert(owner, "subscription_cycle_generations", {
    ...pair, agreement: {}, agreement_fingerprint: digest, claim_token: root.token, lease_expires_at: expires, lease_generation: 1,
  });
  await owner.query(`UPDATE public.subscription_cycle_occurrences SET operation_id=$2,commercial_generation_id=$2
    WHERE cycle_key=$1`, [cycleKey, root.operation]);
  const predecessorCycle = randomUUID();
  await insert(owner, "subscription_cycles", {
    id: predecessorCycle, subscription_id: root.subscription, scheduled_at: AT, status: "paid",
  });
  await owner.query("UPDATE public.commerce_orders SET subscription_cycle_id=$2 WHERE id=$1", [origin, predecessorCycle]);
  await insert(owner, "subscription_delivery_alignment_cases", {
    predecessor_order_id: origin, subscription_id: root.subscription, predecessor_cycle_id: predecessorCycle,
    captured_mode: "protect", state: "protected", evidence_kind: "missing_fulfillment",
  });
  await insert(owner, "subscription_cycle_delivery_assignments", { obligation_ref: origin, assigned_cycle_key: cycleKey });
  return { root, ctx, checkout, ny, origin, pair, reservation };
}

export function edit(db: Db, ctx: Context, previous: string | null,
  service = { ...testServicePin, deliverySelectionRef: "selected-west", adapterRevision: "adapter-west" }) {
  const original = {
    address: { line1: "Sample Avenue", city: "Sacramento", postalCode: "95814", countryCode: "US", subdivisionCode: "CA" },
    contact: { recipientName: "West Recipient", contactPhone: "+15550100102" },
  };
  const intent = { dialect: "subscription.destination.change.v2", subscriptionId: ctx.scopeRef, expectedTemplateVersion: 1,
    expectedSelectionRevision: previous, requestKey: randomUUID(), original };
  const requestDigest = destinationHash(canonicalCatalogDraftJson(["commerce.destination.request.v2", { ...intent, owner: ctx.owner }]));
  return call(db, "subscription_change_shipping_destination_v2", [ctx, {
    ...intent, requestDigest, service,
    validated: { ...original, classificationKeys: ["example"], policyRef: "fixture.policy", policyRevision: "r2" },
  }, new Date().toISOString()]).then(result => ({ ...result, service }));
}

export type Subject = Awaited<ReturnType<typeof subject>>;
export async function bookCycle(db: Db, f: Subject) {
  const id = randomUUID();
  await insert(db, "subscription_cycles", { id, subscription_id: f.root.subscription, scheduled_at: AT, status: "planned" });
  return id;
}

export type Target = {
  preparation: string;
  order: string;
  cycle: string;
  intent: string;
  attempt: string;
  payment: string;
  hold: string;
  opening: string;
};
export async function prepareGraph(db: PoolClient, f: Subject, selected: Destination, cycle: string, predecessor?: Target): Promise<Target> {
  await db.query("SELECT pg_advisory_xact_lock(846832106,1); LOCK TABLE public.identity_privacy_erasures IN SHARE MODE");
  await db.query("SELECT id FROM public.subscriptions WHERE id=$1 FOR UPDATE", [f.ctx.scopeRef]);
  const preparation = randomUUID(), order = randomUUID(), intent = randomUUID(), attempt = randomUUID(), payment = randomUUID();
  const binding = randomUUID(), hold = randomUUID(), evaluation = randomUUID(), calculation = randomUUID();
  const binding_seq = predecessor ? 2 : 1;
  const opening = `renewal:${f.pair.operation_id}:${binding_seq}`;
  const { binding: destinationBinding, service, selectionRevision } = selected;
  const live_evidence = { binding: destinationBinding, service, selectionRevision };
  if (predecessor) {
    await db.query("UPDATE public.subscription_cycle_preparations SET closed_unsent_at=clock_timestamp() WHERE preparation_id=$1",
      [predecessor.preparation]);
    await db.query("UPDATE public.commerce_orders SET status='cancelled' WHERE id=$1", [predecessor.order]);
    await db.query("UPDATE public.commerce_settlement_intents SET status='cancelled' WHERE id=$1", [predecessor.intent]);
    await db.query("UPDATE public.payment_provider_attempts SET status='cancelled' WHERE id=$1", [predecessor.attempt]);
    await db.query("UPDATE public.subscription_cycle_stock_holds SET state='superseded' WHERE hold_incarnation_id=$1",
      [predecessor.hold]);
  }
  await insert(db, "subscription_cycle_stock_holds", {
    ...f.pair, hold_incarnation_id: hold, reservation_id: f.reservation, expires_at: expires, state: "held",
  });
  await insert(db, "subscription_cycle_tax_issuances", {
    operation_id: f.pair.operation_id, commercial_generation_id: f.pair.commercial_generation_id,
    evaluation_id: evaluation, issued_calculation_id: calculation, request_digest: digest,
    binding_seq, hold_incarnation_id: hold, request_evidence: live_evidence,
  });
  await insert(db, "tax_calculations", { calculation_id: calculation, state: "erased" });
  await insert(db, "subscription_cycle_tax_bindings", {
    ...f.pair, binding_ref: binding, evaluation_id: evaluation, binding_seq, calculation_id: calculation,
    bind_digest: digest, accepted_money_digest: digest, payable_minor: amount, currency: "XXX",
    tax_point: AT, expires_at: expires, live_evidence,
  });
  await db.query("UPDATE public.subscription_cycle_generations SET current_binding_ref=$2,last_binding_seq=$3 WHERE cycle_key=$1",
    [f.pair.cycle_key, binding, binding_seq]);
  await insert(db, "commerce_orders", {
    id: order, client_id: f.ctx.clientId, subscription_cycle_id: cycle, status: "pending_payment", currency_code: "XXX", total_amount_minor: 0,
  });
  await insert(db, "subscription_cycle_preparations", {
    ...f.pair, preparation_id: preparation, cycle_id: cycle, binding_ref: binding, binding_seq, hold_incarnation_id: hold,
    order_id: order, settlement_intent_id: intent, payment_attempt_id: attempt, opening_key: opening,
    accepted_money_digest: digest, prepared_at: AT, replaces_preparation_id: predecessor?.preparation ?? null,
  });
  return { preparation, order, cycle, intent, attempt, payment, hold, opening };
}

export async function insertLocalAttempt(db: PoolClient, f: Subject, prepared: Target) {
  await insert(db, "commerce_settlement_intents", {
    id: prepared.intent, order_id: prepared.order, channel_key: "sandbox", status: "created",
    amount_minor: amount, currency_code: "XXX", open_idempotency_key: prepared.opening,
  });
  await insert(db, "payment_provider_states", {
    id: prepared.intent, payment_id: prepared.payment, target_kind: "subscription_cycle",
    subscription_id: f.ctx.scopeRef, subscription_cycle_id: prepared.cycle,
  });
  await insert(db, "payment_provider_attempts", {
    id: prepared.attempt, settlement_intent_id: prepared.intent, payment_id: prepared.payment, provider: "offline",
    idempotency_key: prepared.opening, amount_minor: amount, currency: "XXX",
  });
}

export const bind = (db: Db, ctx: Context, order: string | null,
  selected: Omit<Destination, "selectionRevision"> & { selectionRevision: string | null }, id: string | null = ctx.scopeRef) =>
  call(db, registerName, [ctx, order, id, selected.selectionRevision, selected.binding, selected.service]);

export async function ownerTransaction<T>(owner: Pool, work: (db: PoolClient) => Promise<T>, commit = true) {
  const db = await owner.connect();
  try {
    await db.query("BEGIN");
    const result = await work(db);
    await db.query(commit ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

export async function seedShipment(owner: Pool, order: string) {
  const shipment = randomUUID();
  await owner.query("INSERT INTO public.fulfillment_ports(port_key,provider_type,routable) VALUES($1,'3pl',true) ON CONFLICT DO NOTHING", [port]);
  await insert(owner, "fulfillment_shipments", {
    id: shipment, order_id: order, port_key: port, provider_type: "3pl", create_idempotency_key: shipment,
  });
  return shipment;
}
