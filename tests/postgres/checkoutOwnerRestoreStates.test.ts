import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client, Pool } from "pg";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, aroundEach, beforeAll, expect, it, vi } from "vitest";
import type { QualifiedAdminPostgresInstallation, QualifiedPostgresInstallation } from "@openlup/platform/migrations";
import { checkPlatformMigrationProjection } from "../../scripts/packages/platform-migration-projection.js";
import { checkoutOwnerDefinitionPath, checkoutOwnerLogin, checkoutOwnerRoutines,
  renderCheckoutOwnerGrant, selectPlatformMigrationManifest, sha256 } from "../../scripts/platform-migration-manifest.js";
import { captureConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { grantPath, provisionCheckoutOwner, withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { closePostgres, postgresSetupTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";

const states = ["absent", "dormant", "granted"] as const;
type State = typeof states[number];
type Selection = QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation;
type InstalledMigrations = typeof import("@openlup/platform/migrations");
type Profile = "bootstrap" | "separate" | "admin-managed" | "admin-operator";
const profiles: Profile[] = ["bootstrap", "separate", "admin-managed", "admin-operator"];
const lockName = "openlup:public-platform-migrations:v1";
const password = "synthetic-checkout-restore";
const groups = ["anon", "authenticated", "service_role", "platform_acquisition_owner",
  "platform_acquisition_runtime", "openlup_retained_import_owner"];
const revoke = `REVOKE EXECUTE ON FUNCTION ${checkoutOwnerRoutines.join(", ")} FROM ${checkoutOwnerLogin}`;

async function withGrantArtifact<T>(work: (pkg: InstalledMigrations, root: string, inventory: Parameters<typeof withPlatformCatalog>[0]) => Promise<T>) {
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as Parameters<typeof withPlatformCatalog>[0];
  return withPlatformCatalog(manifest, async root => {
    const definition = manifest.forward.find(unit => checkoutOwnerDefinitionPath.test(unit.file))!;
    const sql = renderCheckoutOwnerGrant(definition.file, definition.sha256);
    for (const plan of [manifest, manifest.qualified, manifest.qualifiedAdmin]) {
      plan.forward.push({ file: grantPath, sha256: sha256(sql) });
    }
    writeFileSync(join(root, grantPath), sql);
    writeFileSync(join(root, "config/platform-migration-manifest.json"), JSON.stringify(manifest));
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "packages/platform/src/migrations"), { recursive: true });
    mkdirSync(join(root, "packages/platform/sql"));
    cpSync("scripts/platform-migration-manifest.ts", join(root, "scripts/platform-migration-manifest.ts"));
    cpSync("packages/platform/package.json", join(root, "packages/platform/package.json"));
    cpSync("packages/platform/dist/migrations", join(root, "packages/platform/dist/migrations"), { recursive: true });
    symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
    expect(checkPlatformMigrationProjection(root, true)).toEqual([]);
    const pkg = await import(pathToFileURL(join(root, "packages/platform/dist/migrations/index.js")).href) as InstalledMigrations;
    return work(pkg, root, manifest);
  });
}

// Use the same role bindings as the measured installation profiles.
function select(profile: Profile): Selection & { restoreLogin: string } {
  const shared = { bootstrapLogin: "postgres", migrationLogin: profile === "bootstrap" ? "postgres" : "transfer_m",
    runtimeLogin: "transfer_r", restoreLogin: "transfer_s" };
  if (profile === "admin-operator") return { ...shared, generation: "qualified-admin", roleMode: "operator-provisioned", operatorLogin: "transfer_o" };
  if (profile === "admin-managed") return { ...shared, generation: "qualified-admin", roleMode: "installer-managed" };
  return { ...shared, generation: "qualified-v2", roleMode: "installer-managed" };
}

async function install(pkg: InstalledMigrations, label: string, selection: ReturnType<typeof select>) {
  const container = await runPostgresContainer({ name: `checkout-restore-${label}-${process.pid}`, password });
  const pools: Pool[] = [];
  const pool = (connectionString: string, options?: string) => {
    const created = new Pool({ connectionString, options });
    pools.push(created);
    return created;
  };
  const urlFor = (role: string, database = "postgres") => {
    const result = new URL(container.connectionStringFor(database));
    result.username = role;
    return result.toString();
  };
  const close = () => closePostgres(container, pools);
  try {
    expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
    const bootstrap = pool(urlFor(selection.bootstrapLogin, "template1"));
    const m = selection.migrationLogin, r = selection.runtimeLogin, s = selection.restoreLogin;
    const admin = selection.generation === "qualified-admin";
    if (m !== selection.bootstrapLogin) {
      await bootstrap.query(`CREATE ROLE ${m} LOGIN ${admin ? "NOINHERIT NOSUPERUSER" : "INHERIT SUPERUSER"}
        ${admin && selection.roleMode === "installer-managed" ? "CREATEROLE" : "NOCREATEROLE"} PASSWORD '${password}';
        ALTER DATABASE postgres OWNER TO ${m}`);
    }
    await bootstrap.query(`CREATE ROLE ${r} LOGIN NOINHERIT PASSWORD '${password}';
      CREATE ROLE ${s} LOGIN NOINHERIT PASSWORD '${password}'`);
    let operator: Pool | undefined;
    if (admin && selection.roleMode === "operator-provisioned") {
      const o = selection.operatorLogin;
      await bootstrap.query(`CREATE ROLE ${o} LOGIN NOINHERIT CREATEROLE PASSWORD '${password}'`);
      operator = pool(urlFor(o, "template1"));
      for (const group of groups) {
        await operator.query(`CREATE ROLE ${group} NOLOGIN NOINHERIT;
          GRANT ${group} TO ${m} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY ${o}`);
        if (["anon", "authenticated", "service_role", "platform_acquisition_runtime"].includes(group)) {
          await operator.query(`GRANT ${group} TO ${r} WITH ADMIN FALSE, INHERIT ${group === "service_role"}, SET TRUE GRANTED BY ${o}`);
        }
      }
    }
    const bind = (database: string) => {
      const url = (role: string) => urlFor(role, database);
      const env = { connectionString: url(m) };
      const owner = pool(url(m), admin ? pkg.qualifiedAdminPostgresStartupOptions(selection) : pkg.qualifiedPostgresStartupOptions(selection));
      const runner = pkg.createPlatformPostgresMigrationRunner(env, { installation: selection, poolFactory: () => owner });
      const ledger = async () => (await owner.query("SELECT to_jsonb(m)::text AS row FROM ONLY public.platform_schema_migrations m ORDER BY position")).rows;
      const acl = async () => (await owner.query(`SELECT p.oid::regprocedure::text AS routine,p.proacl::text AS acl
        FROM pg_catalog.pg_proc p WHERE p.oid=ANY(ARRAY(SELECT to_regprocedure(sig) FROM unnest($1::text[]) sig))
        ORDER BY routine`, [checkoutOwnerRoutines])).rows;
      const project = async () => {
        const db = await owner.connect();
        try {
          await db.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [lockName]);
          return await (admin ? pkg.qualifiedAdminPostgresCatalogPayload(db, selection, lockName)
            : pkg.qualifiedPostgresCatalogPayload(db, selection, lockName));
        } finally {
          await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockName]);
          db.release();
        }
      };
      let current: State = "absent";
      const grant = () => pkg.applyPlatformCheckoutOwnerGrant(env, selection);
      const state = async (next: State) => {
        if (next === current) return;
        // A concurrent grant can commit before the fixture records it.
        if (next === "absent" || current === "granted") await owner.query(revoke);
        if (current === "absent") await provisionCheckoutOwner(bootstrap, selection, database, password, operator);
        if (next === "absent") await bootstrap.query(`DROP ROLE ${checkoutOwnerLogin}`);
        if (next === "granted") expect(await grant()).toEqual({ state: "granted" });
        current = next;
      };
      return { owner, bootstrap, selection, runner, ledger, acl, project, state, grant, url };
    };
    const template = bind("postgres");
    expect((await template.runner.apply()).applied.at(-1)).toBe(grantPath);
    expect((await template.runner.apply()).applied).toEqual([]);
    let templateClosed = false;
    const end = async (owner: Pool) => {
      await owner.end();
      pools.splice(pools.indexOf(owner), 1);
    };
    const clone = async (database: string) => {
      if (!templateClosed) { await end(template.owner); templateClosed = true; }
      await bootstrap.query(`CREATE DATABASE ${database} TEMPLATE postgres OWNER ${m}`);
      const target = bind(database);
      return { ...target, async dispose() {
        await target.state("absent");
        await end(target.owner);
        await bootstrap.query(`DROP DATABASE ${database}`);
      } };
    };
    const restore = new Pool({ connectionString: urlFor(s) });
    try { expect((await restore.query("SELECT session_user AS login")).rows).toEqual([{ login: s }]); }
    finally { await restore.end(); }
    return { template, clone, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Checkout restore setup and cleanup both failed");
    }
    throw error;
  }
}

