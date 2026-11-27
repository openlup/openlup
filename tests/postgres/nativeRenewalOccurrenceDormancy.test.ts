import { readdirSync, readFileSync } from "node:fs";
import { Client, Pool, type QueryConfig } from "pg";
import { expect, it, vi } from "vitest";
import { configurations } from "../../examples/neutral-store/owned/store.config.ts";
import { runScheduledRenewal } from "../../examples/neutral-store/host/scheduled-renewal.ts";
import { qualifiedPostgresStartupOptions } from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, postgresSetupTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import type { AccountMutationsStore, AccountProfile } from "./customerAccountMutations.fixture.js";
import { exerciseLegacyRenewals } from "./nativeRenewalV3Legacy.fixture.js";
import { transaction } from "./orderMoneyV2Storage.fixture.js";
import { activatedRenewal, activation, allocate, probe, producer, signature } from "./nativeRenewalOccurrence.fixture.js";
import { applyMeasuredStarterPrefix, args, installMeasuredAccountPrefix, lock, occurrence, occurrenceCatalogue as current,
  occurrenceForwardPath, operations, plans, read, rootFixture, sliceOccurrencePlan, writer, writerParameters,
  writerPath, writerPlan } from "./nativeRenewalOccurrenceWriter.fixture.js";
import { AT, call, later, sandboxRenewal, seedRenewalStock, type Db } from "./subscriptionNativeFixture.js";

const producerPath = occurrenceForwardPath(signature);
const sql = readFileSync(producerPath, "utf8");
const atProducer = (manifest: typeof current, boundary: "before" | "through") =>
  sliceOccurrencePlan(manifest, producerPath, boundary === "through");
const catalogue = atProducer(current, "through"), predecessor = atProducer(current, "before");
it("includes new predecessor units and excludes stacked forwards at the registered producer path", () => {
  const extended = structuredClone(current);
  const newPredecessor = { file: "db/platform/migrations/fixture_predecessor.sql", sha256: "a".repeat(64) };
  const stacked = { file: "db/platform/migrations/fixture_stacked_forward.sql", sha256: "b".repeat(64) };
  for (const plan of plans(extended)) {
    const cut = plan.forward.findIndex(({ file }) => file === producerPath);
    plan.forward.splice(cut, 1, newPredecessor, plan.forward[cut]!, stacked);
    plan.forward.push({ ...stacked, file: stacked.file.replace("stacked", "after_writer") });
  }
  const before = plans(atProducer(extended, "before"));
  const through = plans(atProducer(extended, "through"));
  const writerPlans = plans(writerPlan(extended));
  for (const [index, plan] of plans(predecessor).entries()) {
    const producerUnit = plans(catalogue)[index]!.forward[plan.forward.length];
    expect(producerUnit?.file).toBe(producerPath);
    expect(before[index]!.forward).toEqual([...plan.forward, newPredecessor]);
    expect(through[index]!.forward).toEqual([...plan.forward, newPredecessor, producerUnit]);
    expect(writerPlans[index]!.forward.at(-1)?.file).toBe(writerPath);
  }
});

const privacySignature = "public.subscriptions__read_renewal_occurrences_for_privacy(uuid,uuid)";
const privacyPath = occurrenceForwardPath(privacySignature);
const boundaries = { before: predecessor, through: catalogue, writer: writerPlan(), privacy: sliceOccurrencePlan(current, privacyPath, true) };
async function withMeasuredAccountPrefix<T>(manifest: typeof current, profile: AccountProfile, label: string,
  exercise: (store: AccountMutationsStore) => Promise<T>) {
  const store = await installMeasuredAccountPrefix(manifest, profile, label);
  try { return await exercise(store); } finally { await store.close(); }
}

const denied = { code: "42501", message: `permission denied for function ${producer}` };

