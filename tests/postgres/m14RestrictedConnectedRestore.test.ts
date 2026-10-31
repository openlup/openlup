import { readFileSync } from "node:fs";
import { Pool, type PoolClient, type QueryConfig } from "pg";
import { expect, it } from "vitest";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { captureConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedAdminPostgresStartupOptions, type QualifiedAdminPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

type Shape = "neon" | "rds";
type Mode = "installer-managed" | "operator-provisioned";
type Installed = { container: PostgresContainer; pools: Pool[]; owner: Pool; runner: ReturnType<typeof createPostgresMigrationRunner>;
  selection: QualifiedAdminPostgresInstallation; inventory: string };
const password = "synthetic-restricted-restore";
const groups = ["anon", "authenticated", "service_role", "platform_acquisition_owner",
  "platform_acquisition_runtime", "openlup_retained_import_owner"];

async function install(shape: Shape, mode: Mode, label: string, apply = true): Promise<Installed> {
  const container = await runPostgresContainer({ name: `m14-restricted-connected-${shape}-${mode}-${label}-${process.pid}`, password });
  const pools: Pool[] = [];
  try {
    expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
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
    expect((await owner.query("SELECT rolsuper,rolcreaterole,rolcreatedb FROM pg_catalog.pg_roles WHERE rolname=$1",
      [selection.bootstrapLogin])).rows).toEqual([{ rolsuper: false, rolcreaterole: true, rolcreatedb: true }]);
    await expect(owner.query("SELECT * FROM pg_catalog.pg_control_system()")).rejects.toMatchObject({ code: "42501" });
    expect((await runner.status()).pending).toHaveLength(92);
    if (apply) {
      expect((await runner.apply()).applied).toHaveLength(92);
      expect((await runner.status()).pending).toEqual([]);
    }
    return { container, pools, owner, runner, selection, inventory: manifest.objectInventorySha256 };
  } catch (error) { await closePostgres(container, pools); throw error; }
}

async function withAcquisitionOwnerWindow<T>(installed: Installed, work: (client: PoolClient) => Promise<T>): Promise<T> {
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
async function capture(installed: Installed, sourceId: string) {
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
async function keyIdentity(installed: Installed) {
  return withAcquisitionOwnerWindow(installed, async client =>
    (await client.query("SELECT tableoid::text,ctid::text,xmin::text FROM acquisition_private.installation_key")).rows);
}

it("keeps the elevated control-plane membership requirement for self-host selections", async () => {
  const fixture = await install("rds", "installer-managed", "self-host-scope", false);
  try {
    delete fixture.selection.target; delete fixture.selection.layout;
    await expect(fixture.runner.status()).rejects.toThrow("control_plane_membership_missing");
  } finally { await closePostgres(fixture.container, fixture.pools); }
}, postgresSetupTimeoutMs);

it("does not let an RDS declaration trust a non-stock role without elevated flags", async () => {
  const fixture = await install("rds", "installer-managed", "non-stock-authority", false);
  try {
    await fixture.pools[0]!.query(`CREATE ROLE declared_outsider NOLOGIN; REVOKE rds_superuser FROM host_bootstrap;
      GRANT declared_outsider TO host_bootstrap WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`);
    fixture.selection.trustedControlPlane = { roleNames: [...fixture.selection.trustedControlPlane!.roleNames, "declared_outsider"] };
    await expect(fixture.runner.status()).rejects.toThrow("control_plane_membership_missing");
  } finally { await closePostgres(fixture.container, fixture.pools); }
}, postgresSetupTimeoutMs);

for (const role of ["rds_password", "rds_iam", "rds_ad"] as const) {
  it(`does not count bootstrap membership only in ${role} as RDS authority`, async () => {
    const fixture = await install("rds", "installer-managed", `non-authority-${role}`, false);
    try {
      await fixture.pools[0]!.query(`CREATE ROLE ${role} NOLOGIN; REVOKE rds_superuser FROM host_bootstrap;
        GRANT ${role} TO host_bootstrap WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`);
      fixture.selection.trustedControlPlane = { roleNames: [...fixture.selection.trustedControlPlane!.roleNames, role] };
      await expect(fixture.runner.status()).rejects.toThrow("control_plane_membership_missing");
      await fixture.pools[0]!.query("GRANT rds_superuser TO host_bootstrap WITH ADMIN TRUE, INHERIT TRUE, SET TRUE");
      expect((await fixture.runner.status()).pending).toHaveLength(92);
    } finally { await closePostgres(fixture.container, fixture.pools); }
  }, postgresSetupTimeoutMs);
}

for (const outside of ["grantor", "member"] as const) {
  it(`compares RDS predefined-role edges with a non-stock ${outside}`, async () => {
    const fixture = await install(outside === "grantor" ? "neon" : "rds", "installer-managed", `non-stock-${outside}`, false);
    try {
      fixture.selection.target = "rds"; fixture.selection.layout = "serial-cluster";
      const outsideName = outside === "grantor" ? "rds_superuser" : "declared_outsider";
      await fixture.pools[0]!.query(`CREATE ROLE ${outsideName} NOLOGIN`);
      fixture.selection.trustedControlPlane = { roleNames: [...fixture.selection.trustedControlPlane!.roleNames, outsideName] };
      expect((await fixture.runner.status()).pending).toHaveLength(92);
      await fixture.pools[0]!.query(`GRANT pg_monitor TO ${outsideName} WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`);
      await expect(fixture.runner.status()).rejects.toThrow("protected_membership_graph_differs");
    } finally { await closePostgres(fixture.container, fixture.pools); }
  }, postgresSetupTimeoutMs);
}

for (const shape of ["neon", "rds"] as const) for (const mode of ["installer-managed", "operator-provisioned"] as const) {
  it(`admits ${shape}-shaped ${mode} control-plane roles before installation`, async () => {
    if (!await dockerAvailable()) throw new Error("Restricted admission requires disposable PostgreSQL 16");
    const fixture = await install(shape, mode, "admission", false);
    try {
      const provider = shape === "neon" ? "neon_superuser" : "rds_superuser";
      await fixture.pools[0]!.query(`REVOKE ${provider} FROM host_bootstrap`);
      await expect(fixture.runner.status()).rejects.toThrow("control_plane_membership_missing");
      await fixture.pools[0]!.query(`GRANT ${provider} TO host_bootstrap WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`);
      await fixture.pools[0]!.query("CREATE ROLE rogue_host CREATEROLE");
      await expect(fixture.runner.status()).rejects.toThrow("outside_role_has_host_authority");
    } finally { await closePostgres(fixture.container, fixture.pools); }
  }, postgresSetupTimeoutMs);
  it(`restores a connected native graph through ${shape}-shaped ${mode} admission`, async () => {
    if (!await dockerAvailable()) throw new Error("Restricted restore requires disposable PostgreSQL 16");
    let source: Installed | undefined, target: Installed | undefined;
    try {
      source = await install(shape, mode, "source");
      target = await install(shape, mode, "target");
      await source.owner.query("INSERT INTO public.clients(email,lifecycle_stage) VALUES('restricted@example.invalid','lead')");
      const packet = await capture(source, "restricted-source"), freshTarget = await capture(target, "restricted-target");
      expect((await source.runner.status()).pending).toEqual([]);
      expect((await target.runner.status()).pending).toEqual([]);
      expect(packet.observation.cluster).not.toBe(freshTarget.observation.cluster);
      const provider = shape === "neon" ? "neon_superuser" : "rds_superuser";
      await target.pools[0]!.query(`GRANT ${provider} TO restore_r`);
      await expect(target.runner.status()).rejects.toThrow("protected_membership_graph_differs");
      await target.pools[0]!.query(`REVOKE ${provider} FROM restore_r`);
      const beforeKey = await keyIdentity(target);
      const input = { owner: target.owner, installation: target.selection, packet, freshTarget };
      await target.owner.query("INSERT INTO public.commerce_settings(key,value_minor) VALUES('transfer_conflict',1)");
      await expect(restoreConnectedNativeStore(input)).rejects.toMatchObject({ code: "target_conflict" });
      await target.owner.query("DELETE FROM public.commerce_settings WHERE key='transfer_conflict'");
      expect((await target.runner.status()).pending).toEqual([]);
      expect((await restoreConnectedNativeStore(input)).replayed).toBe(false);
      expect((await target.owner.query("SELECT email FROM public.clients")).rows).toEqual([{ email: "restricted@example.invalid" }]);
      expect((await restoreConnectedNativeStore(input)).replayed).toBe(true);
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
              if (!raced && text.includes('LOCK TABLE "public"."platform_schema_migrations"')) {
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
      expect(await keyIdentity(target)).toEqual(beforeKey);
      await expect(restoreConnectedNativeStore({ ...input, freshTarget: packet })).rejects.toMatchObject({ code: "invalid_input" });
      const restoreLogin = new Pool({ connectionString: (() => {
        const url = new URL(target!.container.connectionString); url.username = target!.selection.restoreLogin; return url.toString();
      })() });
      target.pools.push(restoreLogin);
      await expect(restoreLogin.query("UPDATE public.clients SET email='forbidden@example.invalid'")).rejects.toMatchObject({ code: "42501" });
      await expect(restoreLogin.query("SELECT * FROM acquisition_private.installation_key")).rejects.toMatchObject({ code: "42501" });
    } finally {
      if (target) await closePostgres(target.container, target.pools);
      if (source) await closePostgres(source.container, source.pools);
    }
  }, postgresSetupTimeoutMs * 2);
}