type Installation = Awaited<ReturnType<typeof install>>["template"];

async function withDisposal(fixture: { dispose(): Promise<void> }, work: () => Promise<void>) {
  try {
    await work();
  } catch (error) {
    try {
      await fixture.dispose();
    } catch (teardownError) {
      throw new AggregateError([error, teardownError], "Fixture body and teardown both failed");
    }
    throw error;
  }
  await fixture.dispose();
}

async function capture(host: Installation, id: string, catalogueId: string) {
  const db = await host.owner.connect();
  const migrator = host.selection.migrationLogin;
  const restricted = host.selection.generation === "qualified-admin";
  try {
    if (restricted) await db.query(`GRANT platform_acquisition_owner TO ${migrator}
      WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY ${migrator}`);
    return await captureConnectedNativeStore({ sourceId: id, catalogueId, maximumRows: 10000,
      maximumBytes: 64 * 1024 * 1024, source: { async withSnapshot(work) {
        await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        try {
          const packet = await work({ query: (sql, values) => db.query(sql, values ? [...values] : undefined) });
          await db.query("COMMIT");
          return packet;
        } catch (error) { await db.query("ROLLBACK"); throw error; }
      } } });
  } finally {
    if (restricted) await db.query(`REVOKE platform_acquisition_owner FROM ${migrator} GRANTED BY ${migrator}`);
    db.release();
  }
}

