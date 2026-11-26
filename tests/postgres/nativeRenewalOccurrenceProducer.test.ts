import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { escapeIdentifier, type PoolClient } from "pg";
import { fixture, openCase, replacement } from "../helpers/fulfillmentNative.js";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { installAccountMutations, type AccountMutationsStore } from "./customerAccountMutations.fixture.js";
import { transaction } from "./orderMoneyV2Storage.fixture.js";
import { activation, allocate, defaultRule, probe, signature, utc } from "./nativeRenewalOccurrence.fixture.js";
import { AT, call, recordRenewalMethod, type Db } from "./subscriptionNativeFixture.js";

const confirmation = "subscription_delivery_alignment_confirm_replacement";
const carrier = "subscription_cycle_occurrences";

async function snapshot(db: Db, only?: string) {
  // Compare row bytes and MVCC versions, including outbox, delivery, stock and payment rows.
  const tables = (await db.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'
    AND ($1::text IS NULL OR tablename=$1) ORDER BY tablename`, [only ?? null])).rows;
  const { rows } = await db.query(tables.map(({ tablename }) => `SELECT '${tablename}' AS relation,
    COALESCE(jsonb_agg(jsonb_build_array(t, t.xmin::text, t.ctid::text) ORDER BY to_jsonb(t)::text),'[]') AS bytes
    FROM public.${escapeIdentifier(tablename)} t`).join(" UNION ALL "));
  return Object.fromEntries(rows.map(({ relation, bytes }) => [relation, bytes]));
}

const unavailable = (cause: string) => ({ code: "22023", message: "renewal_cycle_unavailable", detail: `/cycleKey ${cause}` });
const badRail = { code: "22023", message: "renewal_v3_unavailable", detail: "/rail" };
const badRule = { code: "22023", message: "renewal_deadline_rule_unsupported", detail: "/deadlineRuleRef" };
const forbidden = { code: "22023", message: "subscription_command_forbidden", detail: "/subscriptionId" };

async function rolledBack<T>(db: PoolClient, work: () => Promise<T>) {
  await db.query("SAVEPOINT occurrence_witness");
  try { return await work(); }
  finally { await db.query("ROLLBACK TO SAVEPOINT occurrence_witness; RELEASE SAVEPOINT occurrence_witness"); }
}

async function refuses(db: PoolClient, action: () => Promise<unknown>, error: { code: string; message: string; detail: string }) {
  const before = await snapshot(db);
  await rolledBack(db, async () => {
    await expect(action()).rejects.toMatchObject({ ...error, hint: undefined });
  });
  expect(await snapshot(db)).toEqual(before);
}

let store: AccountMutationsStore;
beforeAll(async () => { store = await installAccountMutations("legacy", false, "occurrence-producer"); }, postgresSetupTimeoutMs);
afterAll(async () => { await store?.close(); }, postgresTeardownTimeoutMs);

it.each([["legacy", 1], ["v3", 3660]] as const)("allocates and commits an exact %s occurrence at %i days", async (rail, days) => {
  const f = await transaction(store.migrator, db => activation(db, days), "COMMIT");
  const before = await snapshot(store.owner);
  const writer = await store.migrator.connect(), reader = await store.owner.connect();
  try {
    await writer.query("BEGIN");
    await rolledBack(writer, async () => { expect(await allocate(writer, f, rail)).toMatchObject({ outcome: "created" }); });
    expect(await snapshot(reader)).toEqual(before);
    const got = await allocate(writer, f, rail);
    expect(got).toEqual({ outcome: "created", clientId: f.clientId, subscriptionId: f.subscriptionId,
      cycleKey: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
      originalAnchorAt: f.due, effectiveDueAt: f.due, cadenceSeconds: days * 86400, rail, lifecycle: "active" });
    expect((await reader.query(`SELECT FROM public.${carrier} WHERE subscription_id=$1`, [f.subscriptionId])).rowCount).toBe(0);
    await writer.query("COMMIT");
    const { rows } = await reader.query(`SELECT cycle_key, subscription_id, client_id, original_anchor_at=effective_due_at AS same_due,
      to_char(original_anchor_at AT TIME ZONE 'UTC',${utc}) AS anchor, cadence_seconds::integer, rail, lifecycle, is_current,
      deadline_rule_ref, deadline_rule_revision::integer, lead_seconds::integer, late_cancel_disposition,
      cancellation_receipt_id, cancellation_effective_at, operation_id, commercial_generation_id
      FROM public.${carrier} WHERE subscription_id=$1`, [f.subscriptionId]);
    expect(rows).toEqual([{ cycle_key: got.cycleKey, subscription_id: f.subscriptionId, client_id: f.clientId, same_due: true,
      anchor: f.due, cadence_seconds: days * 86400, rail, lifecycle: "active", is_current: true, deadline_rule_ref: defaultRule.deadlineRuleRef,
      deadline_rule_revision: 1, lead_seconds: 3600, late_cancel_disposition: "hold_current",
      cancellation_receipt_id: null, cancellation_effective_at: null, operation_id: null, commercial_generation_id: null }]);
    const after = await snapshot(reader);
    expect({ ...after, [carrier]: before[carrier] }).toEqual(before);
    expect(await allocate(writer, f, rail)).toEqual({ ...got, outcome: "existing" });
    expect(await snapshot(reader)).toEqual(after);
  } finally {
    await writer.query("ROLLBACK"); writer.release(); reader.release();
  }
});

it.each([false, true])("serializes before any carrier access, first writer already allocated=%s", async firstAllocates => {
  const f = await activation(store.migrator);
  const writer = await store.migrator.connect(), follower = await store.migrator.connect();
  const laterDue = "2050-02-08T01:20:30.123456Z";
  let pending: Promise<unknown> | undefined;
  try {
    await writer.query("BEGIN");
    await writer.query("UPDATE public.subscriptions SET next_cycle_at=$2 WHERE id=$1", [f.subscriptionId, laterDue]);
    const created = firstAllocates ? await allocate(writer, f) : undefined;
    const { pid } = (await follower.query("SELECT pg_backend_pid() AS pid")).rows[0];
    pending = allocate(follower, f);
    void pending.catch(() => {});
    await expect.poll(async () => (await writer.query(`SELECT pg_backend_pid()=ANY(pg_blocking_pids($1)) AS waiting,
      EXISTS (SELECT FROM pg_locks WHERE pid=$1 AND relation='public.${carrier}'::regclass) AS carrier`, [pid])).rows[0],
    { timeout: 5000 }).toEqual({ waiting: true, carrier: false });
    const before = await snapshot(writer, carrier);
    await writer.query("COMMIT");
    const got = await pending;
    expect(got).toMatchObject({ outcome: firstAllocates ? "existing" : "created", originalAnchorAt: laterDue, effectiveDueAt: laterDue });
    if (firstAllocates) {
      expect(got).toEqual({ ...created, outcome: "existing" });
      expect(await snapshot(writer, carrier)).toEqual(before);
    }
    expect((await writer.query(`SELECT FROM public.${carrier} WHERE subscription_id=$1`, [f.subscriptionId])).rowCount).toBe(1);
  } finally { await writer.query("ROLLBACK"); await pending?.catch(() => {}); follower.release(); writer.release(); }
});

it("orders isolation, rail, and indistinguishable missing, foreign and null scope refusals", async () => {
  await transaction(store.owner, async db => {
    const f = await activation(db), other = await activation(db);
    for (const rail of [null, "", "V3"]) await refuses(db, () => allocate(db, { ...f, clientId: null }, rail), badRail);
    for (const scope of [{ ...f, clientId: null }, { ...f, clientId: other.clientId }, { ...f, subscriptionId: randomUUID() },
      { ...f, subscriptionId: null }]) await refuses(db, () => allocate(db, scope), forbidden);
  }, "ROLLBACK");
  await transaction(store.owner, async db => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await refuses(db, () => allocate(db, { clientId: null, subscriptionId: null }, null), unavailable("isolation_required"));
  }, "ROLLBACK");
});

type Subject = Awaited<ReturnType<typeof activation>>;
type Mutation = (db: PoolClient, subject: Subject) => Promise<unknown>;
const setParent = (sql: string): Mutation => (db, f) => db.query(`UPDATE public.subscriptions SET ${sql} WHERE id=$1`, [f.subscriptionId]);
const setActivation = (sql: string): Mutation => (db, f) => db.query(`UPDATE public.subscription_activations SET ${sql} WHERE order_id=$1`, [f.orderId]);
const setEvent = (sql: string): Mutation => async (db, f) => {
  // Deliberate corruption in a rolled-back fixture, pinned to the event's immutability trigger.
  await db.query("SET CONSTRAINTS ALL IMMEDIATE");
  await db.query("ALTER TABLE public.subscription_events DISABLE TRIGGER communication_subscription_source_guard");
  await db.query(`UPDATE public.subscription_events SET ${sql} WHERE subscription_id=$1`, [f.subscriptionId]);
};

const lineage: [string, Mutation, ReturnType<typeof unavailable>][] = [
  ["blocked", setParent("status='cancelled'"), { code: "22023", message: "renewal_cycle_blocked", detail: "/cycleKey" }],
  ["missing paid evidence", (db, f) => db.query("DELETE FROM public.subscription_events WHERE subscription_id=$1", [f.subscriptionId]), unavailable("unsupported_activation")],
  ["retained digest disagreement", setActivation("payment_fingerprint=repeat('f',64)"), unavailable("unsupported_activation")],
  ["competing activation", async (db, f) => {
    const other = await activation(db);
    await db.query("UPDATE public.subscription_activations SET subscription_id=$1 WHERE order_id=$2", [f.subscriptionId, other.orderId]);
  }, unavailable("unsupported_activation")],
  ["foreign order", async (db, f) => {
    const other = await activation(db);
    await db.query("UPDATE public.commerce_orders SET client_id=$2 WHERE id=$1", [f.orderId, other.clientId]);
  }, unavailable("unsupported_activation")],
  ["reactivated", async (db, f) => {
    await setParent("status='cancelled'")(db, f);
    await recordRenewalMethod(db, { client: f.clientId, subscription: f.subscriptionId });
    await db.query(`INSERT INTO public.subscription_renewal_terms(subscription_id,next_cycle_number,currency_code,stock_source_key,
      settlement_channel_key,unattended_charge_authorized_at,authorization_ref)
      VALUES($1,2,'XXX','fixture','fixture',$2,'fixture')`, [f.subscriptionId, f.paidAt]);
    const result = await call(db, "subscription_command_apply", [randomUUID(), f.clientId, randomUUID(), f.subscriptionId,
      "reactivate", { confirmedChargeTiming: true }, f.due]);
    expect(result.status, result.reason).toBe("applied");
  }, unavailable("unsupported_lineage")],
  ["backdated direct skip", async (db, f) => {
    expect(await call(db, "subscription_apply_lifecycle_action", [f.clientId, randomUUID(), f.subscriptionId, "skip_next_cycle", {},
      new Date(Date.parse(f.paidAt) - 86_400_000).toISOString()])).toMatchObject({ subscriptionAction: { status: "applied" } });
    expect((await db.query(`SELECT
      (SELECT count(*)::int FROM public.subscription_cycles WHERE subscription_id=$1 AND status='paid') AS paid,
      (SELECT count(*)::int FROM public.subscription_command_receipts WHERE subscription_id=$1) AS receipts,
      (SELECT occurred_at<$2::timestamptz FROM public.subscription_events WHERE subscription_id=$1 AND
        event_type='subscription.customer_self_service.skip_next_cycle') AS backdated`, [f.subscriptionId, f.paidAt])).rows)
      .toEqual([{ paid: 1, receipts: 0, backdated: true }]);
  }, unavailable("unsupported_lineage")],
  ["drifted parent cadence", setParent("cadence_days=29"), unavailable("invalid_activation_cadence")],
  ["zero event cadence", setEvent("payload=jsonb_set(payload,'{cadenceDays}','0')"), unavailable("invalid_activation_cadence")],
  ["string event cadence", setEvent("payload=jsonb_set(payload,'{cadenceDays}','\"28\"')"), unavailable("invalid_activation_cadence")],
  ["absent due", setParent("next_cycle_at=NULL"), unavailable("invalid_parent_schedule")],
  ["infinite due", setParent("next_cycle_at='infinity'"), unavailable("invalid_parent_schedule")],
];
it.each(lineage)("refuses %s with the exact owner diagnostic", async (_label, mutate, error) => {
  await transaction(store.owner, async db => {
    const f = await activation(db);
    await mutate(db, f);
    await refuses(db, () => allocate(db, f), error);
  }, "ROLLBACK");
});

it("rejects 3661 days even when all retained cadence facts agree", async () => {
  await transaction(store.owner, async db => {
    const f = await activation(db, 3661);
    await refuses(db, () => allocate(db, f), unavailable("invalid_activation_cadence"));
  }, "ROLLBACK");
});

async function operation(db: Db, f: Subject, at: string, terminal = false) {
  const id = randomUUID(), identity = `subscription:${f.subscriptionId}:cycle:${at}`;
  await db.query(`INSERT INTO public.subscription_renewal_operations
    (id,subscription_id,scheduled_at,cycle_number,identity_key,operation_fingerprint,cycle_snapshot,state,claim_token,claimed_by,
      claimed_at,lease_expires_at,terminal_outcome,terminal_reason,terminal_at)
    VALUES ($1,$2,$3,2,$4,repeat('a',64),'{}',CASE WHEN $5 THEN 'refused' ELSE 'claimed' END,gen_random_uuid(),'fixture',
      $3,$3::timestamptz+interval '1 hour',CASE WHEN $5 THEN 'refused' END,CASE WHEN $5 THEN 'inventory_unavailable' END,
      CASE WHEN $5 THEN $3::timestamptz END)`, [id, f.subscriptionId, at, identity, terminal]);
  return { id, identity, at };
}

type Operation = Awaited<ReturnType<typeof operation>>;
const wait = (db: Db, f: Subject, op: Operation, links?: Partial<Subject>) => db.query(`INSERT INTO public.subscription_stock_wait_cases
  (subscription_id,client_id,renewal_operation_id,scheduled_at,cycle_number,state,due_snapshot,cycle_snapshot,fingerprint,identity_key,deficits,cycle_id,order_id)
  VALUES ($1,$2,$3,$4,2,'waiting','{}','{}',repeat('a',64),$5,'[]',$6,$7)`,
[f.subscriptionId, f.clientId, op.id, op.at, op.identity, links?.cycleId ?? null, links?.orderId ?? null]);

const obligation = (db: Db, f: Subject, op: Operation, linked: Pick<Subject, "cycleId" | "orderId" | "intentId">) =>
  db.query(`INSERT INTO public.subscription_retry_obligations
    (renewal_operation_id,subscription_id,cycle_id,order_id,settlement_intent_id,logical_cycle_number,identity_key,operation_fingerprint,scheduled_at,cycle_snapshot)
    VALUES ($1,$2,$3,$4,$5,2,$6,repeat('a',64),$7,'{}')`, [op.id, f.subscriptionId, linked.cycleId, linked.orderId, linked.intentId, op.identity, op.at]);

it.each(["closed_root", "retry_obligation", "renewal_settlement", "stock_wait", "stock_reservation", "renewal_operation"])(
  "refuses a retained %s at its winning precedence on either rail", async cause => {
    await transaction(store.owner, async db => {
      const f = await activation(db);
      const op = await operation(db, f, cause === "closed_root" ? f.due : AT, ["closed_root", "stock_wait"].includes(cause));
      if (cause === "closed_root" || cause === "stock_wait") await wait(db, f, op);
      if (cause === "stock_reservation") await db.query(`INSERT INTO public.fulfillment_inventory_reservations
        (renewal_operation_id,operation_fingerprint,source_key,status,terminal_reason)
        VALUES($1,repeat('a',64),'fixture','expired','reservation_expired')`, [op.id]);
      if (cause === "renewal_settlement") await db.query(`UPDATE public.commerce_settlement_intents
        SET renewal_operation_id=$2, renewal_operation_fingerprint=repeat('a',64) WHERE id=$1`, [f.intentId, op.id]);
      if (cause === "retry_obligation") {
        const { id: cycleId } = (await db.query(`INSERT INTO public.subscription_cycles(subscription_id,scheduled_at,status,
          renewal_operation_id,renewal_operation_fingerprint) VALUES($1,$2,'payment_pending',$3,repeat('a',64)) RETURNING id`,
        [f.subscriptionId, AT, op.id])).rows[0];
        const { id: orderId } = (await db.query(`INSERT INTO public.commerce_orders(client_id,subscription_cycle_id,currency_code,total_amount_minor,
          renewal_operation_id,renewal_operation_fingerprint) VALUES($1,$2,'XXX',0,$3,repeat('a',64)) RETURNING id`,
        [f.clientId, cycleId, op.id])).rows[0];
        const { id: intentId } = (await db.query(`INSERT INTO public.commerce_settlement_intents
          (order_id,channel_key,status,amount_minor,currency_code,open_idempotency_key,renewal_operation_id,renewal_operation_fingerprint)
          VALUES($1,'fixture','failed',1,'XXX',$2,$3,repeat('a',64)) RETURNING id`, [orderId, randomUUID(), op.id])).rows[0];
        await obligation(db, f, op, { cycleId, orderId, intentId });
      }
      const readback = () => call(db, "subscription_read_renewal", [op.identity]);
      const before = await readback();
      expect(before).toMatchObject({ operationId: op.id });
      for (const rail of ["legacy", "v3"]) await refuses(db, () => allocate(db, f, rail), unavailable(cause));
      expect(await readback()).toEqual(before);
    }, "ROLLBACK");
  });

it.each(["wait cycle", "wait order", "retry cycle", "retry order", "retry intent"])(
  "refuses a foreign %s edge entering the proved activation without leaking linked IDs", async edge => {
    await transaction(store.owner, async db => {
      const f = await activation(db), other = await activation(db);
      const op = await operation(db, other, AT);
      const links = edge.endsWith("cycle") ? { cycleId: f.cycleId } : edge.endsWith("order") ? { orderId: f.orderId } : { intentId: f.intentId };
      if (edge.startsWith("wait")) await wait(db, other, op, links);
      else await obligation(db, other, op, { ...other, ...links });
      await refuses(db, () => allocate(db, f), unavailable("unsupported_lineage"));
    }, "ROLLBACK");
  });

const ruleCalls: unknown[] = [null, "null", "[]", "{}", ...[
  { extra: 1 }, { schemaVersion: "1" }, { deadlineRuleRef: " 　" }, { deadlineRuleRef: "é".repeat(101) },
  { deadlineRuleRevision: 9007199254740992 }, { deadlineRuleRevision: 1.5 }, { deadlineRuleRevision: "1" },
  { leadSeconds: -1 }, { leadSeconds: 86400 }, { leadSeconds: 1.1 }, { lateCancelDisposition: "other" },
].map(change => ({ ...defaultRule, ...change }))];
it("checks strict submitted rules, elapsed cutoffs, sticky rails and conflicting retained state in order", async () => {
  await transaction(store.owner, async db => {
    const f = await activation(db, 1), foreign = await activation(db);
    for (const rule of ruleCalls) await refuses(db, () => allocate(db, f, "v3", rule), badRule);
    await rolledBack(db, async () => {
      await setParent("next_cycle_at='0001-01-01 00:00:00+00'")(db, f);
      await refuses(db, () => allocate(db, f), badRule);
      expect(await allocate(db, f, "v3", { ...defaultRule, leadSeconds: 0, deadlineRuleRevision: Number.MAX_SAFE_INTEGER,
        deadlineRuleRef: "é".repeat(100), lateCancelDisposition: "allow_current_first_charge_if_authorized" }))
        .toMatchObject({ outcome: "created", originalAnchorAt: "0001-01-01T00:00:00.000000Z" });
    });
    for (const rail of ["legacy", "v3"]) await rolledBack(db, async () => {
      await allocate(db, f, rail);
      const opposite = rail === "legacy" ? "v3" : "legacy";
      await refuses(db, () => allocate(db, f, opposite, null), badRail);
      await refuses(db, () => allocate(db, f, rail, { ...defaultRule, leadSeconds: 0 }), unavailable("current_conflict"));
      const cases = [
        ["is_current=false, lifecycle='retired'", unavailable("noncurrent_occurrence")],
        [`client_id='${foreign.clientId}'`, unavailable("current_conflict")],
        ["cadence_seconds=86401", unavailable("invalid_retained_schedule")],
        ["effective_due_at=original_anchor_at-interval '1 second'", unavailable("invalid_retained_schedule")],
        ["original_anchor_at='0001-01-01 BC', effective_due_at='0001-01-01 BC'", unavailable("invalid_retained_schedule")],
        ["deadline_rule_ref=NULL,deadline_rule_revision=NULL,lead_seconds=NULL,late_cancel_disposition=NULL", badRule],
        ["original_anchor_at='0001-01-01Z',effective_due_at='0001-01-01Z'", badRule],
        ["cancellation_effective_at=effective_due_at", unavailable("current_conflict")],
      ] as const;
      for (const [patch, error] of cases) await rolledBack(db, async () => {
        await db.query(`UPDATE public.${carrier} SET ${patch} WHERE subscription_id=$1`, [f.subscriptionId]);
        await refuses(db, () => allocate(db, f, rail), error);
      });
      await setParent("next_cycle_at=next_cycle_at+interval '1 hour'")(db, f);
      await refuses(db, () => allocate(db, f, rail), unavailable("current_conflict"));
    });
  }, "ROLLBACK");
});

it("keeps the clamped due across DST, never stacks deliveries and never enters replacement confirmation", async () => {
  const db = store.owner;
  const f = await activation(db, 1);
  const delivery = await fixture(db), alignment = await openCase(db, delivery);
  const arrived = await replacement(db, delivery);
  await db.query("UPDATE public.fulfillment_shipments SET status='delivered',delivered_at=$2 WHERE id=$1", [arrived, AT]);
  const original = { ...delivery, order: f.orderId, shipment: randomUUID() };
  await db.query(`INSERT INTO public.fulfillment_shipments(id,order_id,port_key,provider_type,create_idempotency_key)
    SELECT $1::uuid,$2,port_key,provider_type,$1::uuid::text FROM public.fulfillment_shipments WHERE id=$3`,
  [original.shipment, f.orderId, delivery.shipment]);
  await openCase(db, original);
  expect(await call(db, "fulfillment_record_alignment_arrival", [randomUUID(), original.shipment,
    "2037-03-28T01:05:00.123456Z", "evidence:fixture-arrival"])).toEqual({ replayed: false });
  const due = "2037-03-29T01:05:00.123456Z";
  expect((await db.query(`UPDATE public.subscriptions SET status='paused' WHERE id=$1
    RETURNING to_char(next_cycle_at AT TIME ZONE 'UTC',${utc}) AS due`, [f.subscriptionId])).rows).toEqual([{ due }]);
  const sql = readFileSync("db/platform/migrations/20261129130505_native_renewal_occurrence_producer.sql", "utf8");
  expect(sql).not.toContain(confirmation);
  const body = (await db.query("SELECT prosrc FROM pg_proc WHERE oid=$1::regprocedure", [signature])).rows[0].prosrc;
  const installed = (await db.query("SELECT proname,prosrc FROM pg_proc WHERE pronamespace='public'::regnamespace")).rows;
  expect(installed.filter(({ proname }) => new RegExp(`\\b${proname}\\s*\\(`, "iu").test(body))).toEqual([]);
  expect((await db.query(`SELECT tgname FROM pg_trigger WHERE tgrelid='public.${carrier}'::regclass AND NOT tgisinternal`)).rows).toEqual([]);
  const count = await probe(db, confirmation, `public.${confirmation}(uuid,text)`, "fixture_confirmation_entries");
  expect(await count()).toBe(1);
  await transaction(db, async writer => {
    await rolledBack(writer, async () => {
      expect(await call(writer, confirmation, [alignment.id, "Verified the fixture replacement arrived"])).toMatchObject({ confirmed: true });
    });
    expect(await count()).toBe(2);
    await rolledBack(writer, () => writer.query(`DO $$ BEGIN
      PERFORM public.${confirmation}(NULL,'invalid fixture control');
      RAISE EXCEPTION 'invalid control unexpectedly succeeded';
      EXCEPTION WHEN invalid_parameter_value THEN NULL; END $$`));
    expect(await count()).toBe(3);
    for (const zone of ["UTC", "Europe/London"]) {
      await writer.query("SELECT set_config('TimeZone',$1,true)", [zone]);
      const offsets = (await writer.query(`SELECT EXTRACT(timezone FROM $1::timestamptz)::int AS due,
        EXTRACT(timezone FROM $1::timestamptz-interval '1 hour')::int AS cutoff`, [due])).rows;
      expect(offsets).toEqual([{ due: zone === "UTC" ? 0 : 3600, cutoff: 0 }]);
      const before = await snapshot(writer);
      await rolledBack(writer, async () => {
        const created = await allocate(writer, f);
        expect(created).toMatchObject({ outcome: "created", originalAnchorAt: due, effectiveDueAt: due, lifecycle: "paused" });
        await rolledBack(writer, async () => { expect(await allocate(writer, f)).toEqual({ ...created, outcome: "existing" }); });
        await refuses(writer, () => allocate(writer, f, "legacy"), badRail);
      });
      expect(await snapshot(writer)).toEqual(before);
      expect(await count()).toBe(3);
    }
  }, "ROLLBACK");
  expect(await count()).toBe(3);
});
