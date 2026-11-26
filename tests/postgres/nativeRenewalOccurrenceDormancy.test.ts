import { readdirSync, readFileSync } from "node:fs";
import { Client, Pool, type QueryConfig } from "pg";
import { expect, it, vi } from "vitest";
import { configurations } from "../../examples/neutral-store/owned/store.config.ts";
import { runScheduledRenewal } from "../../examples/neutral-store/host/scheduled-renewal.ts";
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions } from "../../server/adapters/postgres/qualifiedInstall.js";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { closePostgres, postgresSetupTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { installAccountMutations } from "./customerAccountMutations.fixture.js";
import { exerciseLegacyRenewals } from "./nativeRenewalV3Legacy.fixture.js";
import { transaction } from "./orderMoneyV2Storage.fixture.js";
import { activatedRenewal, activation, allocate, occurrenceProducerPath, probe, producer, signature } from "./nativeRenewalOccurrence.fixture.js";
import { args, lock, occurrence, operations, read, rootFixture, writer, writerParameters } from "./nativeRenewalOccurrenceWriter.fixture.js";
import { AT, call, later, seedRenewalStock, type Db } from "./subscriptionNativeFixture.js";

const current = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
if (current?.schemaVersion !== 3) throw new Error("Expected the full native migration catalogue");
const producerPath = occurrenceProducerPath();
const writerPath = current.forward.find(({ file }) => file.endsWith("_native_renewal_occurrence_writer.sql"))?.file;
if (!writerPath) throw new Error("Missing renewal occurrence writer migration");
const sql = readFileSync(producerPath, "utf8");
const pins = {
  before: {
    legacy: "df0134e8213f9559a23c56a8a705545ffda2ae1bfc011c1eefe1e3754485c386",
    bootstrap: "3eb85a770c9ae311ed3e74135efcba055c7c902ae7b55096a570fdcd87f2ec12",
    separate: "83b8d2ad29efe3b827e73deeae8e26626242ddb0f09df292cef8450293ea9bce",
    admin: "33babfbe85a1ea2063a6ecc936560d3ac86471a03721aaf9ad992a5bf052c5be",
    operator: "cb8f34664a537f369529f38e733270b897557bec5523c1e8f849e25f90080cfa",
  },
  through: {
    legacy: "8ff85f95f42d13c0ece64041bb4ff7ada3e7e4a0422aa3effbc8dc693ed4d745",
    bootstrap: "ff2e4f09fe0e169af732dc8b5d742734bbc455f5cfb79c97a2cec2b1c9311cdc",
    separate: "c3f6f8015123d494038476b7fdf84756114267d89251c427686e8ff90fbba976",
    admin: "7b40ca62f61d4a0bd9eea0a4a8951b9cc0586d77217a4a2d50beae3374662e3f",
    operator: "adba183105b7daa3f3b4de1f27ea0521bcde435f07c97b43596bc9d7fe6e32e4",
  },
  writer: { legacy: "37ae356e65f2bde6380735c2afd34bf2a11114d411936424c4076e23b5fde4c2", bootstrap: "e128d95b5446fb20878b848650c947bf8b2141b6a8ae9dbf2eb7189114cc60d4", separate: "7f1cb5f1be459b7e205ba4ad335608fd9d0d161e22565a8ff08d5df92dd2a727",
    admin: "dd8a1e6539bbaf26993fb5ab49b2ddf5e68b7ec0a01b68340087fc35c641f016", operator: "4e19800b9f85031944928d35fd0c75343a9009b949b8bfc13b86817f8782498f" },
};

function atBoundary(manifest: Extract<PlatformMigrationManifest, { schemaVersion: 3 }>, boundary: keyof typeof pins) {
  const plan = structuredClone(manifest), inventory = pins[boundary];
  const path = boundary === "writer" ? writerPath : producerPath;
  for (const profile of [plan, plan.qualified, plan.qualifiedAdmin]) {
    const index = profile.forward.findIndex(({ file }) => file === path);
    if (index < 0) throw new Error(`Missing renewal occurrence migration ${path}`);
    profile.forward = profile.forward.slice(0, boundary === "before" ? index : index + 1);
  }
  plan.objectInventorySha256 = inventory.legacy;
  plan.qualified.objectInventorySha256 = { bootstrapMigrator: { withRestore: inventory.bootstrap },
    separateMigrator: { withRestore: inventory.separate } };
  plan.qualifiedAdmin.objectInventorySha256 = { installerManaged: inventory.admin, operatorProvisioned: inventory.operator };
  return plan;
}

const plans = { before: atBoundary(current, "before"), through: atBoundary(current, "through"), writer: atBoundary(current, "writer") };
const { before: predecessor, through: catalogue, writer: writerCatalogue } = plans;
it("selects the exact pinned prefixes even when every plan has a later forward", () => {
  const extended = structuredClone(current);
  const laterInventory = "a".repeat(64);
  for (const plan of [extended, extended.qualified, extended.qualifiedAdmin]) {
    plan.forward.push({ file: "db/platform/migrations/99991231235959_fixture_later_forward.sql", sha256: laterInventory });
  }
  extended.objectInventorySha256 = laterInventory;
  extended.qualified.objectInventorySha256 = { bootstrapMigrator: { withRestore: laterInventory },
    separateMigrator: { withRestore: laterInventory } };
  extended.qualifiedAdmin.objectInventorySha256 = { installerManaged: laterInventory, operatorProvisioned: laterInventory };
  expect(atBoundary(extended, "before")).toEqual(predecessor);
  expect(atBoundary(extended, "through")).toEqual(catalogue);
  expect(atBoundary(extended, "writer")).toEqual(writerCatalogue);
});
const denied = { code: "42501", message: `permission denied for function ${producer}` };

async function assertAcl(db: Db) {
  expect((await db.query(`SELECT p.provolatile AS volatility,p.prosecdef AS definer,p.proconfig AS settings,
    p.proowner=c.relowner AND p.proowner=current_user::regrole AS owns,b.lanname AS language,
    p.pronargs AS args,p.pronargdefaults AS defaults,p.prorettype='jsonb'::regtype AS returns_json,
    ARRAY(SELECT privilege_type FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) WHERE grantee<>p.proowner) AS grants
    FROM pg_proc p JOIN pg_language b ON b.oid=p.prolang CROSS JOIN pg_class c
    WHERE p.oid=$1::regprocedure AND c.oid='public.subscription_cycle_occurrences'::regclass`, [signature])).rows)
    .toEqual([{ volatility: "v", definer: false, settings: ["search_path=pg_catalog, pg_temp"],
      owns: true, language: "plpgsql", args: 4, defaults: 0, returns_json: true, grants: [] }]);
  expect((await db.query(`SELECT COUNT(*)::int AS overloads FROM pg_proc WHERE proname=$1 AND pronamespace='public'::regnamespace`, [producer])).rows)
    .toEqual([{ overloads: 1 }]);
}

async function installedCallers(db: Db, sig: string, name: string) {
  return (await db.query(`SELECT proname::text AS caller FROM pg_proc WHERE oid<>$1::regprocedure AND strpos(lower(prosrc),$2)>0
    UNION ALL SELECT rulename::text FROM pg_rewrite WHERE strpos(lower(pg_get_ruledef(oid)),$2)>0
    UNION ALL SELECT tgname::text FROM pg_trigger WHERE NOT tgisinternal AND strpos(lower(pg_get_triggerdef(oid)),$2)>0
    UNION ALL SELECT classid::regclass::text FROM pg_depend WHERE refclassid='pg_proc'::regclass AND refobjid=$1::regprocedure`,
  [sig, name])).rows;
}
const assertNoCallers = async (db: Db) => expect(await installedCallers(db, signature, producer)).toEqual([]);

async function assertDeniedPaths(db: Db, f: Awaited<ReturnType<typeof activation>>) {
  expect((await db.query(`SELECT r.rolname FROM pg_roles r CROSS JOIN pg_proc p
    WHERE p.oid=$1::regprocedure AND (pg_has_role(current_user,r.oid,'USAGE') OR pg_has_role(current_user,r.oid,'SET'))
      AND has_function_privilege(r.oid,p.oid,'EXECUTE')`, [signature])).rows).toEqual([]);
  await expect(allocate(db, f)).rejects.toMatchObject(denied);
}

const writerNames = [read, lock, writer];
const writerSignatures = writerNames.map(name => `public.${name}(${name === writer ? writerParameters : "uuid,uuid,uuid"})`);

async function assertWriterAcl(db: Db) {
  for (const [index, sig] of writerSignatures.entries()) {
    expect((await db.query(`SELECT p.prosecdef, p.provolatile, p.proconfig,p.pronargdefaults,p.prorettype='jsonb'::regtype AS json,
      p.proowner=c.relowner AND p.proowner=current_user::regrole
        AND p.proowner=(SELECT relowner FROM pg_class WHERE oid='public.subscription_cycle_generations'::regclass) AS owns,
      ARRAY(SELECT privilege_type FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) WHERE grantee<>p.proowner) AS grants,
      (SELECT count(*)::int FROM pg_proc WHERE proname=p.proname AND pronamespace=p.pronamespace) AS overloads
      FROM pg_proc p, pg_class c WHERE p.oid=$1::regprocedure AND c.oid='public.${occurrence}'::regclass`, [sig])).rows)
      .toEqual([{ prosecdef: index === 2, provolatile: "v", proconfig: ["search_path=pg_catalog, pg_temp"], pronargdefaults: 0,
        json: true, owns: true, grants: [], overloads: 1 }]);
    expect(await installedCallers(db, sig, writerNames[index]!)).toEqual(index === 2 ? [] : [{ caller: writerNames[index + 1] }]);
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
    if (text?.toLowerCase().includes(writer)) attempts.push(`${this.user}:${writer}`);
    return Reflect.apply(query, this, args);
  });
  return { attempts, close: () => listener.mockRestore() };
}