async function grantAlongsideRestore(target: Installation, restore: () => ReturnType<typeof restoreConnectedNativeStore>) {
  const acl = await target.acl(), ledger = await target.ledger();
  const originalQuery = Client.prototype.query;
  const barrier = () => {
    let open!: () => void;
    const promise = new Promise<void>(resolve => { open = resolve; });
    return { promise, open };
  };
  const granted = barrier(), release = barrier(), waiting = barrier();
  let injectFailure = true, contenders = 0, firstGrant = true, observeContenders = false;
  const query = vi.spyOn(Client.prototype, "query").mockImplementation(function (this: Client, ...args: unknown[]) {
    const result = Reflect.apply(originalQuery, this, args);
    const sql = args[0];
    if (observeContenders && typeof sql === "string" && sql.startsWith("SELECT pg_catalog.pg_advisory_lock(")) {
      if (++contenders === 3) waiting.open();
    }
    if (typeof sql === "string" && sql.startsWith("DO $$\nDECLARE\n  checkout_login")) {
      return Promise.resolve(result).then(async value => {
        if (injectFailure) throw new Error("Fixture interrupted after the grant");
        if (firstGrant) {
          firstGrant = false;
          granted.open();
          await release.promise;
        }
        return value;
      });
    }
    return result;
  } as typeof originalQuery);
  const bounded = async (event: Promise<void>) => {
    const timer = new AbortController();
    try {
      await Promise.race([event, delay(60_000, undefined, { signal: timer.signal, ref: false })
        .then(() => { throw new Error("Fixture grant barrier was not reached"); })]);
    } finally {
      timer.abort();
    }
  };
  let operations: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await expect(target.grant()).rejects.toThrow("Fixture interrupted after the grant");
    expect(await target.acl()).toEqual(acl);
    expect(await target.ledger()).toEqual(ledger);
    injectFailure = false;
    const initial = target.grant();
    operations = Promise.allSettled([initial]);
    await bounded(granted.promise);
    observeContenders = true;
    operations = Promise.allSettled([initial, target.grant(), target.runner.apply(), restore()]);
    await bounded(waiting.promise);
    expect(await target.acl()).toEqual(acl);
    release.open();
    const results = await operations;
    expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
    expect(results[0]).toEqual({ status: "fulfilled", value: { state: "granted" } });
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual({ status: "fulfilled", value: { applied: [] } });
    expect(results[3]).toMatchObject({ status: "fulfilled", value: { replayed: false } });
    expect(await target.ledger()).toEqual(ledger);
  } finally {
    release.open();
    await operations;
    query.mockRestore();
  }
  await target.state("granted");
  await target.state("dormant");
}

