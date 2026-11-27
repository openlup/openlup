import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { seedRegistration } from "./subscriptionRegistrationFixture.js";

type Database = Pool | PoolClient;
export const entryNames = [
  "subscription_activate_from_captured_payment",
  "subscription_activate_from_captured_payment_with_edit_window",
] as const;
export const commitNames = [
  "subscription_activation_commit",
  "subscription_activation_commit_with_edit_window",
] as const;
const commitArgs = "public.subscription_activations,text,text,timestamptz,boolean";
export const entrySignatures = entryNames.map((name, index) => `public.${name}(text,uuid,text${index ? ",integer" : ""})`);
export const commitSignatures = commitNames.map((name, index) => `public.${name}(${commitArgs}${index ? ",integer" : ""})`);
export const activationUnits = [
  "public.subscription_activation__check_payment(text,uuid,text)",
  "public.subscription_activation__check_edit_window(integer)",
  `public.${commitNames[0]}__write(${commitArgs})`,
  `public.${commitNames[1]}__write(${commitArgs},integer)`,
];
export const repairName = "subscription_reconcile_paid_activation_gaps";
export const alternateFingerprint = "f".repeat(64);

export async function seedCapturedActivation(db: Database, paidAtOverride?: string) {
  const { orderId, clientId } = await seedRegistration(db);
  const { id: intentId, settled_at: paidAt } = (await db.query(`INSERT INTO public.commerce_settlement_intents
    (order_id,channel_key,status,amount_minor,currency_code,external_ref,open_idempotency_key,settled_at)
    VALUES($1::uuid,'fixture-channel','settled',1,'XXX',$1::text,'open:'||$1::text,
      COALESCE($2::timestamptz,date_trunc('milliseconds',clock_timestamp())+interval '123 microseconds'))
    RETURNING id, settled_at::text`, [orderId, paidAtOverride ?? null])).rows[0];
  await db.query("UPDATE public.commerce_orders SET status='paid',paid_at=$2::timestamptz WHERE id=$1", [orderId, paidAt]);
  return { orderId, clientId, intentId: String(intentId), paidAt: String(paidAt), key: `activate:${orderId}`,
    fingerprint: createHash("sha256").update(orderId).digest("hex") };
}

export type CapturedActivation = Awaited<ReturnType<typeof seedCapturedActivation>>;

export async function callEntry(db: Database, variant: 0 | 1, fixture: CapturedActivation,
  { key = fixture.key, orderId = fixture.orderId, fingerprint = fixture.fingerprint, hours = null }:
    { key?: string | null; orderId?: string | null; fingerprint?: string | null; hours?: number | null } = {},
  functionName: string = entryNames[variant]) {
  const values = [key, orderId, fingerprint, ...(variant ? [hours] : [])];
  return (await db.query(`SELECT public.${functionName}($1::text,$2::uuid,$3::text${variant ? ",$4::integer" : ""}) AS result`, values)).rows[0].result;
}

export async function callCommit(db: Database, variant: 0 | 1, fixture: CapturedActivation,
  { hours = null, functionName = commitNames[variant], actualRow = true }:
    { hours?: number | null; functionName?: string; actualRow?: boolean } = {}) {
  const activation = actualRow
    ? "(SELECT a FROM public.subscription_activations a WHERE a.order_id=$1::uuid)"
    : "jsonb_populate_record(NULL::public.subscription_activations,jsonb_build_object('order_id',$1::uuid,'client_id',$5::uuid,'cadence_days',28))";
  const query = `SELECT to_jsonb(public.${functionName}(${activation},$2::text,$3::text,$4::timestamptz,false${variant ? ",$" + (actualRow ? 5 : 6) + "::integer" : ""})) AS result`;
  return (await db.query(query, [fixture.orderId, fixture.key, fixture.fingerprint, fixture.paidAt,
    ...(actualRow ? [] : [fixture.clientId]), ...(variant ? [hours] : [])])).rows[0].result;
}

export async function callRepair(db: Database) {
  return (await db.query(`SELECT public.${repairName}(1::integer,clock_timestamp()) AS result`)).rows[0].result;
}

export async function activationEffects(db: Database, orderId: string) {
  return (await db.query(`SELECT a.state, a.repaired, s.edit_window_hours, c.status,
    c.scheduled_at = i.settled_at AS paid_at_exact,
    s.next_cycle_at = i.settled_at + a.cadence_days * interval '1 day' AS next_cycle_at_exact,
    extract(microseconds FROM i.settled_at)::int % 1000 AS submillisecond,
    (SELECT count(*)::int FROM public.subscription_events e WHERE e.subscription_id=s.id AND e.event_type='subscription.activated') AS events,
    r.subscription_id = s.id AS attached
    FROM public.commerce_orders o JOIN public.subscription_activations a ON a.order_id=o.id
    JOIN public.subscriptions s ON s.id=a.subscription_id
    JOIN public.subscription_cycles c ON c.id=o.subscription_cycle_id AND c.subscription_id=s.id
    JOIN public.commerce_settlement_intents i ON i.order_id=o.id
    JOIN public.subscription_renewal_attachments r ON r.order_id=o.id WHERE o.id=$1`, [orderId])).rows;
}

export function expectedActivationEffects(repaired = false, hours = 72) {
  return [{ state: "active", repaired, edit_window_hours: hours, status: "paid", paid_at_exact: true,
    next_cycle_at_exact: true, submillisecond: 123, events: 1, attached: true }];
}

export function refusal(message: string, code = "22023") {
  return { code, message, detail: undefined, hint: undefined };
}
