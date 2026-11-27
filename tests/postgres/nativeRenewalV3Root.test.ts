import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { expect, it, vi } from "vitest";
import { fixture, openCase, replacement } from "../helpers/fulfillmentNative.js";
import { postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { probe, utc } from "./nativeRenewalOccurrence.fixture.js";
import { args, canonical, generations, incumbentRoot, installOccurrenceStore, lock, occurrence, operations,
  read, rootFixture, sha256, writer, type RootFixture } from "./nativeRenewalOccurrenceWriter.fixture.js";
import { rejected, transaction } from "./orderMoneyV2Storage.fixture.js";
import { call, type Db } from "./subscriptionNativeFixture.js";

const error = (message: string, detail: string, code = "22023") => ({ code, message, detail });
const unavailable = (field: string) => error("renewal_cycle_unavailable", field);
const blocked = error("renewal_cycle_blocked", "/cycleKey");
const mismatch = error("catalog_acceptance_snapshot_mismatch", "/agreementFingerprint");
const conflict = error("subscription_renewal_claim_idempotency_conflict", "/agreementFingerprint", "23505");
const stale = error("renewal_claim_stale", "/commercialGenerationId", "40001");
const claim = (db: Db, f: RootFixture, values = args(f)) => call(db, writer, values);
const changed = (f: RootFixture, index: number, value: string | number | null) => args(f).map((arg, i) => i === index ? value : arg);
const selected = (db: Db, f: RootFixture) => call(db, read, f.scope);
const snapshot = (db: Db, f: RootFixture) => db.query(`SELECT to_jsonb(c) AS occurrence,to_jsonb(o) AS root,
  to_jsonb(g) AS generation,c.xmin::text AS occurrence_version,o.xmin::text AS root_version,g.xmin::text AS generation_version
  FROM public.${occurrence} c LEFT JOIN public.${operations} o ON o.id=c.operation_id
  LEFT JOIN public.${generations} g ON g.cycle_key=c.cycle_key AND g.operation_id=c.operation_id
  WHERE c.cycle_key=$1`, [f.cycleKey]).then(r => r.rows[0]);
async function unselected(db: Db, f: RootFixture) {
  expect(await selected(db, f)).toMatchObject({ operationId: null, commercialGenerationId: null });
  expect((await db.query(`SELECT id FROM public.${operations} WHERE subscription_id=$1
    UNION ALL SELECT operation_id FROM public.${generations} WHERE cycle_key=$2`, [f.subscriptionId, f.cycleKey])).rows).toEqual([]);
}

async function expectShiftedRoot(db: Db, f: RootFixture) {
  expect((await db.query(`SELECT o.scheduled_at=c.original_anchor_at AS anchored,
    c.effective_due_at>c.original_anchor_at AS shifted,o.identity_key
    FROM public.${occurrence} c JOIN public.${operations} o ON o.id=c.operation_id WHERE c.cycle_key=$1`, [f.cycleKey])).rows)
    .toEqual([{ anchored: true, shifted: true, identity_key: `subscription:${f.subscriptionId}:renewal-v3:${f.cycleKey}` }]);
}

const effectTables = ["subscriptions", "subscription_cycles", "commerce_orders", "commerce_settlement_intents",
  "fulfillment_inventory_reservations", "subscription_cycle_stock_holds", "subscription_cycle_preparations",
  "subscription_cycle_tax_bindings", "subscription_cycle_tax_issuances", "subscription_cycle_payment_attempts",
  "payment_provider_attempts", "payment_simulator_attempts", "transactional_delivery_receipts",
  "communication_recipient_consents", "outbox_events"];
const effects = (db: Db, tables = effectTables) => Promise.all(tables.map(table =>
  db.query(`SELECT to_jsonb(t) AS row FROM public.${table} t ORDER BY to_jsonb(t)`).then(r => r.rows)));

async function savepoint(db: PoolClient, work: () => Promise<unknown>) {
  await db.query("SAVEPOINT witness");
  try { await work(); }
  finally { await db.query("ROLLBACK TO SAVEPOINT witness; RELEASE SAVEPOINT witness"); }
}

const rootTest = it.extend("owner", async ({ onTestFinished }) => {
  const store = await installOccurrenceStore("legacy");
  onTestFinished(store.close);
  return store.migrator;
});
rootTest.for([30, 3600])("commits the equal pair and one %i-second lease after the producer commit", { timeout: postgresSetupTimeoutMs }, async (lease, { owner }) => {
  const f = await rootFixture(owner);
  await owner.query(`UPDATE public.${occurrence} SET effective_due_at=original_anchor_at+interval '1 day' WHERE cycle_key=$1`, [f.cycleKey]);
  const before = await snapshot(owner, f);
  const outside = await effects(owner), values = args(f, f.agreement, lease), { operationId } = f.agreement;
  await expect(transaction(owner, async db => {
    await db.query("SET CONSTRAINTS public.cycle_occurrence_selected_pair_fkey IMMEDIATE");
    return claim(db, f, values);
  })).rejects.toMatchObject({ code: "23503", constraint: "cycle_occurrence_selected_pair_fkey" });
  expect(await effects(owner)).toEqual(outside);
  await expect(transaction(owner, async db => {
    await db.query(`CREATE FUNCTION pg_temp.refuse_generation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
      BEGIN
        IF NOT EXISTS (SELECT FROM public.${operations} o JOIN public.${occurrence} c
          ON c.operation_id=o.id AND c.commercial_generation_id=o.id WHERE o.id=NEW.operation_id AND c.cycle_key=NEW.cycle_key)
        THEN RAISE EXCEPTION 'missing earlier writes'; END IF;
        RAISE EXCEPTION 'generation failure witness';
      END $$;
      CREATE TRIGGER refuse_generation BEFORE INSERT ON public.${generations}
      FOR EACH ROW EXECUTE FUNCTION pg_temp.refuse_generation()`);
    return claim(db, f, values);
  })).rejects.toMatchObject({ message: "generation failure witness" });
  await unselected(owner, f);
  expect(await snapshot(owner, f)).toEqual(before);
  expect(await effects(owner)).toEqual(outside);
  const created = await transaction(owner, async db => {
    await db.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    return claim(db, f, values);
  });
  const agreementFingerprint = sha256(canonical(f.agreement));
  expect(created).toEqual({ outcome: "created", clientId: f.clientId, subscriptionId: f.subscriptionId, cycleKey: f.cycleKey,
    originalAnchorAt: f.originalAnchorAt, operationId, commercialGenerationId: operationId, agreementFingerprint,
    agreement: f.agreement, claimToken: expect.stringMatching(/^[a-f\d-]{36}$/u),
    leaseExpiresAt: expect.stringMatching(/T\d\d:\d\d:\d\d\.\d{6}Z$/u) });
  const durable = await snapshot(owner, f);
  await expectShiftedRoot(owner, f);
  expect(await effects(owner)).toEqual(outside);
  expect(durable.occurrence).toEqual({ ...before.occurrence, operation_id: operationId, commercial_generation_id: operationId });
  expect(durable.root).toMatchObject({ id: operationId, subscription_id: f.subscriptionId, cycle_number: f.cycleNumber,
    identity_key: `subscription:${f.subscriptionId}:renewal-v3:${f.cycleKey}`, operation_fingerprint: agreementFingerprint,
    cycle_snapshot: { ...f.agreement, frozenFingerprint: agreementFingerprint }, state: "claimed", claimed_by: "fixture",
    claim_generation: 1, claim_token: created.claimToken, catalog_acceptance: null, catalog_acceptance_fingerprint: null,
    attempt_prepared_at: null, external_attempt_ref: null, terminal_outcome: null, terminal_at: null });
  expect(durable.generation).toMatchObject({ cycle_key: f.cycleKey, operation_id: operationId, commercial_generation_id: operationId,
    agreement: f.agreement, agreement_fingerprint: agreementFingerprint, claim_token: created.claimToken, lease_generation: 1,
    last_binding_seq: 0, current_binding_ref: null, first_failure_at: null, failure_cause: null, failure_count: null, next_eligible_at: null });
  expect((await owner.query(`SELECT o.created_at=o.updated_at AND o.created_at=o.claimed_at AND o.lease_expires_at=g.lease_expires_at
    AND o.lease_expires_at=o.claimed_at+make_interval(secs=>$2) AND o.scheduled_at=c.original_anchor_at
    AND o.claimed_at>=c.effective_due_at AS correct,to_char(o.lease_expires_at AT TIME ZONE 'UTC',${utc}) AS expiry
    FROM public.${operations} o JOIN public.${generations} g ON g.operation_id=o.id
    JOIN public.${occurrence} c USING(cycle_key) WHERE o.id=$1`, [operationId, lease])).rows)
    .toEqual([{ correct: true, expiry: created.leaseExpiresAt }]);
  expect(await selected(owner, f)).toEqual(await call(owner, lock, f.scope));
  const replay = { ...created, outcome: "existing", claimToken: null, leaseExpiresAt: null };
  expect(await claim(owner, f)).toEqual(replay);
  await expectShiftedRoot(owner, f);
  expect(await snapshot(owner, f)).toEqual(durable);
  await owner.query(`UPDATE public.${occurrence} SET effective_due_at=clock_timestamp()+interval '1 day' WHERE cycle_key=$1`, [f.cycleKey]);
  await owner.query(`UPDATE public.${generations} SET claim_token=$2,lease_generation=2,lease_expires_at='2004-03-02Z' WHERE cycle_key=$1`,
    [f.cycleKey, randomUUID()]);
  const rotated = await snapshot(owner, f);
  for (const [index, value] of [[4, f.cycleNumber + 1], [5, "{"], [5, " " + canonical(f.agreement)], [5, null], [6, "0".repeat(64)], [6, null]] as const) {
    await expect(claim(owner, f, changed(f, index, value))).rejects.toMatchObject(conflict);
    expect(await claim(owner, f)).toEqual(replay);
    expect(await snapshot(owner, f)).toEqual(rotated);
  }
  for (const [table, patch] of [[operations, "cycle_number=cycle_number+1"], [operations, "cycle_snapshot=cycle_snapshot||'{\"extra\":true}'"],
    [operations, "operation_fingerprint=repeat('1',64)"], [generations, "agreement_fingerprint=repeat('2',64)"],
    [generations, "agreement=agreement||'{\"extra\":true}'"]] as const) {
    await transaction(owner, async db => {
      await db.query(`UPDATE public.${table} SET ${patch} WHERE ${table === operations ? "id" : "operation_id"}=$1`, [operationId]);
      expect(await selected(db, f)).toMatchObject({ operationId });
      await expect(claim(db, f)).rejects.toMatchObject(conflict);
    }, "ROLLBACK");
  }
  await transaction(owner, async db => {
    const agreement = { ...f.agreement, cadenceSeconds: 604800 };
    const request = args(f, agreement), fingerprint = request[6];
    await db.query(`UPDATE public.${operations} SET cycle_snapshot=$2,operation_fingerprint=$3 WHERE id=$1`,
      [operationId, { ...agreement, frozenFingerprint: fingerprint }, fingerprint]);
    await db.query(`UPDATE public.${generations} SET agreement=$2,agreement_fingerprint=$3 WHERE cycle_key=$1`, [f.cycleKey, agreement, fingerprint]);
    expect(await selected(db, f)).toMatchObject({ operationId });
    await expect(claim(db, f, request)).rejects.toMatchObject(conflict);
  }, "ROLLBACK");
  expect(await effects(owner)).toEqual(outside);
});

rootTest("refuses a fresh agreement with only the digest wrong", async ({ owner }) => {
  const f = await rootFixture(owner), before = await snapshot(owner, f), outside = await effects(owner);
  const wrongDigest = "0".repeat(64);
  expect(args(f)[6]).not.toBe(wrongDigest);
  await expect(claim(owner, f, changed(f, 6, wrongDigest))).rejects.toMatchObject(mismatch);
  expect(await snapshot(owner, f)).toEqual(before);
  await unselected(owner, f);
  expect(await effects(owner)).toEqual(outside);
  expect(await claim(owner, f)).toMatchObject({ outcome: "created" });
}, postgresSetupTimeoutMs);

rootTest("uses the ordered scope, eligibility, counter and agreement refusals without effects", async ({ owner: db }) => {
  const f = await rootFixture(db), legacy = await rootFixture(db, "legacy");
  for (const [index, value, match] of [
    [0, "not-a-uuid", { code: "22P02" }], [4, "2147483648", { code: "22003" }],
    [3, null, error("subscription_renewal_claim_invalid_input", "/operationId")],
    [4, 0, error("subscription_renewal_claim_invalid_input", "/cycleNumber")],
    [7, " \t\n", error("subscription_renewal_claim_invalid_input", "/workerId")],
    [7, "\u00a0", error("subscription_renewal_claim_invalid_input", "/workerId")],
    ...[29, 3601, null].map(value => [8, value, error("subscription_renewal_claim_invalid_input", "/leaseSeconds")] as const),
    [0, legacy.clientId, error("subscription_command_forbidden", "/subscriptionId")],
    [2, randomUUID(), unavailable("/cycleKey")], [2, legacy.cycleKey, unavailable("/cycleKey")], [2, null, unavailable("/cycleKey")],
    [4, f.cycleNumber + 1, error("renewal_agreement_unavailable", "/agreement")], [5, "{", mismatch],
  ] as const) await expect(claim(db, f, changed(f, index, value))).rejects.toMatchObject(match);
  const invalid = args(f); invalid.splice(3, 6, null, 0, "{", null, "", 29);
  await expect(claim(db, f, invalid)).rejects.toMatchObject(error("subscription_renewal_claim_invalid_input", "/operationId"));
  const foreign = changed(f, 0, legacy.clientId); foreign[5] = "{";
  await expect(claim(db, f, foreign)).rejects.toMatchObject(error("subscription_command_forbidden", "/subscriptionId"));
  await expect(claim(db, legacy)).rejects.toMatchObject(error("renewal_v3_unavailable", "/rail"));
  for (const [entry, values] of [[lock, f.scope], [writer, args(f)]] as const) {
    await expect(transaction(db, tx =>
      tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ").then(() => call(tx, entry, values))))
      .rejects.toMatchObject(unavailable("/cycleKey"));
  }
  const { cadence, templateSnapshot } = f.agreement;
  for (const patch of [{ catalogAcceptance: [] }, { templateSnapshot: { ...templateSnapshot, version: "1" } },
    { clientId: legacy.clientId }, { originalAnchorAt: "2004-03-02T12:00:00.123456Z" },
    { cadenceSeconds: 604800 }, { frozenFingerprint: "a".repeat(64) }, { cadence: { ...cadence, kind: "calendar_months" } },
    { cadence: { ...cadence, surplus: true } }, { cadence: { days: 7, kind: "fixed_days" } },
    ...[0, 7.5, "7", 3661].map(days => ({ cadence: { ...cadence, days } })),
    { templateSnapshot: { ...templateSnapshot, cadenceDays: 8 } },
    { cadence: { ...cadence, days: 8 }, templateSnapshot: { ...templateSnapshot, cadenceDays: 8 } },
  ]) await expect(claim(db, f, args(f, { ...f.agreement, ...patch })), JSON.stringify(patch)).rejects.toMatchObject(mismatch);
  for (const [target, patch, match] of [
    ["parent", "status='paused'", blocked], ["cycle", "cancellation_effective_at=effective_due_at", blocked],
    ["cycle", "effective_due_at=clock_timestamp()+interval '1 day'", blocked], ["cycle", "lifecycle='stopped'", blocked],
    ["cycle", "effective_due_at=original_anchor_at-interval '1 second'", unavailable("/effectiveDueAt")],
    ["cycle", "deadline_rule_ref=NULL,deadline_rule_revision=NULL,lead_seconds=NULL,late_cancel_disposition=NULL",
      error("renewal_deadline_rule_unsupported", "/deadlineRuleRef")],
  ] as const) await transaction(db, async tx => {
    await tx.query(target === "parent" ? `UPDATE public.subscriptions SET ${patch} WHERE id=$1`
      : `UPDATE public.${occurrence} SET ${patch} WHERE cycle_key=$1`, [target === "parent" ? f.subscriptionId : f.cycleKey]);
    await expect(claim(tx, f), patch).rejects.toMatchObject(match);
  }, "ROLLBACK");
  await unselected(db, f);
  for (const collision of ["original anchor", "derived identity"]) {
    const test = await rootFixture(db), incumbent = await incumbentRoot(db, test);
    const identity = `subscription:${test.subscriptionId}:renewal-v3:${test.cycleKey}`;
    await db.query(`UPDATE public.${operations} SET state='refused',terminal_outcome='refused',terminal_at=clock_timestamp() WHERE id=$1`, [incumbent.operationId]);
    if (collision === "derived identity") await db.query(`UPDATE public.${operations}
      SET scheduled_at=scheduled_at+interval '1 hour',identity_key=$2 WHERE id=$1`, [incumbent.operationId, identity]);
    await db.query(`UPDATE public.${occurrence} SET effective_due_at=effective_due_at+interval '1 day' WHERE cycle_key=$1`, [test.cycleKey]);
    expect((await db.query(`SELECT o.scheduled_at=c.original_anchor_at AS anchor,o.identity_key=$3 AS identity,
      s.status='active' AND c.is_current AND c.lifecycle='active' AND c.cancellation_effective_at IS NULL
        AND c.effective_due_at<clock_timestamp() AND c.effective_due_at<>c.original_anchor_at AS eligible
      FROM public.${operations} o, public.${occurrence} c JOIN public.subscriptions s ON s.id=c.subscription_id
      WHERE o.id=$1 AND c.cycle_key=$2`, [incumbent.operationId, test.cycleKey, identity])).rows, collision)
      .toEqual([{ anchor: collision === "original anchor", identity: collision === "derived identity", eligible: true }]);
    const before = await snapshot(db, test);
    await expect(claim(db, test, changed(test, 4, test.cycleNumber + 1))).rejects.toMatchObject(error("renewal_agreement_unavailable", "/agreement"));
    await expect(claim(db, test, changed(test, 5, "{"))).rejects.toMatchObject(mismatch);
    await expect(claim(db, test), collision).rejects.toMatchObject(blocked);
    expect(await snapshot(db, test)).toEqual(before);
    expect((await db.query(`SELECT id FROM public.${operations} WHERE subscription_id=$1`, [test.subscriptionId])).rows)
      .toEqual([{ id: incumbent.operationId }]);
    await db.query(`DELETE FROM public.${operations} WHERE id=$1`, [incumbent.operationId]);
    expect(await claim(db, test)).toMatchObject({ outcome: "created" });
    await expectShiftedRoot(db, test);
  }
}, postgresSetupTimeoutMs);

rootTest("serializes exact replay, competing selection and due changes at the parent fence", async ({ owner }) => {
  const follower = await owner.connect();
  try {
    const { pid } = (await follower.query("SELECT pg_backend_pid() AS pid")).rows[0];
    const waitForParent = (tx: PoolClient) => expect.poll(async () =>
      (await tx.query("SELECT pg_backend_pid()=ANY(pg_blocking_pids($1)) AS waiting", [pid])).rows[0].waiting).toBe(true);
    for (const competing of [false, true]) {
      const f = await rootFixture(owner);
      const other = competing ? randomUUID() : f.agreement.operationId;
      const values = args(f, { ...f.agreement, operationId: other, commercialGenerationId: other });
      values[3] = other;
      let contender!: Promise<unknown>;
      const first = await transaction(owner, async tx => {
        const created = await claim(tx, f);
        contender = claim(follower, f, values).catch((reason: unknown) => reason);
        await waitForParent(tx);
        return created;
      });
      expect(first).toMatchObject({ outcome: "created", operationId: f.agreement.operationId });
      expect(await contender).toMatchObject(competing ? stale : { outcome: "existing", operationId: other, claimToken: null, leaseExpiresAt: null });
      const { operationId, claimToken, leaseExpiresAt } = first;
      expect(claimToken).toMatch(/^[a-f\d-]{36}$/u);
      expect(leaseExpiresAt).toMatch(/\.\d{6}Z$/u);
      expect((await owner.query(`SELECT id,claim_token AS token,claim_generation::text AS lease,
        to_char(lease_expires_at AT TIME ZONE 'UTC',${utc}) AS expiry
        FROM public.${operations} WHERE subscription_id=$1 OR id=$2`, [f.subscriptionId, other])).rows)
        .toEqual([{ id: operationId, token: claimToken, lease: "1", expiry: leaseExpiresAt }]);
      expect((await owner.query(`SELECT operation_id,commercial_generation_id,claim_token AS token,lease_generation::text AS lease,
        to_char(lease_expires_at AT TIME ZONE 'UTC',${utc}) AS expiry
        FROM public.${generations} WHERE cycle_key=$1 OR operation_id IN
          (SELECT id FROM public.${operations} WHERE subscription_id=$2)`, [f.cycleKey, f.subscriptionId])).rows)
        .toEqual([{ operation_id: operationId, commercial_generation_id: operationId, token: claimToken, lease: "1", expiry: leaseExpiresAt }]);
      expect(await selected(owner, f)).toMatchObject({ operationId, commercialGenerationId: operationId });
    }
    for (const postpone of [false, true]) {
      const f = await rootFixture(owner);
      let contender!: Promise<unknown>;
      await transaction(owner, async tx => {
        await tx.query("SELECT 1 FROM public.subscriptions WHERE id=$1 FOR UPDATE", [f.subscriptionId]);
        const { due } = (await tx.query(`UPDATE public.${occurrence}
          SET effective_due_at=clock_timestamp()+CASE WHEN $2 THEN interval '1 year' ELSE interval '600 milliseconds' END
          WHERE cycle_key=$1 RETURNING to_char(effective_due_at AT TIME ZONE 'UTC',${utc}) AS due`, [f.cycleKey, postpone])).rows[0];
        contender = claim(follower, f).catch((reason: unknown) => reason);
        await waitForParent(tx);
        if (!postpone) {
          expect((await tx.query("SELECT clock_timestamp()<$1::timestamptz AS before_due", [due])).rows).toEqual([{ before_due: true }]);
          await tx.query("SELECT pg_sleep(greatest(0,extract(epoch FROM $1::timestamptz-clock_timestamp())))", [due]);
        }
      });
      expect(await contender).toMatchObject(postpone ? blocked : { outcome: "created" });
      if (postpone) await unselected(owner, f);
      else await expectShiftedRoot(owner, f);
    }
  } finally { follower.release(); }
}, postgresSetupTimeoutMs);

rootTest("refuses a root UUID committed after the precheck and allows both IDs to be rebound", async ({ owner }) => {
  const coordinator = await owner.connect();
  try {
    const loser = await rootFixture(owner), winner = await rootFixture(owner), id = winner.agreement.operationId;
    const colliding = args(loser, { ...loser.agreement, operationId: id, commercialGenerationId: id });
    colliding[3] = id;
    await owner.query(`CREATE SEQUENCE public.fixture_collision_reached CACHE 1;
      CREATE FUNCTION public.fixture_collision_wait() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
      BEGIN
        IF NEW.subscription_id='${loser.subscriptionId}'::uuid AND NEW.id='${id}'::uuid THEN
          PERFORM nextval('public.fixture_collision_reached');
          PERFORM pg_advisory_xact_lock(10101);
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fixture_collision_wait BEFORE INSERT ON public.${operations}
        FOR EACH ROW EXECUTE FUNCTION public.fixture_collision_wait()`);
    await coordinator.query("SELECT pg_advisory_lock(10101)");
    const before = await snapshot(owner, loser);
    const refusal = rejected(claim(owner, loser, colliding));
    try {
      await vi.waitFor(async () => {
        expect((await coordinator.query("SELECT is_called FROM public.fixture_collision_reached")).rows).toEqual([{ is_called: true }]);
      });
      expect(await claim(coordinator, winner)).toMatchObject({ outcome: "created" });
    } finally { await coordinator.query("SELECT pg_advisory_unlock(10101)"); }
    for (const failure of [await refusal, await rejected(claim(owner, loser, colliding))])
      expect(failure).toMatchObject(unavailable("/operationId"));
    expect(await snapshot(owner, loser)).toEqual(before);
    await unselected(owner, loser);
    const rebound = await claim(owner, loser);
    expect(rebound).toMatchObject({ outcome: "created", operationId: loser.agreement.operationId,
      commercialGenerationId: loser.agreement.operationId, agreement: loser.agreement });
    expect(rebound.agreementFingerprint).not.toBe(colliding[6]);
  } finally { coordinator.release(); }
}, postgresSetupTimeoutMs);

rootTest("preserves the outstanding replacement and never enters delivery confirmation", async ({ owner }) => {
  const delivery = await fixture(owner), control = await openCase(owner, delivery);
  const arrived = await replacement(owner, delivery);
  await owner.query("UPDATE public.fulfillment_shipments SET status='delivered',delivered_at=clock_timestamp() WHERE id=$1", [arrived]);
  let outstanding = "", caseId = "", predecessor = "";
  const f = await rootFixture(owner, "v3", undefined, async (db, paid) => {
    const originalShipment = { ...delivery, order: paid.orderId, shipment: randomUUID() };
    await db.query(`INSERT INTO public.fulfillment_shipments(id,order_id,port_key,provider_type,create_idempotency_key)
      SELECT $1::uuid,$2,port_key,provider_type,$1::uuid::text FROM public.fulfillment_shipments WHERE id=$3`,
    [originalShipment.shipment, paid.orderId, delivery.shipment]);
    caseId = (await openCase(db, originalShipment)).id;
    predecessor = originalShipment.shipment;
    outstanding = await replacement(db, originalShipment);
  });
  const before = await snapshot(owner, f);
  const deliveryState = (db: Db) => effects(db, ["fulfillment_shipments", "subscription_delivery_alignment_cases",
    "subscription_delivery_alignment_arrivals", "subscriptions"]);
  const assertOutstanding = async (db: Db) => {
    expect((await db.query(`SELECT c.id FROM public.${occurrence} o
      JOIN public.subscription_delivery_alignment_cases c ON c.subscription_id=o.subscription_id
      JOIN public.fulfillment_shipments s ON s.order_id=c.predecessor_order_id AND s.replaces_shipment_id=c.shipment_id
      WHERE o.cycle_key=$1 AND c.id=$2 AND c.predecessor_order_id=$3 AND c.shipment_id=$4 AND s.id=$5
        AND c.predecessor_cycle_id=$6 AND c.state IN ('protected','manual_review') AND c.captured_mode='auto_align'
        AND o.original_anchor_at=$7::timestamptz AND o.effective_due_at=$7::timestamptz
        AND c.aligned_at IS NULL AND c.aligned_next_cycle_at IS NULL AND c.delivered_at IS NULL AND s.delivered_at IS NULL
        AND NOT EXISTS (SELECT FROM public.fulfillment_shipments successor WHERE successor.replaces_shipment_id=s.id)`,
    [f.cycleKey, caseId, f.orderId, predecessor, outstanding, f.cycleId, f.originalAnchorAt])).rows).toEqual([{ id: caseId }]);
  };
  await assertOutstanding(owner);
  const state = await deliveryState(owner);
  const confirmation = "subscription_delivery_alignment_confirm_replacement";
  const { rows: bodies } = await owner.query<{ oid: string; proname: string; prosrc: string; entry: boolean; dependencies: string[] }>(`
    SELECT p.oid::text, p.proname, p.prosrc,
      (p.pronamespace='public'::regnamespace AND p.proname=ANY($1::text[])) OR p.oid IN
        (SELECT tgfoid FROM pg_trigger WHERE NOT tgisinternal AND tgrelid=ANY($2::regclass[])) AS entry,
      ARRAY(SELECT d.refobjid::text FROM pg_depend d WHERE d.classid='pg_proc'::regclass
        AND d.refclassid='pg_proc'::regclass AND d.objid=p.oid) AS dependencies
    FROM pg_proc p WHERE p.pronamespace NOT IN ('pg_catalog'::regnamespace,'information_schema'::regnamespace)`,
  [[read, lock, writer], [occurrence, operations, generations].map(name => `public.${name}`)]);
  const entries = bodies.filter(body => body.entry), visited = new Set(entries.map(body => body.oid));
  for (const { proname, prosrc, dependencies } of entries) {
    expect(proname).not.toBe(confirmation);
    expect(prosrc.toLowerCase()).not.toContain(confirmation);
    const calls = new Set([...prosrc.matchAll(/(?:"([a-z_][\w$]*)"|\b([a-z_][\w$]*))\s*\(/giu)]
      .map(([, quoted, unquoted]) => quoted ?? unquoted!.toLowerCase()));
    for (const body of bodies) if (!visited.has(body.oid) && (dependencies.includes(body.oid) || calls.has(body.proname))) {
      visited.add(body.oid);
      entries.push(body);
    }
  }
  const count = await probe(owner, confirmation, `public.${confirmation}(uuid,text)`, "fixture_confirmation_entries");
  expect(await count()).toBe(1);
  await transaction(owner, async tx => {
    await savepoint(tx, async () => {
      expect(await call(tx, confirmation, [control.id, "Verified delivered fixture"])).toMatchObject({ confirmed: true });
    });
    expect(await count()).toBe(2);
    await savepoint(tx, () => tx.query(`DO $$ BEGIN PERFORM public.${confirmation}(NULL,'invalid fixture');
      RAISE EXCEPTION 'control unexpectedly succeeded'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END $$`));
    expect(await count()).toBe(3);
    await savepoint(tx, async () => {
      const unchanged = async () => {
        await assertOutstanding(tx);
        expect(await deliveryState(tx)).toEqual(state);
      };
      await unchanged();
      expect(await selected(tx, f)).toMatchObject({ operationId: null }); await unchanged();
      expect(await call(tx, lock, f.scope)).toMatchObject({ operationId: null }); await unchanged();
      expect(await claim(tx, f)).toMatchObject({ outcome: "created" }); await unchanged();
      expect(await claim(tx, f)).toMatchObject({ outcome: "existing", claimToken: null }); await unchanged();
      const retained = await snapshot(tx, f);
      await savepoint(tx, async () => { await expect(claim(tx, f, changed(f, 6, null))).rejects.toMatchObject(conflict); });
      expect(await snapshot(tx, f)).toEqual(retained); await unchanged();
    });
    expect(await count()).toBe(3);
  }, "ROLLBACK");
  await assertOutstanding(owner);
  expect(await deliveryState(owner)).toEqual(state);
  expect(await snapshot(owner, f)).toEqual(before);
  expect(await count()).toBe(3);
}, postgresSetupTimeoutMs);