async function refusesConcurrentRoutineChange(target: Installation) {
  const ledger = await target.ledger(), acl = await target.acl();
  const database = "transfer_absent_dormant";
  const routine = checkoutOwnerRoutines[0];
  const writer = await target.owner.connect();
  const originalQuery = Client.prototype.query;
  let committed = false, attemptedGrant = false;
  const query = vi.spyOn(Client.prototype, "query").mockImplementation(function (this: Client, ...args: unknown[]) {
    const sql = args[0];
    if (typeof sql === "string" && sql.startsWith("DO $$\nDECLARE\n  checkout_login")) attemptedGrant = true;
    if (sql !== "LOCK TABLE ONLY public.platform_schema_migrations IN SHARE ROW EXCLUSIVE MODE") {
      return Reflect.apply(originalQuery, this, args);
    }
    return (async () => {
      const isolation = await Reflect.apply(originalQuery, this, [`SELECT
        current_setting('default_transaction_isolation') AS session_default,
        current_setting('transaction_isolation') AS active`]);
      expect(isolation.rows).toEqual([{ session_default: "repeatable read", active: "read committed" }]);
      // The runner has read ledger identity. Commit on the competing connection
      // just before it acquires the ledger lock and checks the live definition.
      await writer.query("COMMIT");
      committed = true;
      return Reflect.apply(originalQuery, this, args);
    })();
  } as typeof originalQuery);
  try {
    await target.bootstrap.query(`ALTER DATABASE ${database} SET default_transaction_isolation = 'repeatable read'`);
    await writer.query("BEGIN; SET LOCAL statement_timeout = '60s'; SET LOCAL idle_in_transaction_session_timeout = '60s'");
    await Reflect.apply(originalQuery, writer, ["LOCK TABLE ONLY public.platform_schema_migrations IN SHARE ROW EXCLUSIVE MODE"]);
    await writer.query(`ALTER FUNCTION ${routine} SECURITY INVOKER`);
    await expect(target.grant()).rejects.toThrow("checkout_owner_predecessor_unverified");
    expect(committed).toBe(true);
    expect(attemptedGrant).toBe(false);
    expect(await target.ledger()).toEqual(ledger);
    expect(await target.acl()).toEqual(acl);
  } finally {
    query.mockRestore();
    if (!committed) await writer.query("ROLLBACK").catch(() => {});
    writer.release(!committed);
    await target.bootstrap.query(`ALTER DATABASE ${database} RESET default_transaction_isolation`);
    if (committed) await target.owner.query(`ALTER FUNCTION ${routine} SECURITY DEFINER`);
  }
}

