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
import { activation, allocate, probe, producer, signature } from "./nativeRenewalOccurrence.fixture.js";
import type { Db } from "./subscriptionNativeFixture.js";

const current = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
if (current?.schemaVersion !== 3) throw new Error("Expected the full native migration catalogue");
const catalogue = current;
const forward = catalogue.forward.at(-1)!;
if (!forward.file.endsWith("_native_renewal_occurrence_producer.sql")) throw new Error("Expected the producer at the fresh installation boundary");
const sql = readFileSync(forward.file, "utf8");
const predecessor = structuredClone(catalogue);
for (const plan of [predecessor, predecessor.qualified, predecessor.qualifiedAdmin]) plan.forward.pop();
predecessor.objectInventorySha256 = "e2313b0643586038d25261827855bfe062053d7385f2542de4dea349eae1b47f";
predecessor.qualified.objectInventorySha256.bootstrapMigrator.withRestore = "74fe3c59f86dc91724e0abd9c70264a7995cbd225cf92b5f6265fda3a99720f8";
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
  "installs the owner-only signature and denies the actual %s runtime and an unrelated definer", async profile => {
    const store = await installAccountMutations(profile, false, "occurrence-acl");
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
  }, postgresSetupTimeoutMs);

const emptyV3 = async (db: Db) => {
  const { rows } = await db.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'
    AND starts_with(tablename,'subscription_cycle_') AND tablename <> 'subscription_cycle_occurrences'`);
  for (const { tablename } of rows) {
    expect((await db.query(`SELECT count(*)::int AS count FROM public."${String(tablename).replaceAll('"', '""')}"`)).rows, tablename)
      .toEqual([{ count: 0 }]);
  }
};

it.each([false, true])("preserves the mounted native worker with owner login and service role present=%s", async withService => {
  async function exercise(candidate: boolean) {
    if (!withService) {
      return withPlatformCatalog(candidate ? catalogue : predecessor, async root => {
        const store = await installAccountMutations("legacy", false, "occurrence-mount", root);
        try { return await run(store, candidate); } finally { await store.close(); }
      });
    }
    const container = await runPostgresContainer({ name: `occurrence-legacy-service-${process.pid}`, password: "synthetic-occurrence" });
    const owner = new Pool({ connectionString: container.connectionString });
    try {
      expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
      await owner.query("CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS");
      const plan = candidate ? catalogue : predecessor;
      for (const unit of [plan.baseline, ...plan.forward]) await owner.query(readFileSync(unit.file, "utf8"));
      return await run({ owner, runtime: owner }, candidate);
    } finally { await closePostgres(container, owner); }
  }

  async function run(pools: { owner: Pool; runtime: Pool }, candidate: boolean) {
    const { owner, runtime } = pools;
    const f = await transaction(owner, db => activation(db), "COMMIT");
    await owner.query("UPDATE public.subscriptions SET next_cycle_at='2050-01-01Z' WHERE id=$1", [f.subscriptionId]);
    expect((await runtime.query("SELECT session_user,current_user")).rows).toEqual([{ session_user: "postgres", current_user: "postgres" }]);
    let retained: unknown, count: (() => Promise<number>) | undefined;
    const current = () => owner.query(`SELECT to_jsonb(o),xmin::text,ctid::text
      FROM public.subscription_cycle_occurrences o WHERE subscription_id=$1`, [f.subscriptionId]).then(r => r.rows);
    if (candidate) {
      await assertAcl(owner);
      await assertNoCallers(owner);
      count = await probe(owner, producer, signature, "fixture_producer_entries");
      expect(await count()).toBe(1);
      expect(await allocate(owner, f)).toMatchObject({ outcome: "created" });
      expect(await count()).toBe(2);
      retained = await current();
      await owner.query("CREATE ROLE fixture_occurrence_plain LOGIN NOINHERIT PASSWORD 'synthetic-occurrence'");
      const login = new URL(owner.options.connectionString!); login.username = "fixture_occurrence_plain"; login.password = "synthetic-occurrence";
      const negative = new Pool({ connectionString: login.toString() });
      try { await assertDeniedPaths(negative, f); } finally { await negative.end(); }
    }
    const watch = watchAttempts();
    try {
      const effects = await exerciseLegacyRenewals({ ...pools } as Parameters<typeof exerciseLegacyRenewals>[0]);
      expect(watch.attempts).toEqual([]);
      if (candidate) {
        expect(await count!()).toBe(2);
        expect(await current()).toEqual(retained);
        expect((await owner.query("SELECT count(*)::int AS count FROM public.subscription_cycle_occurrences")).rows).toEqual([{ count: 1 }]);
        await emptyV3(owner);
      }
      return effects;
    } finally { watch.close(); }
  }
  expect(await exercise(true)).toEqual(await exercise(false));
}, postgresSetupTimeoutMs);

it("observes attempts and entry separately while mounting the starter under its real runtime login", async () => {
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
    const runner = (root?: string) => createPostgresMigrationRunner({ connectionString: container.connectionString },
      { root, installation, poolFactory: () => migration });
    await withPlatformCatalog(predecessor, root => runner(root).apply());
    const f = await transaction(migration, db => activation(db), "COMMIT");
    await owner.query("UPDATE public.subscriptions SET next_cycle_at='2050-01-01Z' WHERE id=$1", [f.subscriptionId]);
    // Both mounted passes start with the same empty paid-mail queue.
    await owner.query("DELETE FROM public.outbox_events WHERE event_type='commerce.order.paid.email'");
    const config = structuredClone(Object.values(configurations)[0]!);
    config.renewal.enabled = true;
    const watch = watchAttempts();
    try {
      const before = await runScheduledRenewal(url.toString(), config);
      expect(before).toMatchObject({ renewals: [], retries: [], paidMail: { claimed: 0, processed: 0 } });
      expect(watch.attempts).toEqual([]);
      expect(await runner().apply()).toEqual({ applied: [forward.file] });
      await assertAcl(migration);
      const count = await probe(owner, producer, signature, "fixture_producer_entries");
      watch.attempts.length = 0;
      await expect(allocate(runtime, f)).rejects.toMatchObject(denied);
      expect(watch.attempts.splice(0)).toEqual(["starter_runtime"]);
      expect(await count()).toBe(1);
      expect(await allocate(migration, f)).toMatchObject({ outcome: "created" });
      expect(watch.attempts.splice(0)).toEqual(["postgres"]);
      expect(await count()).toBe(2);
      const retained = () => owner.query("SELECT to_jsonb(o),xmin::text,ctid::text FROM public.subscription_cycle_occurrences o").then(r => r.rows);
      const fixed = await retained();
      expect(await runScheduledRenewal(url.toString(), config)).toEqual({ ...before, paidMail: { ...before.paidMail, runMs: expect.any(Number) } });
      expect(watch.attempts).toEqual([]);
      expect(await count()).toBe(2);
      expect(await retained()).toEqual(fixed);
      await emptyV3(owner);
    } finally { watch.close(); }
  } finally { await closePostgres(container, [runtime, migration, owner]); }
}, postgresSetupTimeoutMs);

it("has no mounted source callers and is absent from managed migrations", () => {
  for (const root of ["server", "src", "api", "packages/platform/src", "examples/neutral-store", "supabase/migrations"]) {
    for (const file of readdirSync(root, { recursive: true, encoding: "utf8" }).filter(path => /\.(?:[cm]?[jt]sx?|sql)$/u.test(path))) {
      expect(readFileSync(`${root}/${file}`, "utf8").toLowerCase().includes(producer), `${root}/${file}`).toBe(false);
    }
  }
});