async function assertAcl(db: Db, sig = signature, args = 4, definer = false) {
  expect((await db.query(`SELECT p.provolatile AS volatility,p.prosecdef AS definer,p.proconfig AS settings,
    p.proowner=c.relowner AND p.proowner=current_user::regrole
      AND p.proowner=(SELECT relowner FROM pg_class WHERE oid='public.subscription_cycle_generations'::regclass) AS owns,b.lanname AS language,
    (SELECT count(*)::int FROM pg_proc WHERE proname=p.proname AND pronamespace=p.pronamespace) AS overloads,
    p.pronargs AS args,p.pronargdefaults AS defaults,p.prorettype='jsonb'::regtype AS returns_json,
    ARRAY(SELECT privilege_type FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) WHERE grantee<>p.proowner) AS grants
    FROM pg_proc p JOIN pg_language b ON b.oid=p.prolang CROSS JOIN pg_class c
    WHERE p.oid=$1::regprocedure AND c.oid='public.subscription_cycle_occurrences'::regclass`, [sig])).rows)
    .toEqual([{ volatility: "v", definer, settings: ["search_path=pg_catalog, pg_temp"],
      owns: true, language: "plpgsql", args, defaults: 0, returns_json: true, grants: [], overloads: 1 }]);
}

async function assertNoCallers(db: Db, sig = signature, name = producer, internalCaller?: string) {
  expect((await db.query(`SELECT proname::text AS caller FROM pg_proc WHERE oid<>$1::regprocedure AND lower(prosrc)~$2
    UNION ALL SELECT rulename::text FROM pg_rewrite WHERE lower(pg_get_ruledef(oid))~$2
    UNION ALL SELECT tgname::text FROM pg_trigger WHERE NOT tgisinternal AND lower(pg_get_triggerdef(oid))~$2
    UNION ALL SELECT classid::regclass::text FROM pg_depend WHERE refclassid='pg_proc'::regclass AND refobjid=$1::regprocedure`,
  [sig, `\\m${name}\\M`])).rows).toEqual(internalCaller ? [{ caller: internalCaller }] : []);
}

async function assertNoExecute(db: Db, sig: string) {
  expect((await db.query(`SELECT r.rolname FROM pg_roles r CROSS JOIN pg_proc p
    WHERE p.oid=$1::regprocedure AND (pg_has_role(current_user,r.oid,'USAGE') OR pg_has_role(current_user,r.oid,'SET'))
      AND has_function_privilege(r.oid,p.oid,'EXECUTE')`, [sig])).rows).toEqual([]);
}
async function assertDeniedPaths(db: Db, f: Awaited<ReturnType<typeof activation>>) {
  await assertNoExecute(db, signature);
  await expect(allocate(db, f)).rejects.toMatchObject(denied);
}

const writerNames = [read, lock, writer];
const writerSignatures = writerNames.map(name => `public.${name}(${name === writer ? writerParameters : "uuid,uuid,uuid"})`);

async function assertWriterAcl(db: Db) {
  for (const [index, sig] of writerSignatures.entries()) {
    await assertAcl(db, sig, index === 2 ? 9 : 3, index === 2);
    await assertNoCallers(db, sig, writerNames[index]!, writerNames[index + 1]);
  }
}

async function probeWriter(owner: Pool) {
  await assertWriterAcl(owner);
  const f = await rootFixture(owner);
  const count = await probe(owner, writer, writerSignatures[2]!, "fixture_writer_entries");
  const input = args(f);
  expect(await count()).toBe(1);
  await transaction(owner, async db => {
    expect(await call(db, writer, input)).toMatchObject({ outcome: "created" });
  }, "ROLLBACK");
  await owner.query("UPDATE public.subscriptions SET next_cycle_at='2050-01-01Z' WHERE id=$1", [f.subscriptionId]);
  await owner.query("DELETE FROM public.outbox_events WHERE aggregate_id=$1 AND event_type IN ('commerce.order.paid','commerce.order.paid.email')", [f.orderId]);
  expect(await count()).toBe(2);
  return { input, scope: f.scope, count };
}

function watchAttempts() {
  const attempts: string[] = [], query = Client.prototype.query;
  const listener = vi.spyOn(Client.prototype, "query").mockImplementation(function (this: Client, ...args: Parameters<typeof query>) {
    const input = args[0] as string | QueryConfig;
    const text = typeof input === "string" ? input : input.text;
    if (text?.toLowerCase().includes(producer)) attempts.push(this.user ?? "");
    for (const name of writerNames) if (text?.toLowerCase().includes(name)) attempts.push(`${this.user}:${name}`);
    return Reflect.apply(query, this, args);
  });
  return { attempts, close: () => listener.mockRestore() };
}