const clients = (host: Installation) => host.owner.query("SELECT id,email FROM public.clients ORDER BY id").then(result => result.rows);
const subscriptions = (host: Installation) => host.owner.query(`SELECT id,client_id,cadence_days,configured_offer_version
  FROM public.subscriptions ORDER BY id`).then(result => result.rows);

async function verifyLaterDefinition(source: Installation, root: string, manifest: Parameters<typeof withPlatformCatalog>[0]) {
  await source.state("dormant");
  const routine = checkoutOwnerRoutines[2];
  const { rows: [live] } = await source.owner.query<{ definition: string }>(
    "SELECT pg_get_functiondef(to_regprocedure($1)) AS definition", [routine]);
  const sql = live!.definition.replace("BEGIN", "BEGIN\n  -- Approved replacement fixture.") + ";\n";
  const file = "db/platform/migrations/20990101000200_checkout_definition_fixture.sql";
  const originalManifestText = readFileSync(join(root, "config/platform-migration-manifest.json"), "utf8");
  const workingManifest = structuredClone(manifest);
  for (const plan of [workingManifest, workingManifest.qualified, workingManifest.qualifiedAdmin]) {
    plan.forward.push({ file, sha256: sha256(sql) });
  }
  const stageManifest = () => {
    writeFileSync(join(root, "config/platform-migration-manifest.json"), JSON.stringify(workingManifest));
    expect(checkPlatformMigrationProjection(root, true)).toEqual([]);
  };
  try {
    writeFileSync(join(root, file), sql);
    stageManifest();
    await expect(source.runner.apply()).rejects.toThrow("object inventory SHA-256 mismatch");
    const applied = await source.ledger(), acl = await source.acl();
    await expect(source.grant()).rejects.toThrow("object inventory SHA-256 mismatch");
    expect(await source.acl()).toEqual(acl);
    workingManifest.qualified.objectInventorySha256.bootstrapMigrator.withRestore = sha256(await source.project());
    stageManifest();
    expect(await source.grant()).toEqual({ state: "granted" });
    expect(await source.ledger()).toEqual(applied);
  } finally {
    rmSync(join(root, file), { force: true });
    rmSync(join(root, "packages/platform/sql/20990101000200_checkout_definition_fixture.sql"), { force: true });
    writeFileSync(join(root, "config/platform-migration-manifest.json"), originalManifestText);
    expect(checkPlatformMigrationProjection(root, true)).toEqual([]);
  }
}

type SharedGrantArtifact = {
  pkg: InstalledMigrations;
  root: string;
  manifest: Parameters<typeof withPlatformCatalog>[0];
  dispose: () => Promise<void>;
};

let sharedArtifact: Promise<SharedGrantArtifact>;
let pendingFixtureWork = Promise.resolve();

aroundEach(async (runTest, { signal }) => {
  // Drain the previous callback before the global beforeEach restores its spies.
  await pendingFixtureWork;
  signal.throwIfAborted();
  await runTest();
}, postgresSetupTimeoutMs);

function runFixtureWork(work: () => Promise<void>) {
  const operation = work();
  pendingFixtureWork = operation.then(() => undefined, () => undefined);
  return operation;
}

beforeAll(async () => {
  sharedArtifact = new Promise<SharedGrantArtifact>((resolveReady, rejectReady) => {
    let release!: () => void;
    const done = new Promise<void>(resolveDone => { release = resolveDone; });
    const lifecycle = withGrantArtifact(async (pkg, root, manifest) => {
      resolveReady({ pkg, root, manifest, dispose: async () => { release(); await lifecycle; } });
      await done;
    });
    lifecycle.catch(rejectReady);
  });
  await sharedArtifact;
}, postgresSetupTimeoutMs);