it.each(["bootstrap", "separate", "admin-managed", "admin-operator"] as const)(
  "installs the owner-only signature and denies the actual %s runtime and an unrelated definer", profile => withPlatformCatalog(catalogue, async root => {
    const store = await installAccountMutations(profile, false, "occurrence-acl", root);
    try {
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
    } finally { await store.close(); }
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
  async function exercise(boundary: keyof typeof pins) {
    const plan = plans[boundary];
    if (!withService) {
      return withPlatformCatalog(plan, async root => {
        const store = await installAccountMutations("legacy", false, "occurrence-mount", root);
        try { return await run(store, boundary); } finally { await store.close(); }
      });
    }
    const container = await runPostgresContainer({ name: `occurrence-legacy-service-${process.pid}`, password: "synthetic-occurrence" });
    const owner = new Pool({ connectionString: container.connectionString });
    try {
      expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
      await owner.query("CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS");
      for (const unit of [plan.baseline, ...plan.forward]) await owner.query(readFileSync(unit.file, "utf8"));
      return await run({ owner, runtime: owner }, boundary);
    } finally { await closePostgres(container, owner); }
  }

  async function run(pools: { owner: Pool; runtime: Pool }, boundary: keyof typeof pins) {
    const { owner, runtime } = pools, candidate = boundary !== "before";
    const writerProbe = boundary === "writer" ? await probeWriter(owner) : undefined;
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
            expect(watch.attempts.splice(0)).toEqual(writerProbe
              ? ["fixture_occurrence_plain", `fixture_occurrence_plain:${writer}`] : ["fixture_occurrence_plain"]);
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
}, postgresSetupTimeoutMs);

it("compares a paid renewal under the actual starter login with a fixed occurrence on the renewed subscription", async () => {
  async function exercise(boundary: keyof typeof pins) {
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
      await withPlatformCatalog(plans[boundary], root => createPostgresMigrationRunner(
        { connectionString: container.connectionString }, { root, installation, poolFactory: () => migration }).apply());
      const preimages = (await owner.query(`SELECT oid::regprocedure::text,pg_get_functiondef(oid),proacl
        FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN
        ('subscription_claim_due_renewal','commerce_prepare_subscription_renewal',
        'customer_preferences_export','customer_preferences_prepare_erasure')
        UNION ALL SELECT tgname::text,pg_get_triggerdef(oid),NULL FROM pg_trigger WHERE NOT tgisinternal
        AND tgrelid IN ('public.subscription_renewal_operations'::regclass,'public.subscription_cycle_occurrences'::regclass)
        ORDER BY 1`)).rows;
      const writerProbe = boundary === "writer" ? await probeWriter(migration) : undefined;
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
            await expect(call(this, writer, writerProbe.input)).rejects.toMatchObject({ code: "42501" });
            expect(watch.attempts.splice(0)).toEqual(["starter_runtime", `starter_runtime:${writer}`]);
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
}, postgresSetupTimeoutMs);

it("has no mounted source callers and is absent from managed migrations", () => {
  for (const root of ["server", "src", "api", ...readdirSync("packages", { withFileTypes: true })
    .filter(entry => entry.isDirectory() && readdirSync(`packages/${entry.name}`).includes("src")).map(entry => `packages/${entry.name}/src`),
    "examples/neutral-store", "supabase/migrations"]) {
    for (const file of readdirSync(root, { recursive: true, encoding: "utf8" }).filter(path => /\.(?:[cm]?[jt]sx?|sql)$/u.test(path))) {
      const content = readFileSync(`${root}/${file}`, "utf8").toLowerCase();
      for (const routine of [producer, read, lock, writer]) expect(content.includes(routine), `${root}/${file}`).toBe(false);
    }
  }
});

it.each(["bootstrap", "separate", "admin-managed", "admin-operator"] as const)(
  "keeps the three writer routines private under the installed %s roles and permissive defaults", profile => withPlatformCatalog(writerCatalogue, async root => {
    const store = await installAccountMutations(profile, false, "writer-acl", root);
    try {
      const owner = store.migrator, f = await rootFixture(owner);
      const before = () => owner.query(`SELECT to_jsonb(c),xmin::text FROM public.${occurrence} c`).then(r => r.rows);
      const pristine = await before();
      await assertWriterAcl(owner);
      await assertNoCallers(owner);
      for (const [index, name] of writerNames.entries()) {
        const input = name === writer ? args(f) : f.scope;
        expect((await store.runtime.query(`SELECT r.rolname FROM pg_roles r,pg_proc p
          WHERE p.oid=$1::regprocedure AND (pg_has_role(current_user,r.oid,'USAGE') OR pg_has_role(current_user,r.oid,'SET'))
            AND has_function_privilege(r.oid,p.oid,'EXECUTE')`, [writerSignatures[index]])).rows).toEqual([]);
        await expect(call(store.runtime, name, input)).rejects.toMatchObject({ code: "42501" });
        await transaction(store.owner, async db => {
          await db.query(`CREATE ROLE fixture_writer_other LOGIN NOINHERIT;
            CREATE FUNCTION public.fixture_writer_relay() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
            AS ${db.escapeLiteral(`SELECT public.${name}(${input.map(value => db.escapeLiteral(String(value))).join(",")})`)};
            ALTER FUNCTION public.fixture_writer_relay() OWNER TO fixture_writer_other`);
          await expect(call(db, "fixture_writer_relay", [])).rejects.toMatchObject({ code: "42501" });
        }, "ROLLBACK");
        expect(await before()).toEqual(pristine);
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
        await db.query(readFileSync(writerPath!, "utf8"));
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
      expect(await before()).toEqual(pristine);
      expect((await store.runtime.query(`SELECT EXISTS(SELECT FROM public.${operations} WHERE subscription_id=$1) AS created`,
        [f.subscriptionId])).rows).toEqual([{ created: false }]);
    } finally { await store.close(); }
  }), postgresSetupTimeoutMs);
