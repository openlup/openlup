import installationInventory from "./current-installation-inventory.json" with { type: "json" };
import { readFileSync } from "node:fs";
import { Pool, type PoolClient, type QueryConfig } from "pg";
import { expect } from "vitest";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { captureConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedAdminPostgresStartupOptions, type QualifiedAdminPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

export type RestrictedRestoreShape = "neon" | "rds";
export type RestrictedRestoreMode = "installer-managed" | "operator-provisioned";
export type RestrictedRestoreInstalled = {
  container: PostgresContainer;
  pools: Pool[];
  owner: Pool;
  runner: ReturnType<typeof createPostgresMigrationRunner>;
  selection: QualifiedAdminPostgresInstallation;
  inventory: string;
};

const password = "synthetic-restricted-restore";
const groups = ["anon", "authenticated", "service_role", "platform_acquisition_owner",
  "platform_acquisition_runtime", "openlup_retained_import_owner"];

export async function installRestrictedRestore(
  shape: RestrictedRestoreShape,
  mode: RestrictedRestoreMode,
  label: string,
  apply = true,
  expectCase = expect,
): Promise<RestrictedRestoreInstalled> {
  const container = await runPostgresContainer({ name: `m14-restricted-connected-${shape}-${mode}-${label}-${process.pid}`, password });
  const pools: Pool[] = [];
  try {
    expectCase(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
    const pool = (url: string): Pool => { const p = new Pool({ connectionString: url }); pools.push(p); return p; };
    let root = pool(container.connectionString);
    const namedUrl = (name: string): string => { const url = new URL(container.connectionString); url.username = name; return url.toString(); };
    const rootName = shape === "rds" ? "rdsadmin" : "postgres";
    if (shape === "rds") {
      await root.query(`CREATE ROLE fixture_root_rename LOGIN SUPERUSER PASSWORD '${password}'`);
      const renamer = pool(namedUrl("fixture_root_rename"));
      await renamer.query("ALTER ROLE postgres RENAME TO rdsadmin");
      await Promise.all(pools.map(p => p.end())); pools.length = 0;
      root = pool(namedUrl(rootName));
      await root.query("DROP ROLE fixture_root_rename");
    }
    const m = "restore_m", r = "restore_r", s = "restore_s", o = "restore_o";
    const provider = shape === "neon" ? "neon_superuser" : "rds_superuser";
    await root.query(`CREATE ROLE ${provider} NOLOGIN NOINHERIT NOSUPERUSER ${shape === "rds" ? "NOCREATEROLE NOCREATEDB" : "CREATEROLE CREATEDB"} NOREPLICATION NOBYPASSRLS`);
    if (shape === "rds") await root.query(`GRANT pg_monitor,pg_read_all_data,pg_write_all_data TO ${provider} WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`);
    await root.query(`CREATE ROLE host_bootstrap LOGIN INHERIT NOSUPERUSER CREATEROLE CREATEDB
      ${shape === "neon" ? "REPLICATION" : "NOREPLICATION"} NOBYPASSRLS VALID UNTIL 'infinity' PASSWORD '${password}'`);
    await root.query(`GRANT ${provider} TO host_bootstrap WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`);
    await root.query("REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM PUBLIC");
    await root.query(`CREATE ROLE ${m} LOGIN NOINHERIT NOSUPERUSER ${mode === "installer-managed" ? "CREATEROLE" : "NOCREATEROLE"}
      NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    await root.query(`CREATE ROLE ${r} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    await root.query(`CREATE ROLE ${s} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    await root.query(`ALTER DATABASE postgres OWNER TO ${m}`);
    if (mode === "operator-provisioned") {
      await root.query(`CREATE ROLE ${o} LOGIN NOINHERIT NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      const operator = pool(namedUrl(o));
      for (const group of groups) {
        await operator.query(`CREATE ROLE ${group} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS`);
        await operator.query(`GRANT ${group} TO ${m} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY ${o}`);
        if (["anon", "authenticated", "service_role", "platform_acquisition_runtime"].includes(group))
          await operator.query(`GRANT ${group} TO ${r} WITH ADMIN FALSE, INHERIT ${group === "service_role" ? "TRUE" : "FALSE"}, SET TRUE GRANTED BY ${o}`);
      }
    }
    // The observed provider principal is a non-superuser with the documented
    // CREATEROLE/CREATEDB shape and a managed elevated-role membership.
    const selection: QualifiedAdminPostgresInstallation = mode === "installer-managed"
      ? { generation: "qualified-admin", roleMode: mode, migrationLogin: m, bootstrapLogin: "host_bootstrap", runtimeLogin: r,
        restoreLogin: s, trustedControlPlane: { roleNames: [provider, rootName] } }
      : { generation: "qualified-admin", roleMode: mode, migrationLogin: m, bootstrapLogin: "host_bootstrap", runtimeLogin: r,
        restoreLogin: s, operatorLogin: o, trustedControlPlane: { roleNames: [provider, rootName] } };
    if (shape === "rds") {
      selection.target = "rds"; selection.layout = "serial-cluster";
    }
    const url = new URL(namedUrl(m)); url.searchParams.set("options", qualifiedAdminPostgresStartupOptions(selection));
    const owner = pool(url.toString());
    const runner = createPostgresMigrationRunner({ connectionString: namedUrl(m) }, { installation: selection, poolFactory: () => owner });
    const manifest = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")),
      "qualified-admin", { roleMode: mode });
    // This small admission discriminator runs before the full migration/restore.
    expectCase((await owner.query("SELECT rolsuper,rolcreaterole,rolcreatedb FROM pg_catalog.pg_roles WHERE rolname=$1",
      [selection.bootstrapLogin])).rows).toEqual([{ rolsuper: false, rolcreaterole: true, rolcreatedb: true }]);
    await expectCase(owner.query("SELECT * FROM pg_catalog.pg_control_system()")).rejects.toMatchObject({ code: "42501" });
    expectCase(1 + manifest.forward.length).toBe(installationInventory.current.profiles[mode === "installer-managed" ? "admin-managed" : "admin-operator"].count);
    expectCase((await runner.status()).pending).toHaveLength(1 + manifest.forward.length);
    if (apply) {
      expectCase((await runner.apply()).applied).toHaveLength(1 + manifest.forward.length);
      expectCase((await runner.status()).pending).toEqual([]);
    }
    return { container, pools, owner, runner, selection, inventory: manifest.objectInventorySha256 };
  } catch (error) {
    try {
      await closePostgres(container, pools);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Restricted restore setup and cleanup both failed");
    }
    throw error;
  }
}

// Bounds source/target provisioning to two concurrent containers per test and
// tears down any fulfilled container before rethrowing a partial setup failure.
export async function installRestrictedRestorePair(
  shape: RestrictedRestoreShape,
  mode: RestrictedRestoreMode,
  sourceLabel: string,
  targetLabel: string,
): Promise<[RestrictedRestoreInstalled, RestrictedRestoreInstalled]> {
  const [sourceResult, targetResult] = await Promise.allSettled([
    installRestrictedRestore(shape, mode, sourceLabel),
    installRestrictedRestore(shape, mode, targetLabel),
  ]);
  if (sourceResult.status === "fulfilled" && targetResult.status === "fulfilled") {
    return [sourceResult.value, targetResult.value];
  }
  const errors: unknown[] = [];
  const containers: PostgresContainer[] = [];
  const pools: Pool[] = [];
  for (const result of [sourceResult, targetResult]) {
    if (result.status === "fulfilled") {
      containers.push(result.value.container);
      pools.push(...result.value.pools);
    } else {
      errors.push(result.reason);
    }
  }
  if (containers.length > 0) {
    try {
      await closePostgres(containers, pools);
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
  }
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, "Restricted restore pair setup/cleanup failed");
}

async function withAcquisitionOwnerWindow<T>(installed: RestrictedRestoreInstalled, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await installed.owner.connect();
  try {
    // Host-owned window: the trusted migrator can reacquire this exact owner
    // capability, then seal it before any later qualification observation.
    await client.query("GRANT platform_acquisition_owner TO restore_m WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY restore_m");
    return await work(client);
  } finally {
    await client.query("REVOKE platform_acquisition_owner FROM restore_m GRANTED BY restore_m");
    client.release();
  }
}

export async function captureRestrictedStore(installed: RestrictedRestoreInstalled, sourceId: string) {
  return withAcquisitionOwnerWindow(installed, client =>
    captureConnectedNativeStore({ sourceId, catalogueId: installed.inventory, maximumRows: 10000,
      maximumBytes: 64 * 1024 * 1024, source: { async withSnapshot(work) {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        try {
          const result = await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
          await client.query("COMMIT"); return result;
        } catch (error) { await client.query("ROLLBACK"); throw error; }
      } } }));
}

export async function restrictedKeyIdentity(installed: RestrictedRestoreInstalled) {
  return withAcquisitionOwnerWindow(installed, async client =>
    (await client.query("SELECT tableoid::text,ctid::text,xmin::text FROM acquisition_private.installation_key")).rows);
}

export async function verifyRestrictedControlPlaneAdmission(
  shape: RestrictedRestoreShape,
  mode: RestrictedRestoreMode,
): Promise<void> {
  if (!await dockerAvailable()) throw new Error("Restricted admission requires disposable PostgreSQL 16");
  const fixture = await installRestrictedRestore(shape, mode, "admission", false);
  try {
    const provider = shape === "neon" ? "neon_superuser" : "rds_superuser";
    await fixture.pools[0]!.query(`REVOKE ${provider} FROM host_bootstrap`);
    await expect(fixture.runner.status()).rejects.toThrow("control_plane_membership_missing");
    await fixture.pools[0]!.query(`GRANT ${provider} TO host_bootstrap WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`);
    await fixture.pools[0]!.query("CREATE ROLE rogue_host CREATEROLE");
    await expect(fixture.runner.status()).rejects.toThrow("outside_role_has_host_authority");
  } finally { await closePostgres(fixture.container, fixture.pools); }
}

export async function verifyRestrictedConnectedRestore(
  shape: RestrictedRestoreShape,
  mode: RestrictedRestoreMode,
): Promise<void> {
  if (!await dockerAvailable()) throw new Error("Restricted restore requires disposable PostgreSQL 16");
  const [source, target] = await installRestrictedRestorePair(shape, mode, "source", "target");
  try {
    const { rows: [subscription] } = await source.owner.query<{ id: string }>(`WITH client AS (
      INSERT INTO public.clients(email,lifecycle_stage) VALUES('restricted@example.invalid','lead') RETURNING id
    )
    INSERT INTO public.subscriptions(client_id,cadence_days,next_cycle_at)
      SELECT id,28,'2026-11-29T12:00:00Z' FROM client RETURNING id`);
    await source.owner.query(`INSERT INTO public.subscription_edit_quotes(subscription_id,idempotency_key,request_fingerprint,
      quote_hash,expected_template_version,proposed_lines,proposed_cadence_days,current_total_minor,new_total_minor,currency_code,expires_at)
      VALUES($1,'fixture-quote',repeat('b',64),repeat('c',64),1,'[]',28,200,200,'XXX','2026-11-02')`, [subscription!.id]);
    await source.owner.query(`INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload)
      VALUES('synthetic','10000000-0000-4000-8000-000000000001','synthetic.retained','restricted-ordinary-outbox','{}')`);
    const packet = await captureRestrictedStore(source, "restricted-source");
    const quotes = packet.owned.find(entry => entry.table === "subscription_edit_quotes");
    expect(quotes!.rows).toHaveLength(1);
    const freshTarget = await captureRestrictedStore(target, "restricted-target");
    expect((await source.runner.status()).pending).toEqual([]);
    expect((await target.runner.status()).pending).toEqual([]);
    expect(packet.observation.cluster).not.toBe(freshTarget.observation.cluster);
    const provider = shape === "neon" ? "neon_superuser" : "rds_superuser";
    await target.pools[0]!.query(`GRANT ${provider} TO restore_r`);
    await expect(target.runner.status()).rejects.toThrow("protected_membership_graph_differs");
    await target.pools[0]!.query(`REVOKE ${provider} FROM restore_r`);
    const beforeKey = await restrictedKeyIdentity(target);
    const input = { owner: target.owner, installation: target.selection, packet, freshTarget };
    await target.owner.query("INSERT INTO public.commerce_settings(key,value_minor) VALUES('transfer_conflict',1)");
    await expect(restoreConnectedNativeStore(input)).rejects.toMatchObject({ code: "target_conflict" });
    await target.owner.query("DELETE FROM public.commerce_settings WHERE key='transfer_conflict'");
    expect((await target.runner.status()).pending).toEqual([]);
    expect((await restoreConnectedNativeStore(input)).replayed).toBe(false);
    expect((await target.owner.query("SELECT email FROM public.clients")).rows).toEqual([{ email: "restricted@example.invalid" }]);
    expect((await captureRestrictedStore(target, "restricted-restored")).owned.find(entry => entry.table === "subscription_edit_quotes")).toEqual(quotes);
    expect((await restoreConnectedNativeStore(input)).replayed).toBe(true);
    expect((await target.owner.query("SELECT event_type FROM public.outbox_events")).rows).toEqual([{ event_type: "synthetic.retained" }]);
    if (shape === "neon" && mode === "installer-managed") {
      // A separate administrator changes the ledger after the first exact
      // read but just before restore locks the table. Replay must recheck it.
      const root = target.pools[0]!;
      const original = (await root.query<{ sha256: string }>(
        "SELECT sha256 FROM public.platform_schema_migrations WHERE position=0")).rows[0]!.sha256;
      const changed = `${original[0] === "f" ? "e" : "f"}${original.slice(1)}`;
      let raced = false, closed = false;
      const racingOwner = { async connect() {
        const client = await target!.owner.connect();
        return {
          async query(sql: string | QueryConfig, values?: unknown[]) {
            const text = typeof sql === "string" ? sql : sql.text;
            if (!raced && text.startsWith("LOCK TABLE ") && text.includes('"public"."platform_schema_migrations"')) {
              await root.query("UPDATE public.platform_schema_migrations SET sha256=$1 WHERE position=0", [changed]);
              raced = true;
            }
            const result = typeof sql === "string" ? await client.query(sql, values) : await client.query(sql);
            if (text.startsWith("REVOKE platform_acquisition_owner")) closed = true;
            return result;
          },
          release: (destroy?: boolean) => client.release(destroy),
        };
      } } as unknown as Pool;
      try {
        await expect(restoreConnectedNativeStore({ ...input, owner: racingOwner })).rejects.toMatchObject({ code: "schema_conflict" });
        expect(raced).toBe(true);
        expect(closed).toBe(true);
      } finally {
        await root.query("UPDATE public.platform_schema_migrations SET sha256=$1 WHERE position=0", [original]);
      }
      expect((await restoreConnectedNativeStore(input)).replayed).toBe(true);
    }
    expect(await restrictedKeyIdentity(target)).toEqual(beforeKey);
    await expect(restoreConnectedNativeStore({ ...input, freshTarget: packet })).rejects.toMatchObject({ code: "invalid_input" });
    const restoreLogin = new Pool({ connectionString: (() => {
      const url = new URL(target.container.connectionString); url.username = target.selection.restoreLogin; return url.toString();
    })() });
    target.pools.push(restoreLogin);
    await expect(restoreLogin.query("UPDATE public.clients SET email='forbidden@example.invalid'")).rejects.toMatchObject({ code: "42501" });
    await expect(restoreLogin.query("SELECT * FROM acquisition_private.installation_key")).rejects.toMatchObject({ code: "42501" });
  } finally {
    await closePostgres([target.container, source.container], [...target.pools, ...source.pools]);
  }
}
