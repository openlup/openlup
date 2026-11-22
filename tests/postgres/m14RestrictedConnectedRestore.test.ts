import installationInventory from "./current-installation-inventory.json" with { type: "json" };
import { readFileSync } from "node:fs";
import { Pool, type PoolClient, type QueryConfig } from "pg";
import { expect, it } from "vitest";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { createHash } from "node:crypto";
import { captureConnectedNativeStore, connectedNativeStoreTables, type ConnectedNativeStoreCapture } from "../../server/adapters/postgres/connectedStoreCapture.js";
import { restoreConnectedNativeStore } from "../../server/adapters/postgres/connectedStoreRestore.js";
import { projectHistoricalCapture, sealConnectedCapture } from "./connectedStoreHistoricalPacket.fixture.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedAdminPostgresStartupOptions, type QualifiedAdminPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

type Shape = "neon" | "rds";
type Mode = "installer-managed" | "operator-provisioned";
type Installed = { container: PostgresContainer; pools: Pool[]; owner: Pool; runner: ReturnType<typeof createPostgresMigrationRunner>;
  selection: QualifiedAdminPostgresInstallation; inventory: string };
const password = "synthetic-restricted-restore";
const beforeGovernedLifecycle: Record<Mode, string> = {
  "installer-managed": "37df11b3df727367715dcabaff16e366fac0477c8a09167d3f180e31746b82c4",
  "operator-provisioned": "4c05ab3d6ed00157305853bdfd272469feabc03c6528aab3d6eec7a7e7a2d8ac",
};
const beforeSubscriptionProfiles: Record<Mode, string> = {
  "installer-managed": "412caa25526d6ba70bb5bb761d5bed2336e7307811a879658295819ad5ab15f5",
  "operator-provisioned": "d413c04713b9fb5f5f9d8f01dc66c68c67d131f6cc94bcbf12becef47abd4f42",
};
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
    expect(1 + manifest.forward.length).toBe(installationInventory.current.profiles[mode === "installer-managed" ? "admin-managed" : "admin-operator"].count);
    expect((await runner.status()).pending).toHaveLength(1 + manifest.forward.length);
    if (apply) {
      expect((await runner.apply()).applied).toHaveLength(1 + manifest.forward.length);
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
async function capture(installed: Installed, sourceId: string, catalogueId = installed.inventory) {
  return withAcquisitionOwnerWindow(installed, client =>
    captureConnectedNativeStore({ sourceId, catalogueId, maximumRows: 10000,
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
      expect((await fixture.runner.status()).pending).toHaveLength(1 + selectPlatformMigrationManifest(JSON.parse(readFileSync('config/platform-migration-manifest.json', 'utf8')), 'qualified-admin', { roleMode: fixture.selection.roleMode }).forward.length);
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
      expect((await fixture.runner.status()).pending).toHaveLength(1 + selectPlatformMigrationManifest(JSON.parse(readFileSync('config/platform-migration-manifest.json', 'utf8')), 'qualified-admin', { roleMode: fixture.selection.roleMode }).forward.length);
      await fixture.pools[0]!.query(`GRANT pg_monitor TO ${outsideName} WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`);
      await expect(fixture.runner.status()).rejects.toThrow("protected_membership_graph_differs");
    } finally { await closePostgres(fixture.container, fixture.pools); }
  }, postgresSetupTimeoutMs);
}

function traceRestore(owner: Pool, hook?: (sql: string, client: PoolClient) => void | Promise<void>) {
  const statements: string[] = [];
  const traced = { async connect() {
    const client = await owner.connect();
    return {
      async query(sql: string | QueryConfig, values?: unknown[]) {
        const text = typeof sql === "string" ? sql : sql.text;
        statements.push(text);
        await hook?.(text, client);
        return typeof sql === "string" ? client.query(sql, values) : client.query(sql);
      },
      release: (destroy?: boolean) => client.release(destroy),
    };
  } } as unknown as Pool;
  const writes = () => statements.filter(sql => /^\s*(GRANT|INSERT|UPDATE|DELETE)\b/iu.test(sql)
    || /public\.(client_import_retained_row|subscription_cycle_import_retained_row)\(/u.test(sql));
  const expectAdmittedBeforeGrant = () => {
    const grant = statements.findIndex(sql => sql.startsWith("GRANT "));
    expect(grant).toBeGreaterThan(0);
    const locked = statements.slice(0, grant);
    for (const table of [...connectedNativeStoreTables, "platform_schema_migrations"]) {
      expect(locked).toContain(`LOCK TABLE "public"."${table}" IN SHARE ROW EXCLUSIVE MODE`);
    }
    expect(locked.some(sql => sql.includes("to_jsonb(t)::pg_catalog.text"))).toBe(true);
    expect(locked.some(sql => sql.includes('"customer_identity_challenges" LIMIT 1'))).toBe(true);
    expect(statements.filter(sql => sql.startsWith("GRANT "))).toHaveLength(2);
  };
  return { traced, statements, writes, expectAdmittedBeforeGrant };
}

async function expectPrivateLockRefusal(target: Installed, input: Parameters<typeof restoreConnectedNativeStore>[0]) {
  const root = target.pools[0]!;
  const memberships = async () => (await root.query(
    "SELECT roleid,member,grantor,admin_option,inherit_option,set_option FROM pg_catalog.pg_auth_members ORDER BY 1,2,3")).rows;
  const before = await memberships();
  const relation = "acquisition_private.newsletter_consent_events";
  const lock = 'LOCK TABLE "acquisition_private"."newsletter_consent_events"';
  const trace = traceRestore(target.owner, async (sql, client) => {
    // A blocking regression fails with query_canceled while the writer still holds its lock.
    if (sql.startsWith(lock)) await client.query("SET LOCAL statement_timeout = '5s'");
  });
  const writer = await root.connect();
  const fingerprint = "a".repeat(64);
  try {
    await writer.query("BEGIN");
    await writer.query("SET LOCAL statement_timeout = '5s'");
    await writer.query("SET LOCAL ROLE platform_acquisition_owner");
    await writer.query(`LOCK TABLE ${relation} IN ROW EXCLUSIVE MODE`);
    await expect(restoreConnectedNativeStore({ ...input, owner: trace.traced })).rejects.toMatchObject({
      code: "target_conflict", table: relation,
    });
    trace.expectAdmittedBeforeGrant();
    expect(trace.statements).toContain(`${lock} IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
    expect(trace.statements).toContain("ROLLBACK");
    expect(trace.writes()).toEqual(trace.statements.filter(sql => sql.startsWith("GRANT ")));
    expect(await memberships()).toEqual(before);
    const after = await capture(target, input.freshTarget.compatible.sourceId);
    expect(after.compatible).toEqual(input.freshTarget.compatible);
    expect(after.owned).toEqual(input.freshTarget.owned);
    expect(after.outsideProfileCensus).toEqual(input.freshTarget.outsideProfileCensus);
    await writer.query(`INSERT INTO public.communication_recipient_consents(recipient_fingerprint,purpose,state)
      VALUES ($1,'marketing_newsletter','granted')`, [fingerprint]);
    await writer.query("COMMIT");
  } catch (error) {
    await writer.query("ROLLBACK");
    throw error;
  } finally { writer.release(); }
  const committed = await root.query("DELETE FROM public.communication_recipient_consents WHERE recipient_fingerprint=$1 RETURNING state", [fingerprint]);
  expect(committed.rows).toEqual([{ state: "granted" }]);
}

function sealOuter(packet: ConnectedNativeStoreCapture) {
  const { sha256: _hash, ...body } = packet;
  packet.sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return packet;
}

function genericDefects(packet: ConnectedNativeStoreCapture) {
  const mutate = (change: (copy: ConnectedNativeStoreCapture, columns: ConnectedNativeStoreCapture["compatible"]["tables"][number]["columns"]) => void) => {
    const copy = structuredClone(packet);
    change(copy, copy.compatible.tables.find(table => table.table === "subscription_pause_windows")!.columns);
    return sealConnectedCapture(copy);
  };
  return [
    { packet: mutate((_copy, columns) => { columns.find(column => !column.key)!.key = true; }), code: "schema_conflict" },
    { packet: mutate((_copy, columns) => {
      const { key, name, type } = columns[0]!;
      columns[0] = { key, name, type };
    }), code: "schema_conflict" },
    { packet: mutate((_copy, columns) => { Object.assign(columns[0]!, { extra: true }); }), code: "schema_conflict" },
    { packet: mutate(copy => { copy.compatible.sourceId = String.fromCharCode(1); }), code: "invalid_input" },
    { packet: mutate((_copy, columns) => { Object.assign(columns[0]!, { key: "yes" }); }), code: "invalid_input" },
  ];
}

async function writeLineage(owner: Pool) {
  const root = "10000000-0000-4000-8000-000000000002", child = "10000000-0000-4000-8000-000000000003";
  const db = await owner.connect();
  try {
    await db.query("BEGIN");
    await db.query(`INSERT INTO public.commerce_orders(id,client_id,total_amount_minor,currency_code,recovery_root_order_id,recreated_from_order_id)
      SELECT $1, id, 100, 'XXX', NULL, NULL FROM public.clients`, [root]);
    await db.query(`INSERT INTO public.commerce_orders(id,client_id,total_amount_minor,currency_code,recovery_root_order_id,recreated_from_order_id)
      SELECT $1, id, 100, 'XXX', $2, $2 FROM public.clients`, [child, root]);
    await db.query(`INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor)
      SELECT id,1,1,100,100 FROM public.commerce_orders`);
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  return (pool: Pool, cycled: boolean) => pool.query("UPDATE public.commerce_orders SET recreated_from_order_id=$2 WHERE id=$1", [root, cycled ? child : null]);
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
  const sourceInventories = shape === "neon"
    ? [beforeGovernedLifecycle[mode], beforeSubscriptionProfiles[mode]] : [undefined];
  it.each(sourceInventories)(`restores a connected native graph through ${shape}-shaped ${mode} admission with source pin %s`, async (sourceCatalogueId) => {
    if (!await dockerAvailable()) throw new Error("Restricted restore requires disposable PostgreSQL 16");
    let source: Installed | undefined, target: Installed | undefined;
    try {
      source = await install(shape, mode, "source");
      target = await install(shape, mode, "target");
      await source.owner.query("INSERT INTO public.clients(email,lifecycle_stage) VALUES('restricted@example.invalid','lead')");
      await source.owner.query(`INSERT INTO public.outbox_events(aggregate_type,aggregate_id,event_type,idempotency_key,payload)
        VALUES('synthetic','10000000-0000-4000-8000-000000000001','synthetic.retained','restricted-ordinary-outbox','{}')`);
      const cycle = shape === "rds" ? await writeLineage(source.owner) : undefined;
      // Cover current and predecessor inventories for each restricted role mode.
      const current = await capture(source, "restricted-source", sourceCatalogueId);
      let cyclePacket: ConnectedNativeStoreCapture | undefined;
      if (cycle) {
        await cycle(source.owner, true);
        cyclePacket = await capture(source, "restricted-cycle");
        await cycle(source.owner, false);
      }
      const packet = sourceCatalogueId === beforeGovernedLifecycle[mode]
        ? await projectHistoricalCapture(source.owner, current, sourceCatalogueId) : current;
      const freshTarget = await capture(target, "restricted-target");
      expect((await source.runner.status()).pending).toEqual([]);
      expect((await target.runner.status()).pending).toEqual([]);
      expect(packet.observation.cluster).not.toBe(freshTarget.observation.cluster);
      const provider = shape === "neon" ? "neon_superuser" : "rds_superuser";
      await target.pools[0]!.query(`GRANT ${provider} TO restore_r`);
      await expect(target.runner.status()).rejects.toThrow("protected_membership_graph_differs");
      await target.pools[0]!.query(`REVOKE ${provider} FROM restore_r`);
      const beforeKey = await keyIdentity(target);
      const input = { owner: target.owner, installation: target.selection, packet, freshTarget };
      const refuse = async (code: string, edited: Partial<typeof input> = {}) => {
        const trace = traceRestore(target!.owner);
        await expect(restoreConnectedNativeStore({ ...input, ...edited, owner: trace.traced })).rejects.toMatchObject({ code });
        expect(trace.writes()).toEqual([]);
      };
      if (shape === "rds") {
        const root = target.pools[0]!;
        await root.query("CREATE TABLE public.restore_unexpected_table (id integer)");
        try {
          await root.query("ALTER TABLE public.restore_unexpected_table OWNER TO host_bootstrap");
          expect((await target.owner.query(`SELECT pg_get_userbyid(relowner) AS owner,
            has_table_privilege(current_user, oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS can_access
            FROM pg_catalog.pg_class WHERE oid='public.restore_unexpected_table'::regclass`)).rows)
            .toEqual([{ owner: target.selection.bootstrapLogin, can_access: false }]);
          const trace = traceRestore(target.owner);
          await expect(restoreConnectedNativeStore({ ...input, owner: trace.traced })).rejects.toMatchObject({ code: "schema_conflict" });
          expect(trace.statements.some(sql => sql.startsWith('LOCK TABLE "public".'))).toBe(false);
          expect(trace.writes()).toEqual([]);
        } finally { await root.query("DROP TABLE public.restore_unexpected_table"); }

        await target.owner.query("UPDATE public.subscription_delivery_alignment_control SET mode='shadow' WHERE singleton");
        try {
          const shadowBaseline = await capture(target, "restricted-target-shadow");
          const trace = traceRestore(target.owner);
          await expect(restoreConnectedNativeStore({ ...input, freshTarget: shadowBaseline, owner: trace.traced })).rejects.toMatchObject({
            code: "target_conflict", table: "subscription_delivery_alignment_control",
          });
          expect(trace.writes()).toEqual([]);
        } finally {
          await target.owner.query("UPDATE public.subscription_delivery_alignment_control SET mode='off' WHERE singleton");
        }
        await expectPrivateLockRefusal(target, input);
      }
      const baselineCases = [false, true].map(reverse => {
        const copy = structuredClone(freshTarget);
        const revision = copy.owned.find(data => data.table === "catalog_product_document_revisions")!;
        revision.columns.push({ name: "disallowed_column", type: "jsonb" });
        if (reverse) { copy.owned.reverse(); revision.columns.reverse(); }
        return sealConnectedCapture(copy);
      });
      const genericCases = genericDefects(packet);
      for (const defect of genericCases) await refuse(defect.code, { packet: defect.packet });
      if (cyclePacket) await refuse("target_conflict", { packet: cyclePacket });
      const channelPacket = structuredClone(packet);
      const outbox = channelPacket.compatible.tables.find(table => table.table === "outbox_events")!;
      outbox.rows[0] = JSON.stringify({ ...JSON.parse(outbox.rows[0]!), event_type: "channel.purchase-line.v1" });
      await refuse("unsupported_table", { packet: sealConnectedCapture(channelPacket) });
      await refuse("invalid_input", { freshTarget: packet });
      await target.owner.query("INSERT INTO public.commerce_settings(key,value_minor) VALUES('transfer_conflict',1)");
      await refuse("target_conflict");
      for (const baseline of baselineCases) await refuse("schema_conflict", { freshTarget: baseline });
      await target.owner.query("DELETE FROM public.commerce_settings WHERE key='transfer_conflict'");
      expect((await target.runner.status()).pending).toEqual([]);

      const nativeRefusal = structuredClone(packet);
      const invalidOutbox = nativeRefusal.compatible.tables.find(table => table.table === "outbox_events")!;
      invalidOutbox.rows[0] = JSON.stringify({ ...JSON.parse(invalidOutbox.rows[0]!), status: "invalid-fixture-status" });
      const rollback = traceRestore(target.owner);
      await expect(restoreConnectedNativeStore({
        ...input, packet: sealConnectedCapture(nativeRefusal), owner: rollback.traced,
      })).rejects.toMatchObject({ code: "target_conflict" });
      rollback.expectAdmittedBeforeGrant();
      expect(rollback.statements.some(sql => sql.includes("public.client_import_retained_row("))).toBe(true);
      expect(rollback.statements).toContain("ROLLBACK");
      expect((await target.owner.query("SELECT email FROM public.clients")).rows).toEqual([]);
      expect((await target.runner.status()).pending).toEqual([]);
      expect(await keyIdentity(target)).toEqual(beforeKey);

      for (const [sourceDigest, targetDigest] of [[true, false], [false, true], [true, true]]) {
        const changed = (capture: ConnectedNativeStoreCapture, inner: boolean) => {
          const copy = structuredClone(capture);
          if (inner) copy.compatible.sha256 = "ignored inner checksum";
          return sealOuter(copy);
        };
        const trace = traceRestore(target.owner);
        const result = await restoreConnectedNativeStore({ ...input, owner: trace.traced,
          packet: changed(packet, sourceDigest), freshTarget: changed(freshTarget, targetDigest),
        });
        expect(result.replayed).toBe(!sourceDigest || targetDigest);
        trace.expectAdmittedBeforeGrant();
      }
      expect((await target.owner.query("SELECT email FROM public.clients")).rows).toEqual([{ email: "restricted@example.invalid" }]);
      for (const edited of [
        ...genericCases.map(defect => ({ packet: defect.packet })), ...baselineCases.map(baseline => ({ freshTarget: baseline })),
      ]) {
        const trace = traceRestore(target.owner);
        expect((await restoreConnectedNativeStore({ ...input, ...edited, owner: trace.traced })).replayed).toBe(true);
        trace.expectAdmittedBeforeGrant();
        const firstGrant = trace.statements.findIndex(sql => sql.startsWith("GRANT "));
        expect(trace.statements.slice(0, firstGrant).some(sql => sql.includes("public.catalog_publication_assert_issued"))).toBe(true);
      }
      if (cycle && cyclePacket) {
        await cycle(target.owner, true);
        const trace = traceRestore(target.owner);
        expect((await restoreConnectedNativeStore({ ...input, packet: cyclePacket, owner: trace.traced })).replayed).toBe(true);
        trace.expectAdmittedBeforeGrant();
        await cycle(target.owner, false);
      }
      expect((await target.owner.query("SELECT event_type FROM public.outbox_events")).rows).toEqual([{ event_type: "synthetic.retained" }]);
      if (shape === "neon" && mode === "installer-managed") {
        // A separate administrator changes the ledger after the first exact
        // read but just before restore locks the table. Replay must recheck it.
        const root = target.pools[0]!;
        const original = (await root.query<{ sha256: string }>(
          "SELECT sha256 FROM public.platform_schema_migrations WHERE position=0")).rows[0]!.sha256;
        const changed = `${original[0] === "f" ? "e" : "f"}${original.slice(1)}`;
        let raced = false;
        const trace = traceRestore(target.owner, async sql => {
          if (!raced && sql.includes('LOCK TABLE "public"."platform_schema_migrations"')) {
            await root.query("UPDATE public.platform_schema_migrations SET sha256=$1 WHERE position=0", [changed]);
            raced = true;
          }
        });
        try {
          await expect(restoreConnectedNativeStore({ ...input, owner: trace.traced })).rejects.toMatchObject({ code: "schema_conflict" });
          expect(raced).toBe(true);
          expect(trace.writes()).toEqual([]);
          expect((await target.owner.query("SELECT email FROM public.clients")).rows).toEqual([{ email: "restricted@example.invalid" }]);
        } finally {
          await root.query("UPDATE public.platform_schema_migrations SET sha256=$1 WHERE position=0", [original]);
        }
        let changedSchema = false;
        const ddl = traceRestore(target.owner, async sql => {
          if (!changedSchema && sql.includes('LOCK TABLE "public"."subscription_pause_windows"')) {
            await root.query("ALTER TABLE public.subscription_pause_windows ADD COLUMN restore_race_probe text");
            changedSchema = true;
          }
        });
        try {
          await expect(restoreConnectedNativeStore({ ...input, owner: ddl.traced })).rejects.toMatchObject({ code: "schema_conflict" });
          expect(changedSchema).toBe(true);
          expect(ddl.writes()).toEqual([]);
        } finally {
          if (changedSchema) await root.query("ALTER TABLE public.subscription_pause_windows DROP COLUMN restore_race_probe");
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
  // About 4x the slowest hosted run (60,506 ms), rounded up to 5 s.
  }, 245_000);
}