it.each(["bootstrap", "separate", "admin-managed", "admin-operator"] as const)(
  "installs the owner-only signature and denies the actual %s runtime and an unrelated definer",
  profile => withMeasuredAccountPrefix(catalogue, profile, "occurrence-acl", async store => {
    const f = await transaction(store.migrator, db => activation(db), "COMMIT");
    await assertAcl(store.migrator);
    await assertNoCallers(store.migrator);
    await assertDeniedPaths(store.runtime, f);
    await transaction(store.owner, async db => {
      await db.query(`CREATE ROLE fixture_unrelated_owner LOGIN NOINHERIT;
        CREATE FUNCTION public.fixture_occurrence_relay(uuid,uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER
        SET search_path = pg_catalog, pg_temp AS 'SELECT public.${producer}($1,$2,''v3'',NULL)';
        ALTER FUNCTION public.fixture_occurrence_relay(uuid,uuid) OWNER TO fixture_unrelated_owner`);
      await expect(db.query("SELECT public.fixture_occurrence_relay($1,$2)", [f.clientId, f.subscriptionId])).rejects.toMatchObject(denied);
    }, "ROLLBACK");
    expect(await allocate(store.migrator, f)).toMatchObject({ outcome: "created" });
    await transaction(store.migrator, async db => {
      await db.query(`DROP FUNCTION ${signature};
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;
        CREATE FUNCTION public.fixture_permissive_default() RETURNS boolean LANGUAGE sql AS 'SELECT true'`);
      expect((await db.query(`SELECT grantee::regrole::text AS role FROM pg_proc p,aclexplode(p.proacl)
        WHERE p.oid='public.fixture_permissive_default()'::regprocedure AND grantee NOT IN (0,p.proowner) ORDER BY role`)).rows)
        .toEqual(["anon", "authenticated", "service_role"].map(role => ({ role })));
      await db.query(sql);
      await assertAcl(db);
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [role, signature])).rows).toEqual([{ allowed: false }]);
      }
    }, "ROLLBACK");
  }), postgresSetupTimeoutMs);

const emptyV3 = async (db: Db) => {
  const { rows } = await db.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'
    AND starts_with(tablename,'subscription_cycle_') AND tablename <> 'subscription_cycle_occurrences'`);
  for (const { tablename } of rows) {
    expect((await db.query(`SELECT count(*)::int AS count FROM public."${String(tablename).replaceAll('"', '""')}"`)).rows, tablename)
      .toEqual([{ count: 0 }]);
  }
};

const occurrenceRows = (db: Db) => db.query(`SELECT to_jsonb(o) AS occurrence,xmin::text,ctid::text
  FROM public.subscription_cycle_occurrences o ORDER BY subscription_id`).then(({ rows }) => rows);

async function dispatchEffects(db: Db) {
  return (await db.query(`SELECT
    (SELECT count(*)::int FROM public.payment_provider_attempts) AS provider_attempts,
    (SELECT count(*)::int FROM public.payment_simulator_attempts) AS simulator_attempts,
    (SELECT count(*)::int FROM public.transactional_delivery_receipts) AS send_receipts,
    (SELECT count(*)::int FROM public.communication_recipient_consents) AS consents,
    (SELECT jsonb_agg(jsonb_build_array(event_type,status) ORDER BY event_type,status) FROM public.outbox_events) AS outbox`)).rows[0];
}

