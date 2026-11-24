import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nativeHarness } from "../helpers/fulfillmentNative.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import {
  expectedRegistrationRefusal, registerRenewal, registrationAttachments, registrationParents,
  registrationRefusal, seedRegistration, type RegistrationParent,
} from "./subscriptionRegistrationFixture.js";

import {
  activationEffects, callCommit, callEntry, callRepair, expectedActivationEffects,
  seedCapturedActivation, type CapturedActivation,
} from "./subscriptionActivationFixture.js";

const database = nativeHarness("renewal-registration-locks");
beforeAll(() => database.start(), postgresSetupTimeoutMs);
afterAll(() => database.stop(), postgresTeardownTimeoutMs);

const rows = [
  ["order", "SELECT id FROM public.commerce_orders WHERE id=$1 FOR UPDATE"],
  ["activation", "SELECT id FROM public.subscription_activations WHERE order_id=$1 FOR UPDATE"],
  ["attachment", "SELECT order_id FROM public.subscription_renewal_attachments WHERE order_id=$1 FOR UPDATE"],
] as const;

async function probe(db: PoolClient, sql: string, orderId: string) {
  await db.query("BEGIN");
  try { return { count: (await db.query(`${sql} NOWAIT`, [orderId])).rowCount }; }
  catch (error) { return { code: (error as { code: string }).code }; }
  finally { await db.query("ROLLBACK"); }
}

async function withBarrier<T>(
  parent: RegistrationParent, orderId: string, facts: unknown, barrier: number,
  observe: (db: PoolClient) => Promise<void>, complete: (result: ReturnType<typeof registerRenewal>) => Promise<T>,
) {
  return withRowBarrier(rows[barrier]![1], orderId, b => registerRenewal(b, parent, orderId, facts), observe, complete);
}

