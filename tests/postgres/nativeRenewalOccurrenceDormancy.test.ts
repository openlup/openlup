import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client, Pool, type QueryConfig } from "pg";
import { expect, it, vi } from "vitest";
import { configurations } from "../../examples/neutral-store/owned/store.config.ts";
import { runScheduledRenewal } from "../../examples/neutral-store/host/scheduled-renewal.ts";
import { PLATFORM_MIGRATION_MANIFEST, readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { readReviewedForwardRegistry, REVIEWED_FORWARD_PATH } from "../../scripts/reviewed-platform-forward.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresCatalogPayload, qualifiedPostgresStartupOptions, type QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "../../server/adapters/postgres/selectedCatalogProjection.js";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { closePostgres, postgresSetupTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { installAccountMutations, type AccountMutationsStore, type AccountProfile } from "./customerAccountMutations.fixture.js";
import { exerciseLegacyRenewals } from "./nativeRenewalV3Legacy.fixture.js";
import { transaction } from "./orderMoneyV2Storage.fixture.js";
import { activatedRenewal, activation, allocate, probe, producer, signature } from "./nativeRenewalOccurrence.fixture.js";
import { AT, call, later, seedRenewalStock, type Db } from "./subscriptionNativeFixture.js";

const current = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
if (current?.schemaVersion !== 3) throw new Error("Expected the full native migration catalogue");
const registry = readReviewedForwardRegistry(readFileSync(REVIEWED_FORWARD_PATH));
const producerSlots = registry.nativeStoreForwardClass?.slots.filter(slot =>
  slot.createdFunctions.some(fn => fn.signature === signature)) ?? [];
if (producerSlots.length !== 1) throw new Error(`Expected one registered producer forward for ${signature}`);
const producerPath = producerSlots[0]!.path;
const sql = readFileSync(producerPath, "utf8");

type CompleteManifest = Extract<PlatformMigrationManifest, { schemaVersion: 3 }>;
const plans = (manifest: CompleteManifest) => [manifest, manifest.qualified, manifest.qualifiedAdmin] as const;

function atProducer(manifest: CompleteManifest, boundary: "before" | "through") {
  const plan = structuredClone(manifest);
  for (const profile of plans(plan)) {
    const index = profile.forward.findIndex(({ file }) => file === producerPath);
    if (index < 0) throw new Error(`Missing producer migration ${producerPath}`);
    profile.forward = profile.forward.slice(0, boundary === "through" ? index + 1 : index);
  }
  return plan;
}

const catalogue = atProducer(current, "through"), predecessor = atProducer(current, "before");
it("includes new predecessor units and excludes stacked forwards at the registered producer path", () => {
  const extended = structuredClone(current);
  const newPredecessor = { file: "db/platform/migrations/fixture_predecessor.sql", sha256: "a".repeat(64) };
  const stacked = { file: "db/platform/migrations/fixture_stacked_forward.sql", sha256: "b".repeat(64) };
  for (const plan of plans(extended)) {
    const cut = plan.forward.findIndex(({ file }) => file === producerPath);
    plan.forward.splice(cut, 1, newPredecessor, plan.forward[cut]!, stacked);
  }
  const before = plans(atProducer(extended, "before"));
  const through = plans(atProducer(extended, "through"));
  for (const [index, plan] of plans(predecessor).entries()) {
    const producerUnit = plans(catalogue)[index]!.forward[plan.forward.length];
    expect(producerUnit?.file).toBe(producerPath);
    expect(before[index]!.forward).toEqual([...plan.forward, newPredecessor]);
    expect(through[index]!.forward).toEqual([...plan.forward, newPredecessor, producerUnit]);
  }
});

async function verifyMeasuredPrefix(root: string, manifest: CompleteManifest, profile: AccountProfile, inventory: string,
  runner: AccountMutationsStore["runner"]) {
  if (!inventory) throw new Error("The sliced installation did not produce an object inventory");
  const pinned = structuredClone(manifest);
  switch (profile) {
    case "legacy": pinned.objectInventorySha256 = inventory; break;
    case "bootstrap": pinned.qualified.objectInventorySha256.bootstrapMigrator.withRestore = inventory; break;
    case "separate": pinned.qualified.objectInventorySha256.separateMigrator.withRestore = inventory; break;
    case "admin-managed": pinned.qualifiedAdmin.objectInventorySha256.installerManaged = inventory; break;
    case "admin-operator": pinned.qualifiedAdmin.objectInventorySha256.operatorProvisioned = inventory; break;
  }
  writeFileSync(join(root, PLATFORM_MIGRATION_MANIFEST), JSON.stringify(pinned));
  expect(await runner.apply()).toEqual({ applied: [] });
}

async function withMeasuredAccountPrefix<T>(manifest: CompleteManifest, profile: AccountProfile, label: string,
  exercise: (store: AccountMutationsStore) => Promise<T>) {
  return withPlatformCatalog(manifest, async root => {
    // The install commits the slice before checking its object inventory.
    const store = await installAccountMutations(profile, true, label, root, root);
    try {
      await verifyMeasuredPrefix(root, manifest, profile, store.inventory, store.runner);
      return await exercise(store);
    } finally { await store.close(); }
  });
}

async function installMeasuredPrefix(manifest: CompleteManifest, pool: Pool,
  installation: { generation: "legacy" } | QualifiedPostgresInstallation, profile: "legacy" | "bootstrap") {
  await withPlatformCatalog(manifest, async root => {
    let inventory = "";
    const runner = createPostgresMigrationRunner({ connectionString: pool.options.connectionString! }, {
      root, installation, poolFactory: () => pool,
      catalogProjectionPayload: async db => {
        const payload = installation.generation === "legacy"
          ? selectedCatalogProjectionPayload(await readSelectedCatalogProjection(db))
          : await qualifiedPostgresCatalogPayload(db, installation, "openlup:public-platform-migrations:v1");
        inventory = createHash("sha256").update(payload).digest("hex");
        return payload;
      },
    });
    try { await runner.apply(); }
    catch (error) {
      if (!inventory || !(error instanceof Error) || error.message !==
        "platform migration inventory rejected: platform migration manifest: object inventory SHA-256 mismatch") throw error;
    }
    await verifyMeasuredPrefix(root, manifest, profile, inventory, runner);
  });
}

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

async function assertNoCallers(db: Db) {
  expect((await db.query(`SELECT proname::text FROM pg_proc WHERE oid<>$1::regprocedure AND strpos(lower(prosrc),$2)>0
    UNION ALL SELECT rulename::text FROM pg_rewrite WHERE strpos(lower(pg_get_ruledef(oid)),$2)>0
    UNION ALL SELECT tgname::text FROM pg_trigger WHERE NOT tgisinternal AND strpos(lower(pg_get_triggerdef(oid)),$2)>0
    UNION ALL SELECT classid::regclass::text FROM pg_depend WHERE refclassid='pg_proc'::regclass AND refobjid=$1::regprocedure`,
  [signature, producer])).rows).toEqual([]);
}

async function assertDeniedPaths(db: Db, f: Awaited<ReturnType<typeof activation>>) {
  expect((await db.query(`SELECT r.rolname FROM pg_roles r CROSS JOIN pg_proc p
    WHERE p.oid=$1::regprocedure AND (pg_has_role(current_user,r.oid,'USAGE') OR pg_has_role(current_user,r.oid,'SET'))
      AND has_function_privilege(r.oid,p.oid,'EXECUTE')`, [signature])).rows).toEqual([]);
  await expect(allocate(db, f)).rejects.toMatchObject(denied);
}

function watchAttempts() {
  const attempts: string[] = [], query = Client.prototype.query;
  const listener = vi.spyOn(Client.prototype, "query").mockImplementation(function (this: Client, ...args: Parameters<typeof query>) {
    const input = args[0] as string | QueryConfig;
    const text = typeof input === "string" ? input : input.text;
    if (text?.toLowerCase().includes(producer)) attempts.push(this.user ?? "");
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
    (SELECT jsonb_agg(jsonb_build_array(event_type,status) ORDER BY event_type,status) FROM public.outbox_events) AS outbox`)).rows[0];
}

it.each([false, true])("preserves the mounted native worker with owner login and service role present=%s", async withService => {
  async function exercise(candidate: boolean) {
    if (!withService) {
      return withMeasuredAccountPrefix(candidate ? catalogue : predecessor, "legacy", "occurrence-mount", store => run(store, candidate));
    }
    const container = await runPostgresContainer({ name: `occurrence-legacy-service-${process.pid}`, password: "synthetic-occurrence" });
    const owner = new Pool({ connectionString: container.connectionString });
    try {
      expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
      await owner.query("CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS");
      await installMeasuredPrefix(candidate ? catalogue : predecessor, owner, { generation: "legacy" }, "legacy");
      return await run({ owner, runtime: owner }, candidate);
    } finally { await closePostgres(container, owner); }
  }

  async function run(pools: { owner: Pool; runtime: Pool }, candidate: boolean) {
    const { owner, runtime } = pools;
    expect((await runtime.query("SELECT session_user,current_user")).rows).toEqual([{ session_user: "postgres", current_user: "postgres" }]);
    const retained: Awaited<ReturnType<typeof occurrenceRows>> = [];
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
          if (!retained.length) {
            const negative = new Pool({ connectionString: login.toString() });
            try { await assertDeniedPaths(negative, subject); } finally { await negative.end(); }
            expect(watch.attempts.splice(0)).toEqual(["fixture_occurrence_plain"]);
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
        expect(retained).toHaveLength(3);
        expect(await occurrenceRows(owner)).toEqual(expect.arrayContaining(retained));
        expect(await occurrenceRows(owner)).toHaveLength(3);
        await emptyV3(owner);
      }
      return { effects, dispatch: await dispatchEffects(owner) };
    } finally { watch.close(); }
  }
  expect(await exercise(true)).toEqual(await exercise(false));
}, postgresSetupTimeoutMs);

it("compares a paid renewal under the actual starter login with a fixed occurrence on the renewed subscription", async () => {
  async function exercise(candidate: boolean) {
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
      await installMeasuredPrefix(candidate ? catalogue : predecessor, migration, installation, "bootstrap");
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
        const run = await runScheduledRenewal(url.toString(), config);
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
          persisted, dispatch };
      } finally { watch.close(); }
    } finally { await closePostgres(container, [runtime, migration, owner]); }
  }
  expect(await exercise(true)).toEqual(await exercise(false));
}, postgresSetupTimeoutMs);

it("has no mounted source callers and is absent from managed migrations", () => {
  for (const root of ["server", "src", "api", "packages/platform/src", "examples/neutral-store", "supabase/migrations"]) {
    for (const file of readdirSync(root, { recursive: true, encoding: "utf8" }).filter(path => /\.(?:[cm]?[jt]sx?|sql)$/u.test(path))) {
      expect(readFileSync(`${root}/${file}`, "utf8").toLowerCase().includes(producer), `${root}/${file}`).toBe(false);
    }
  }
});
