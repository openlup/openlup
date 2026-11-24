import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export const registrationParents = [
  "subscription_register_renewal_purchase",
  "subscription_register_renewal_purchase_with_shipping",
] as const;
export type RegistrationParent = typeof registrationParents[number];
type Database = Pool | PoolClient;

export async function seedRegistration(db: Database) {
  const clientId = randomUUID(), orderId = randomUUID();
  await db.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [clientId, `${clientId}@example.invalid`]);
  await db.query("INSERT INTO public.commerce_orders(id,client_id,currency_code,total_amount_minor) VALUES($1,$2,'XXX',0)", [orderId, clientId]);
  await db.query("SELECT public.subscription_declare_provisional_activation($1::text,$2::uuid,28,clock_timestamp())",
    [`declare:${orderId}`, orderId]);
  const clock = (await db.query(`SELECT
    to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS utc,
    to_char(at AT TIME ZONE 'Etc/GMT-2','YYYY-MM-DD"T"HH24:MI:SS.US"+02:00"') AS shifted
    FROM (SELECT clock_timestamp() AS at) instant`)).rows[0];
  const facts = {
    settlementChannelKey: "sandbox", authorizationRef: "fixture-authorization",
    unattendedChargeAuthorizedAt: String(clock.shifted), payerAccountRef: null,
    methodRef: "fixture-method", methodEvidenceRef: "fixture-evidence",
    stockSourceKey: "fixture-stock", templateId: "fixture-template", cadenceDays: 28, currency: "XXX",
    lines: [{ lineOrdinal: 1, sku: "FIXTURE-ITEM", quantity: 1, unitAmountMinor: 100 }],
    shippingAmountMinor: 0, acquisitionRef: null,
  };
  return { clientId, orderId, facts, utc: String(clock.utc) };
}

export async function registerRenewal(db: Database, parent: RegistrationParent, orderId: string, facts: unknown) {
  return (await db.query<{ receipt: { orderId: string; replayed: boolean } }>(
    `SELECT public.${parent}($1::uuid,$2::jsonb) AS receipt`, [orderId, JSON.stringify(facts)],
  )).rows[0]!.receipt;
}

export async function registrationAttachments(db: Database, orderId: string) {
  return (await db.query(`SELECT to_jsonb(a) AS attachment, xmin::text AS version
    FROM public.subscription_renewal_attachments a WHERE order_id=$1`, [orderId])).rows;
}

export async function registrationRefusal(result: Promise<unknown>) {
  try { await result; }
  catch (error) {
    const { code, message, detail, hint } = error as {
      code: string; message: string; detail?: string; hint?: string;
    };
    return { code, message, detail, hint };
  }
  throw new Error("Registration unexpectedly succeeded");
}

export function expectedRegistrationRefusal(suffix: string, code = "22023") {
  return { code, message: `subscription_renewal_purchase_${suffix}`, detail: undefined, hint: undefined };
}