async function withRowBarrier<T, R>(lock: string, key: string, call: (db: PoolClient) => Promise<R>,
  observe: (db: PoolClient) => Promise<void>, complete: (result: Promise<R>) => Promise<T>) {
  const a = await database.pool.connect(), b = await database.pool.connect(), c = await database.pool.connect();
  let result: Promise<R> | undefined;
  try {
    await a.query("BEGIN");
    expect((await a.query(lock, [key])).rowCount).toBe(1);
    await b.query("SET statement_timeout='15s'");
    const holder = (await a.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const caller = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    result = call(b);
    // Keep a rejected call observed while waiting for the lock.
    void result.catch(() => {});
    let blockers: number[] = [];
    for (let n = 0; n < 500; n++) {
      blockers = (await a.query("SELECT pg_blocking_pids($1::int) AS pids", [caller])).rows[0].pids;
      if (blockers.includes(holder)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(blockers).toContain(holder);
    await observe(c);
    await a.query("ROLLBACK");
    return await complete(result);
  } finally {
    try {
      await a.query("ROLLBACK");
      await result?.catch(() => {});
      await b.query("RESET statement_timeout");
    } finally { a.release(); b.release(); c.release(); }
  }
}

for (const parent of registrationParents) {
  it.each(rows.map(([name], index) => ({ name, index })))(`${parent} holds exactly the rows before the $name barrier`, async ({ index }) => {
    const { orderId, facts, utc } = await seedRegistration(database.pool);
    await database.pool.query("INSERT INTO public.subscription_renewal_attachments(order_id) VALUES($1)", [orderId]);
    await withBarrier(parent, orderId, facts, index, async c => {
      for (const [rowIndex, [name, sql]] of rows.entries()) {
        if (index === rowIndex) continue;
        expect(await probe(c, sql, orderId), name).toEqual(rowIndex < index ? { code: "55P03" } : { count: 1 });
      }
    }, async result => {
      await expect(result).resolves.toEqual({ orderId, replayed: false });
    });
    const authorizedAt = parent === registrationParents[0] ? facts.unattendedChargeAuthorizedAt : utc;
    expect(await registrationAttachments(database.pool, orderId)).toMatchObject([{
      attachment: { order_id: orderId, subscription_id: null, completed_at: null,
        purchase_facts: { ...facts, unattendedChargeAuthorizedAt: authorizedAt } },
    }]);
  }, 25_000);

  it(`${parent} sees committed method deactivation after waiting for the declaration`, async () => {
    const { clientId, orderId, facts } = await seedRegistration(database.pool);
    const method = (await database.pool.query(`INSERT INTO public.payment_method_refs
      (client_id,provider_kind,method_kind,provider_method_ref,status,active,expires_at)
      VALUES($1,'fixture-rail','card',$2,'active',true,clock_timestamp()+interval '1 hour') RETURNING id`, [clientId, orderId])).rows[0].id;
    const input = { ...facts, settlementChannelKey: "fixture-rail", methodRef: orderId, methodEvidenceRef: method };
    await database.pool.query("INSERT INTO public.subscription_renewal_attachments(order_id) VALUES($1)", [orderId]);
    const before = await registrationAttachments(database.pool, orderId);
    await withBarrier(parent, orderId, input, 1, async c => {
      expect(await probe(c, rows[0][1], orderId)).toEqual({ code: "55P03" });
      expect(await probe(c, rows[2][1], orderId)).toEqual({ count: 1 });
      expect((await c.query("UPDATE public.payment_method_refs SET status='inactive',active=false WHERE id=$1 AND active", [method])).rowCount).toBe(1);
    }, async result => {
      expect(await registrationRefusal(result)).toEqual(expectedRegistrationRefusal("invalid"));
    });
    expect(await registrationAttachments(database.pool, orderId)).toEqual(before);
  }, 25_000);
}

const activationLocks = {
  order: rows[0][1],
  activation: rows[1][1],
  attachment: rows[2][1],
  client: "SELECT id FROM public.clients WHERE id=$1 FOR UPDATE",
  settlement: "SELECT id FROM public.commerce_settlement_intents WHERE id=$1 FOR UPDATE",
};
type ActivationRow = keyof typeof activationLocks;
const entryBarriers = ["order", "activation", "settlement", "client", "attachment"] as const;
const commitBarriers = ["client", "order", "activation", "attachment"] as const;
const repairBarriers = ["activation", "client", "order", "attachment"] as const;
const variants = [0, 1] as const;
const activationPaths = [
  ...variants.map(variant => ({ name: variant ? "Ew" : "E", barriers: entryBarriers, untouched: [],
    call: (db: PoolClient, fixture: CapturedActivation) => callEntry(db, variant, fixture),
    result: { state: "active", replayed: false }, repaired: false })),
  ...variants.map(variant => ({ name: variant ? "Cw" : "C", barriers: commitBarriers, untouched: ["settlement" as const],
    call: (db: PoolClient, fixture: CapturedActivation) => callCommit(db, variant, fixture),
    result: { state: "active", repaired: false }, repaired: false })),
  { name: "gap repair", barriers: repairBarriers, untouched: ["settlement" as const], call: callRepair,
    result: { repaired: 1, overdue: 0 }, repaired: true },
];
const trace = [
  ["subscriptions", "INSERT"], ["subscription_cycles", "INSERT"], ["commerce_orders", "UPDATE"],
  ["subscription_activations", "UPDATE"], ["subscription_events", "INSERT"], ["subscription_renewal_attachments", "UPDATE"],
] as const;

describe("native activation transaction lock and write order", () => {
  beforeAll(async () => {
    await database.pool.query(`CREATE TABLE public.activation_trace (
      position bigint GENERATED ALWAYS AS IDENTITY, relation_name text, operation text);
      CREATE FUNCTION public.record_activation_trace() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO public.activation_trace(relation_name,operation) VALUES(TG_TABLE_NAME,TG_OP);
        RETURN NULL;
      END; $$;`);
    for (const [relation, operation] of trace) {
      await database.pool.query(`CREATE TRIGGER activation_trace AFTER ${operation} ON public.${relation}
        FOR EACH ROW EXECUTE FUNCTION public.record_activation_trace()`);
    }
  });

  for (const path of activationPaths) {
    it.each(path.barriers.slice())(`${path.name} holds exactly the rows before the %s barrier`, async barrier => {
      const fixture = await seedCapturedActivation(database.pool);
      await database.pool.query("INSERT INTO public.subscription_renewal_attachments(order_id) VALUES($1)", [fixture.orderId]);
      await database.pool.query("TRUNCATE public.activation_trace");
      const keys: Record<ActivationRow, string> = { order: fixture.orderId, activation: fixture.orderId,
        attachment: fixture.orderId, settlement: fixture.intentId, client: fixture.clientId };
      const barriers: readonly ActivationRow[] = path.barriers;
      const index = barriers.indexOf(barrier);
      await withRowBarrier(activationLocks[barrier], keys[barrier], b => path.call(b, fixture), async c => {
        for (const name of [...barriers, ...path.untouched]) {
          if (name === barrier) continue;
          const position = barriers.indexOf(name);
          expect(await probe(c, activationLocks[name], keys[name]), name)
            .toEqual(position >= 0 && position < index ? { code: "55P03" } : { count: 1 });
        }
      }, async result => {
        await expect(result).resolves.toMatchObject(path.result);
      });
      expect(await activationEffects(database.pool, fixture.orderId)).toEqual(expectedActivationEffects(path.repaired));
      expect((await database.pool.query("SELECT relation_name,operation FROM public.activation_trace ORDER BY position")).rows)
        .toEqual(trace.map(([relation_name, operation]) => ({ relation_name, operation })));
    }, 25_000);
  }
});