it.each([false, true])("preserves the mounted native worker with owner login and service role present=%s", async withService => {
  async function exercise(boundary: keyof typeof boundaries) {
    const store = await installMeasuredAccountPrefix(boundaries[boundary], withService ? "legacy-with-service" : "legacy", "occurrence-mount");
    try { return await run(store, boundary); } finally { await store.close(); }
  }

  async function run(pools: { owner: Pool; runtime: Pool }, boundary: keyof typeof boundaries) {
    const { owner, runtime } = pools, candidate = boundary !== "before";
    const writerProbe = boundary === "writer" || boundary === "privacy" ? await probeWriter(owner) : undefined;
    expect((await runtime.query("SELECT session_user,current_user")).rows).toEqual([{ session_user: "postgres", current_user: "postgres" }]);
    if (withService) expect((await owner.query(`SELECT
      has_column_privilege('service_role','public.${occurrence}','client_id','SELECT') AS census,
      has_table_privilege('service_role','public.${occurrence}','SELECT,INSERT,UPDATE,DELETE') AS table_access`)).rows)
      .toEqual([{ census: true, table_access: false }]);
    const retained = await occurrenceRows(owner);
    let count: (() => Promise<number>) | undefined;
    if (candidate) {
      await assertAcl(owner);
      await assertNoCallers(owner);
      count = await probe(owner, producer, signature, "fixture_producer_entries");
      expect(await count()).toBe(1);
      await owner.query("CREATE ROLE fixture_occurrence_plain LOGIN NOINHERIT PASSWORD 'synthetic-occurrence'");
    }
    const watch = watchAttempts();
    try {
      const effects = await exerciseLegacyRenewals(pools, async availability => {
        const subject = await transaction(owner, db => activatedRenewal(db, { availability }), "COMMIT");
        if (candidate) {
          const login = new URL(owner.options.connectionString!);
          login.username = "fixture_occurrence_plain";
          login.password = "synthetic-occurrence";
          if (retained.length === Number(Boolean(writerProbe))) {
            const negative = new Pool({ connectionString: login.toString() });
            try {
              await assertDeniedPaths(negative, subject);
              if (writerProbe) for (const entry of writerNames) await expect(call(negative, entry,
                entry === writer ? writerProbe.input : writerProbe.scope)).rejects.toMatchObject({ code: "42501" });
            } finally { await negative.end(); }
            expect(watch.attempts.splice(0)).toEqual(["fixture_occurrence_plain",
              ...(writerProbe ? writerNames.map(name => `fixture_occurrence_plain:${name}`) : [])]);
          }
          expect(await allocate(owner, subject)).toMatchObject({ outcome: "created", originalAnchorAt: subject.due });
          expect(watch.attempts.splice(0)).toEqual(["postgres"]);
          retained.push((await occurrenceRows(owner)).find(({ occurrence }) => occurrence.subscription_id === subject.subscriptionId)!);
        }
        return subject;
      });
      expect(watch.attempts).toEqual([]);
      if (candidate) {
        expect(await count!()).toBe(4);
        expect(retained).toHaveLength(3 + Number(Boolean(writerProbe)));
        expect(await occurrenceRows(owner)).toEqual(expect.arrayContaining(retained));
        expect(await occurrenceRows(owner)).toHaveLength(retained.length);
        if (writerProbe) expect(await writerProbe.count()).toBe(2);
        await emptyV3(owner);
      }
      return { effects, dispatch: await dispatchEffects(owner) };
    } finally { watch.close(); }
  }
  const through = await exercise("through");
  expect(through).toEqual(await exercise("before"));
  expect(await exercise("writer")).toEqual(through);
  expect(await exercise("privacy")).toEqual(through);
}, postgresSetupTimeoutMs);

