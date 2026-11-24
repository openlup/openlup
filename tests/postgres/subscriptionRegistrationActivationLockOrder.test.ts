import type { PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { nativeHarness } from "../helpers/fulfillmentNative.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import {
  expectedRegistrationRefusal, registerRenewal, registrationAttachments, registrationParents,
  registrationRefusal, seedRegistration, type RegistrationParent,
} from "./subscriptionRegistrationFixture.js";

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
  const a = await database.pool.connect(), b = await database.pool.connect(), c = await database.pool.connect();
  let result: ReturnType<typeof registerRenewal> | undefined;
  try {
    await a.query("BEGIN");
    expect((await a.query(rows[barrier]![1], [orderId])).rowCount).toBe(1);
    await b.query("SET statement_timeout='15s'");
    const holder = (await a.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const caller = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    result = registerRenewal(b, parent, orderId, facts);
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

  it(`${parent} locks the attachment before replaying saved facts`, async () => {
    const { orderId, facts, utc } = await seedRegistration(database.pool);
    const input = { ...facts, unattendedChargeAuthorizedAt: utc };
    await database.pool.query(`INSERT INTO public.subscription_renewal_attachments(order_id,purchase_facts)
      VALUES($1,$2::jsonb)`, [orderId, JSON.stringify(input)]);
    const before = await registrationAttachments(database.pool, orderId);
    // The replay returns before the upsert, so the attachment lock must be explicit.
    await withBarrier(parent, orderId, input, 2, async c => {
      for (const [name, sql] of rows.slice(0, 2)) {
        expect(await probe(c, sql, orderId), name).toEqual({ code: "55P03" });
      }
    }, async result => {
      await expect(result).resolves.toEqual({ orderId, replayed: true });
    });
    expect(await registrationAttachments(database.pool, orderId)).toEqual(before);
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