afterAll(async () => {
  await pendingFixtureWork;
  const artifact = await sharedArtifact?.catch(() => undefined);
  await artifact?.dispose();
}, postgresSetupTimeoutMs);

function throwSettledErrors(errors: readonly unknown[], message: string): never {
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}

async function closeFixtures(fixtures: readonly { close(): Promise<void> }[]) {
  const results = await Promise.allSettled(fixtures.map(fixture => fixture.close()));
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length > 0) throwSettledErrors(errors, "Checkout restore fixture cleanup failed");
}

async function installPair(pkg: InstalledMigrations, profile: Profile, selection: ReturnType<typeof select>) {
  // Bound concurrency to 2 disposable clusters (source + target) so cluster-wide
  // checkoutOwnerLogin states remain strictly isolated while halving setup wall time.
  const [sourceResult, targetResult] = await Promise.allSettled([
    install(pkg, `${profile}-source`, selection),
    install(pkg, `${profile}-target`, selection),
  ]);
  if (sourceResult.status === "fulfilled" && targetResult.status === "fulfilled") {
    return [sourceResult.value, targetResult.value] as const;
  }
  const setupErrors = [sourceResult, targetResult].flatMap(result => result.status === "rejected" ? [result.reason] : []);
  const fulfilled = [sourceResult, targetResult].flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  const cleanupResults = await Promise.allSettled(fulfilled.map(fixture => fixture.close()));
  const cleanupErrors = cleanupResults.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  throwSettledErrors([...setupErrors, ...cleanupErrors], "Checkout restore pair setup/cleanup failed");
}