it("compares a paid renewal under the actual starter login with a fixed occurrence on the renewed subscription", async () => {
  async function exercise(boundary: keyof typeof boundaries) {
    const candidate = boundary !== "before";
    const container = await runPostgresContainer({ name: `occurrence-starter-${process.pid}`, password: "synthetic-occurrence" });
    const owner = new Pool({ connectionString: container.connectionString });
    const installation = { generation: "qualified-v2", roleMode: "installer-managed", migrationLogin: "postgres",
      bootstrapLogin: "postgres", runtimeLogin: "starter_runtime", restoreLogin: "starter_restore" } as const;
    const migration = new Pool({ connectionString: container.connectionString, options: qualifiedPostgresStartupOptions(installation) });
    const url = new URL(container.connectionString); url.username = "starter_runtime";
    const runtime = new Pool({ connectionString: url.toString() });
    try {
      expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
      await owner.query(`CREATE ROLE starter_runtime LOGIN NOINHERIT PASSWORD 'synthetic-occurrence';
        CREATE ROLE starter_restore LOGIN NOINHERIT PASSWORD 'synthetic-occurrence'`);
      const before = boundary === "writer" ? sliceOccurrencePlan(current, writerPath, false)
        : boundary === "privacy" ? boundaries.writer : boundaries[boundary];
      await applyMeasuredStarterPrefix(before, migration, installation);
      const definitions = () => owner.query(`SELECT oid::regprocedure::text,pg_get_functiondef(oid),proacl
        FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
        ('subscription_claim_due_renewal','commerce_prepare_subscription_renewal',
        'customer_preferences_export','customer_preferences_prepare_erasure')
        UNION ALL SELECT tgname::text,pg_get_triggerdef(oid),NULL FROM pg_trigger WHERE NOT tgisinternal
        AND tgrelid IN ('public.subscription_renewal_operations'::regclass,'public.subscription_cycle_occurrences'::regclass)
        ORDER BY 1`).then(r => r.rows);
      const preimages = await definitions();
      if (boundary === "writer" || boundary === "privacy") {
        await applyMeasuredStarterPrefix(boundaries[boundary], migration, installation, [boundary === "writer" ? writerPath : privacyPath]);
        expect(await definitions()).toEqual(preimages);
      }
      if (boundary === "privacy") expect((await runtime.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') AS helper",
        [privacySignature])).rows).toEqual([{ helper: true }]);
      const expired = await sandboxRenewal(migration);
      expect(await call(migration, "fulfillment_reserve_subscription_renewal", [expired.operation, expired.token, 900, AT])).toMatchObject({ reserved: true });
      await migration.query("UPDATE public.subscriptions SET next_cycle_at='2050-01-01Z' WHERE id=$1", [expired.subscription]);
      const writerProbe = boundary === "writer" || boundary === "privacy" ? await probeWriter(migration) : undefined;
      const f = await transaction(migration, async db => {
        await call(db, "subscription_delivery_alignment_set_mode", ["off"]);
        const subject = await activation(db, 28, later(-29 * 24));
        const { destinationId } = await call(db, "commerce_register_order_destination", [`destination:${subject.orderId}`,
          subject.orderId, { recipientName: "Synthetic recipient", line1: "Synthetic street 1", city: "Fixture", postalCode: "00000", country: "ZZ" }, AT]);
        const { source, basket } = await seedRenewalStock(db);
        await call(db, "subscription_register_renewal_purchase", [subject.orderId, {
          settlementChannelKey: "sandbox", authorizationRef: "frozen-mandate", unattendedChargeAuthorizedAt: AT,
          payerAccountRef: null, methodRef: "method-1", methodEvidenceRef: "fixture-evidence", stockSourceKey: source,
          templateId: "fixture-template", cadenceDays: 28, currency: "XXX", lines: basket, shippingAmountMinor: 0, acquisitionRef: null,
        }]);
        expect(await call(db, "subscription_complete_renewal_attachment", [subject.orderId]))
          .toMatchObject({ subscriptionId: subject.subscriptionId, replayed: false });
        return { ...subject, destinationId };
      }, "COMMIT");
      // Isolate delivery produced by the mounted renewal from the activation's paid mail.
      await owner.query("DELETE FROM public.outbox_events WHERE event_type='commerce.order.paid.email'");
      const config = structuredClone(Object.values(configurations)[0]!);
      config.renewal.enabled = true;
      config.renewal.sandbox.initial = "succeeded";
      expect((await runtime.query("SELECT session_user,current_user")).rows).toEqual([{ session_user: "starter_runtime", current_user: "starter_runtime" }]);
      const count = candidate ? await probe(owner, producer, signature, "fixture_producer_entries") : undefined;
      const watch = watchAttempts();
      try {
        let fixed: unknown;
        if (count) {
          await assertDeniedPaths(runtime, f);
          expect(watch.attempts.splice(0)).toEqual(["starter_runtime"]);
          expect(await count()).toBe(1);
          expect(await allocate(migration, f)).toMatchObject({ outcome: "created", originalAnchorAt: f.due });
          expect(watch.attempts.splice(0)).toEqual(["postgres"]);
          expect(await count()).toBe(2);
          fixed = await occurrenceRows(owner);
        }
        const query = Pool.prototype.query;
        let controlled = false;
        const inject = writerProbe && vi.spyOn(Pool.prototype, "query").mockImplementation(function (this: Pool, ...input: Parameters<typeof query>) {
          if (controlled || !String(input[0]).includes("session_user AS login,current_user AS role")) return Reflect.apply(query, this, input);
          controlled = true;
          return (async () => {
            await expect(allocate(this, f)).rejects.toMatchObject(denied);
            for (const name of writerNames) await expect(call(this, name, name === writer ? writerProbe.input : writerProbe.scope)).rejects.toMatchObject({ code: "42501" });
            expect(watch.attempts.splice(0)).toEqual(["starter_runtime", ...writerNames.map(name => `starter_runtime:${name}`)]);
            expect(await writerProbe.count()).toBe(2);
            expect(await count?.()).toBe(2);
            return Reflect.apply(query, this, input);
          })();
        });
        const run = await runScheduledRenewal(url.toString(), config).finally(() => inject?.mockRestore());
        if (writerProbe) { expect(controlled).toBe(true); expect(await writerProbe.count()).toBe(2); }
        expect(run).toMatchObject({ retries: [], renewals: [{ subscriptionId: f.subscriptionId, status: "succeeded" }],
          paidMail: { claimed: 0, processed: 0 } });
        if (!("renewals" in run)) throw new Error("Starter renewal did not run");
        expect(run.renewals).toHaveLength(1);
        expect((await owner.query("SELECT status,terminal_reason FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=$1",
          [expired.operation])).rows).toEqual([{ status: "expired", terminal_reason: "reservation_expired" }]);
        const [result] = run.renewals;
        const readback = await call(runtime, "subscription_read_renewal", [result!.identityKey]);
        expect(readback).toMatchObject({ operationId: result!.operationId, state: "succeeded",
          cycleSnapshot: { subscriptionId: f.subscriptionId, orderSnapshot: { shippingAddressRef: f.destinationId } } });
        const persisted = (await owner.query(`SELECT o.state, c.status AS cycle, ord.status AS "order", i.status AS settlement,
          r.status AS reservation, s.next_cycle_at > $2::timestamptz AS advanced,
          o.external_attempt_ref LIKE ('sandbox-renewal:'||o.id::text||':succeeded:%') AS acknowledged,
          (SELECT count(*)::int FROM public.subscription_renewal_outcomes a WHERE a.renewal_operation_id=o.id
            AND a.event_key='sandbox-observation:'||o.id::text AND a.external_ref=o.external_attempt_ref
            AND a.outcome='succeeded') AS observations
          FROM public.subscription_renewal_operations o JOIN public.subscriptions s ON s.id=o.subscription_id
          JOIN public.subscription_cycles c ON c.renewal_operation_id=o.id
          JOIN public.commerce_orders ord ON ord.renewal_operation_id=o.id
          JOIN public.commerce_settlement_intents i ON i.renewal_operation_id=o.id
          JOIN public.fulfillment_inventory_reservations r ON r.renewal_operation_id=o.id
          WHERE o.id=$1 AND s.id=$3`, [readback.operationId, AT, f.subscriptionId])).rows;
        expect(persisted).toEqual([{ state: "succeeded", cycle: "paid", order: "paid", settlement: "settled",
          reservation: "consumed", advanced: true, acknowledged: true, observations: 1 }]);
        expect(watch.attempts).toEqual([]);
        if (count) {
          expect(await count()).toBe(2);
          expect(await occurrenceRows(owner)).toEqual(fixed);
          await emptyV3(owner);
        }
        const { runMs, ...paidMail } = run.paidMail;
        const { status, reason, replayed } = result!;
        const dispatch = await dispatchEffects(owner);
        expect(dispatch).toMatchObject({ provider_attempts: 0, simulator_attempts: 0, send_receipts: 0 });
        return { transcript: { status, reason, replayed, retries: run.retries, paidMail },
          readback: { state: readback.state, terminalReason: readback.terminalReason, cycleNumber: readback.cycleNumber },
          persisted, dispatch, preimages };
      } finally { watch.close(); }
    } finally { await closePostgres(container, [runtime, migration, owner]); }
  }
  const through = await exercise("through");
  expect(through).toEqual(await exercise("before"));
  expect(await exercise("writer")).toEqual(through);
  expect(await exercise("privacy")).toEqual(through);
}, postgresSetupTimeoutMs);

