import { readdirSync } from "node:fs";
import type { Pool } from "pg";
import { expect } from "vitest";
import { callEntry, seedCapturedActivation } from "./subscriptionActivationFixture.js";
import { call, later, seedRenewalTerms, type Db } from "./subscriptionNativeFixture.js";

export const producer = "subscriptions__allocate_renewal_occurrence";
export const signature = `public.${producer}(uuid,uuid,text,jsonb)`;
export const utc = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
export const defaultRule = { schemaVersion: 1, deadlineRuleRef: "fixture-policy", deadlineRuleRevision: 1,
  leadSeconds: 3600, lateCancelDisposition: "hold_current" };

export function occurrenceProducerPath() {
  const directory = "db/platform/migrations";
  const files = readdirSync(directory).filter(file => /^[0-9]{14}_native_renewal_occurrence_producer\.sql$/u.test(file));
  if (files.length !== 1) throw new Error(`Expected one renewal occurrence producer migration, found ${files.length}`);
  return `${directory}/${files[0]}`;
}

export type Scope = { clientId: string | null; subscriptionId: string | null };
export const allocate = (db: Db, scope: Scope, rail: string | null = "v3", policy: unknown = defaultRule) =>
  call(db, producer, [scope.clientId, scope.subscriptionId, rail, policy]);

export async function activation(db: Db, days = 28, paidAt?: string, existingClientId?: string) {
  const f = await seedCapturedActivation(db, paidAt, existingClientId);
  await db.query("UPDATE public.subscription_activations SET cadence_days=$2 WHERE order_id=$1", [f.orderId, days]);
  const { subscriptionId } = await callEntry(db, 0, f);
  const { cycleId, due } = (await db.query(`UPDATE public.subscriptions s
    SET next_cycle_at=s.next_cycle_at+interval '24 hours' FROM public.commerce_orders o
    WHERE s.id=$1 AND o.id=$2
    RETURNING o.subscription_cycle_id AS "cycleId", to_char(s.next_cycle_at AT TIME ZONE 'UTC',${utc}) AS due`,
  [subscriptionId, f.orderId])).rows[0];
  return { ...f, subscriptionId: String(subscriptionId), cycleId: String(cycleId), due: String(due) };
}

export async function activatedRenewal(db: Db, options?: Parameters<typeof seedRenewalTerms>[2]) {
  await call(db, "subscription_delivery_alignment_set_mode", ["off"]);
  const f = await activation(db, 28, later(-29 * 24));
  return { ...f, ...await seedRenewalTerms(db, { client: f.clientId, subscription: f.subscriptionId }, options) };
}

export async function probe(db: Pool, name: string, sig: string, counter: string) {
  const { definition } = (await db.query("SELECT pg_get_functiondef($1::regprocedure) AS definition", [sig])).rows[0];
  expect(definition).toContain(`FUNCTION public.${name}(`);
  expect(definition).toMatch(/\nBEGIN\b/u);
  await db.query(`CREATE SEQUENCE public.${counter} CACHE 1;
    ${definition.replace(/\nBEGIN\b/u, `\nBEGIN\n  PERFORM nextval('public.${counter}');`)}
    ; SELECT nextval('public.${counter}');`);
  return async () => Number((await db.query(`SELECT last_value FROM public.${counter}`)).rows[0].last_value);
}