async function verifyRestoreProfile(profile: Profile, pkg: InstalledMigrations, root: string, manifest: Parameters<typeof withPlatformCatalog>[0]) {
  const selection = select(profile);
  const expected = selectPlatformMigrationManifest(manifest, selection.generation, selection.generation === "qualified-admin"
    ? { roleMode: selection.roleMode } : { migrationIsBootstrap: profile === "bootstrap", hasRestore: true });
  const [sourceFixture, targetFixture] = await installPair(pkg, profile, selection);
  const source = sourceFixture.template;
  await withDisposal({ dispose: () => closeFixtures([targetFixture, sourceFixture]) }, async () => {
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
        const original = await source.project();
        const catalogueId = createHash("sha256").update(original).digest("hex");
        expect(catalogueId).toBe(expected.objectInventorySha256);
        expect(await targetFixture.template.project()).toBe(original);
        const sourceLedger = await source.ledger(), targetLedger = await targetFixture.template.ledger();
        const clientId = randomUUID(), subscriptionId = randomUUID();
        await source.owner.query("INSERT INTO public.clients(id,email) VALUES($1,'restore@example.invalid')", [clientId]);
        await source.owner.query(`INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at)
          VALUES($1,$2,28,'2027-01-01T00:00:00Z')`, [subscriptionId, clientId]);
        const sourceClients = await clients(source), sourceSubscriptions = await subscriptions(source);
        expect(sourceSubscriptions).toEqual([{ id: subscriptionId, client_id: clientId, cadence_days: 28, configured_offer_version: "classic" }]);
        for (const from of states) {
          await source.state(from);
          const catalog = await source.project();
          expect(catalog).toBe(original);
          if (from === "dormant" && profile === "bootstrap") {
            const checkout = new Pool({ connectionString: source.url(checkoutOwnerLogin) });
            try {
              expect((await checkout.query(`SELECT public.customer_support_search_normalize('A') AS value,
                public.customer_support_search_digits('1') AS digits`)).rows).toEqual([{ value: "a", digits: "1" }]);
            } finally { await checkout.end(); }
          }
          // All profiles observe every source state above. One absent-to-granted
          // restore per additional profile exercises its login binding, checkout
          // provisioning, partial-grant refusal and successful restore/replay.
          if (profile !== "bootstrap" && from !== "absent") continue;
          const packet = await capture(source, "checkout-source", sha256(catalog));
          for (const to of profile === "bootstrap" ? states : ["granted"] as const) {
            const target = await targetFixture.clone(`transfer_${from}_${to}`);
            await withDisposal(target, async () => {
              await target.state(to);
              expect(await target.project()).toBe(original);
              const acl = await target.acl();
              const freshTarget = await capture(target, "checkout-target", catalogueId);
              const input = { owner: target.owner, installation: selection, packet, freshTarget };
              if (from === "absent" && to === "absent") {
                await target.owner.query(`GRANT EXECUTE ON FUNCTION ${checkoutOwnerRoutines[0]} TO PUBLIC`);
                await expect(target.project()).rejects.toThrow("checkout_owner_acl_mismatch");
                await expect(restoreConnectedNativeStore(input)).rejects.toMatchObject({ code: "database_unavailable" });
                expect(await clients(target)).toEqual([]);
                await target.owner.query(`REVOKE EXECUTE ON FUNCTION ${checkoutOwnerRoutines[0]} FROM PUBLIC`);
              }
              if (from === "absent" && to === "granted") {
                if (profile === "bootstrap") {
                  const sibling = await targetFixture.clone("transfer_other_database");
                  await withDisposal(sibling, async () => {
                    await target.bootstrap.query(`REVOKE TEMP ON DATABASE transfer_other_database FROM PUBLIC;
                      GRANT TEMP ON DATABASE transfer_other_database TO ${selection.runtimeLogin},${selection.restoreLogin}`);
                    const login = new Pool({ connectionString: sibling.url(checkoutOwnerLogin) });
                    try {
                      expect((await login.query("SELECT has_function_privilege($1,'EXECUTE') AS granted", [checkoutOwnerRoutines[0]])).rows)
                        .toEqual([{ granted: false }]);
                    } finally { await login.end(); }
                    expect(await sibling.project()).toBe(original);
                  });
                }
                await target.owner.query(`REVOKE EXECUTE ON FUNCTION ${checkoutOwnerRoutines[0]} FROM ${checkoutOwnerLogin}`);
                await expect(restoreConnectedNativeStore(input)).rejects.toMatchObject({ code: "database_unavailable" });
                expect(await clients(target)).toEqual([]);
                expect(await subscriptions(target)).toEqual([]);
                await target.owner.query(`GRANT EXECUTE ON FUNCTION ${checkoutOwnerRoutines[0]} TO ${checkoutOwnerLogin}`);
              }
              if (profile === "bootstrap" && from === "dormant" && to === "granted") {
                const routine = checkoutOwnerRoutines[0];
                await target.owner.query(`GRANT EXECUTE ON FUNCTION ${routine} TO service_role WITH GRANT OPTION;
                  SET ROLE service_role; GRANT EXECUTE ON FUNCTION ${routine} TO ${checkoutOwnerLogin}; RESET ROLE`);
                await expect(target.project()).rejects.toThrow("checkout_owner_acl_mismatch");
                await target.owner.query(`REVOKE EXECUTE ON FUNCTION ${routine} FROM service_role CASCADE`);
                await target.owner.query(`ALTER FUNCTION ${routine} SECURITY INVOKER`);
                await expect(target.project()).rejects.toThrow("checkout_owner_predecessor_unverified");
                await target.owner.query(`ALTER FUNCTION ${routine} SECURITY DEFINER`);
                await target.owner.query("GRANT SELECT (id) ON public.clients TO anon");
                await expect(target.runner.status()).rejects.toThrow("object inventory SHA-256 mismatch");
                expect(await target.project()).not.toBe(original);
                await target.owner.query("REVOKE SELECT (id) ON public.clients FROM anon");
              }
              if (profile === "bootstrap" && from === "absent" && to === "dormant") {
                await refusesConcurrentRoutineChange(target);
                await grantAlongsideRestore(target, () => restoreConnectedNativeStore(input));
              } else expect((await restoreConnectedNativeStore(input)).replayed).toBe(false);
              expect(await clients(target)).toEqual(sourceClients);
              expect(await subscriptions(target)).toEqual(sourceSubscriptions);
              expect((await restoreConnectedNativeStore(input)).replayed).toBe(true);
              expect(await target.acl()).toEqual(acl);
              expect(await target.ledger()).toEqual(targetLedger);
            });
          }
        }
        expect(await source.ledger()).toEqual(sourceLedger);
        if (profile === "bootstrap") await verifyLaterDefinition(source, root, manifest);
      } finally {
        cwd.mockRestore();
      }
  });
}