it("has no mounted source callers and is absent from managed migrations", () => {
  for (const root of ["server", "src", "api", ...readdirSync("packages", { withFileTypes: true })
    .filter(entry => entry.isDirectory() && readdirSync(`packages/${entry.name}`).includes("src")).map(entry => `packages/${entry.name}/src`),
    "examples/neutral-store", "supabase/migrations"]) {
    for (const file of readdirSync(root, { recursive: true, encoding: "utf8" }).filter(path => /\.(?:[cm]?[jt]sx?|sql)$/u.test(path))) {
      const content = readFileSync(`${root}/${file}`, "utf8").toLowerCase();
      for (const routine of [producer, read, lock, writer]) expect(new RegExp(`\\b${routine}\\b`, "u").test(content), `${root}/${file}`).toBe(false);
    }
  }
});

it.each(["bootstrap", "separate", "admin-managed", "admin-operator"] as const)(
  "keeps the three writer routines private under the installed %s roles and permissive defaults", profile => withMeasuredAccountPrefix(boundaries.writer, profile, "writer-acl", async store => {
    const owner = store.migrator, f = await rootFixture(owner);
    const pristine = await occurrenceRows(owner);
    await assertWriterAcl(owner);
    await assertNoCallers(owner);
    for (const [index, name] of writerNames.entries()) {
      const input = name === writer ? args(f) : f.scope;
      await assertNoExecute(store.runtime, writerSignatures[index]!);
      await expect(call(store.runtime, name, input)).rejects.toMatchObject({ code: "42501" });
      await transaction(store.owner, async db => {
        await db.query(`CREATE ROLE fixture_writer_other LOGIN NOINHERIT;
          CREATE FUNCTION public.fixture_writer_relay() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
          AS ${db.escapeLiteral(`SELECT public.${name}(${input.map(value => db.escapeLiteral(String(value))).join(",")})`)};
          ALTER FUNCTION public.fixture_writer_relay() OWNER TO fixture_writer_other`);
        await expect(call(db, "fixture_writer_relay", [])).rejects.toMatchObject({ code: "42501" });
      }, "ROLLBACK");
      expect(await occurrenceRows(owner)).toEqual(pristine);
    }
    const { role } = (await owner.query("SELECT current_user AS role")).rows[0];
    const { login } = (await store.runtime.query("SELECT session_user AS login")).rows[0];
    await transaction(store.owner, async db => {
      await db.query(`SET LOCAL ROLE ${db.escapeIdentifier(String(role))}`);
      await db.query(`DROP FUNCTION ${writerSignatures.join(",")};
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated,service_role;
        CREATE FUNCTION public.fixture_writer_default_control() RETURNS boolean LANGUAGE sql AS 'SELECT true'`);
      expect((await db.query(`SELECT grantee::regrole::text AS role FROM pg_proc p,aclexplode(p.proacl)
        WHERE p.oid='public.fixture_writer_default_control()'::regprocedure AND grantee NOT IN (0,p.proowner) ORDER BY role`)).rows)
        .toEqual(["anon", "authenticated", "service_role"].map(role => ({ role })));
      await db.query(readFileSync(writerPath, "utf8"));
      await assertWriterAcl(db);
      expect(await call(db, writer, args(f))).toMatchObject({ outcome: "created" });
      await db.query("RESET ROLE");
      for (const nonOwner of ["anon", "authenticated", "service_role", String(login)]) {
        for (const name of writerNames) {
          await db.query(`SAVEPOINT denial; SET LOCAL ROLE ${db.escapeIdentifier(nonOwner)}`);
          await expect(call(db, name, name === writer ? args(f) : f.scope)).rejects.toMatchObject({ code: "42501" });
          await db.query("ROLLBACK TO SAVEPOINT denial; RELEASE SAVEPOINT denial");
        }
      }
    }, "ROLLBACK");
    expect(await occurrenceRows(owner)).toEqual(pristine);
    expect((await store.runtime.query(`SELECT EXISTS(SELECT FROM public.${operations} WHERE subscription_id=$1) AS created`,
      [f.subscriptionId])).rows).toEqual([{ created: false }]);
  }), postgresSetupTimeoutMs);