for (const profile of profiles) {
  it(`restores the same nonempty checkout graph on ${profile}`, () =>
    runFixtureWork(async () => {
      // The later-definition proof mutates the packed manifest in the bootstrap case.
      if (profile === "bootstrap") {
        await withGrantArtifact((pkg, root, manifest) => verifyRestoreProfile(profile, pkg, root, manifest));
        return;
      }
      const { pkg, root, manifest } = await sharedArtifact;
      await verifyRestoreProfile(profile, pkg, root, manifest);
    }), Math.max(245_000, postgresSetupTimeoutMs));
}

async function verifyLegacyNoOp(pkg: InstalledMigrations, state: "absent" | "present") {
  const container = await runPostgresContainer({ name: `checkout-legacy-${state}-${process.pid}`, password });
  const owner = new Pool({ connectionString: container.connectionString });
  const env = { connectionString: container.connectionString };
  const options = { installation: { generation: "legacy" as const }, poolFactory: () => owner };
  await withDisposal({ dispose: () => closePostgres(container, [owner]) }, async () => {
    expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
    const before = await import("@openlup/platform/migrations");
    await before.createPlatformPostgresMigrationRunner(env, options).apply();
    if (state === "present") await owner.query(`CREATE ROLE ${checkoutOwnerLogin} LOGIN NOINHERIT`);
    const ledger = async () => (await owner.query("SELECT catalog_path,sha256,position,executed_at::text FROM ONLY public.platform_schema_migrations ORDER BY position")).rows;
    const applied = await ledger();
    const runner = pkg.createPlatformPostgresMigrationRunner(env, options);
    if (state === "present") {
      await expect(runner.apply()).rejects.toThrow("object inventory SHA-256 mismatch");
      expect((await owner.query(`SELECT pg_catalog.count(*)::int AS grants FROM pg_catalog.pg_proc p
        WHERE p.proname LIKE 'catalog_admission_%' AND pg_catalog.has_function_privilege($1,p.oid,'EXECUTE')
          AND (p.prosecdef OR p.proacl IS NOT NULL)`, [checkoutOwnerLogin])).rows).toEqual([{ grants: 0 }]);
      await owner.query(`DROP ROLE ${checkoutOwnerLogin}`);
    } else expect(await runner.apply()).toEqual({ applied: [grantPath] });
    const after = await ledger();
    expect(after.slice(0, -1)).toEqual(applied);
    expect(after).toHaveLength(applied.length + 1);
    expect(after.at(-1)?.catalog_path).toBe(grantPath);
    expect(await runner.apply()).toEqual({ applied: [] });
    expect(await ledger()).toEqual(after);
  });
}

it("records the legacy no-op with the cluster login absent and present", () =>
  runFixtureWork(async () => {
    const { pkg } = await sharedArtifact;
    const results = await Promise.allSettled([
      verifyLegacyNoOp(pkg, "absent"),
      verifyLegacyNoOp(pkg, "present"),
    ]);
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length > 0) throwSettledErrors(errors, "Legacy no-op verification failed in both states");
  }), Math.max(245_000, postgresSetupTimeoutMs));
