import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { QUALIFIED_OWNER_PATH_FILE, QUALIFIED_RUNTIME_COMPLETION_FILE, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { checkoutOwnerLogin, checkoutOwnerRoutines, nativeStoreFunctionDefinitions, renderCheckoutOwnerGrant, sqlSha256, type NativeStoreSlot } from "../../scripts/reviewed-platform-forward.js";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import {
  qualifiedAdminPostgresCatalogPayload, qualifiedAdminPostgresStartupOptions, qualifiedPostgresCatalogPayload, qualifiedPostgresStartupOptions,
  type QualifiedAdminPostgresInstallation, type QualifiedPostgresInstallation,
} from "../../server/adapters/postgres/qualifiedInstall.js";

/** Frozen M14 reference inventories: never replace these with an observed target. */
export function readIssuedPlatformManifest() {
  const issued = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as PlatformMigrationManifest;
  if (issued.schemaVersion !== 3) throw new Error("Issued-prefix witness requires the three platform plans");
  for (const [plan, tail] of [
    [issued, "db/platform/migrations/20261026120000_account_support_operator_authority.sql"],
    [issued.qualified, QUALIFIED_OWNER_PATH_FILE],
    [issued.qualifiedAdmin, QUALIFIED_RUNTIME_COMPLETION_FILE],
  ] as const) {
    const end = plan.forward.findIndex(entry => entry.file === tail);
    if (end < 0) throw new Error("Issued-prefix witness tail missing: " + tail);
    plan.forward = plan.forward.slice(0, end + 1);
  }
  issued.objectInventorySha256 = "cfe3a8b4fa6216f61b1cdd5f004cb0f7a967bc01d9e18ddacb2efee74742d3b3";
  issued.qualified.objectInventorySha256 = {
    bootstrapMigrator: { withRestore: "c4f6bb9daa5882877149a78e13d07594b7e8653c3a3ba39f508477b072548f9b" },
    separateMigrator: { withRestore: "624cc57789e3aaf36d0b61bdad420fc4eb0b63c2a7eb09358e5c18240ec13f82" },
  };
  issued.qualifiedAdmin.objectInventorySha256 = {
    installerManaged: "c94d71fd28d5571cda30307bce4c4b48ebe0a3685c76819d8fa3b3efa8fa9ae7",
    operatorProvisioned: "807ea0c9b303c04c4ad3e9892ab16ee7e89acaea8b7641d1cedd4c79949fab7d",
  };
  return issued;
}

/** Existing runner root seam: install the fixed issued prefix, then the live suffix. */
export function withIssuedPlatformCatalog<T>(work: (root: string) => Promise<T>): Promise<T> {
  return withPlatformCatalog(readIssuedPlatformManifest(), work);
}

export async function withPlatformCatalog<T>(manifest: ReturnType<typeof readIssuedPlatformManifest>, work: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "openlup-issued-prefix-"));
  try {
    const paths = new Set([manifest, manifest.qualified, manifest.qualifiedAdmin].flatMap(plan =>
      [plan.baseline.file, ...plan.forward.map(entry => entry.file)]));
    for (const file of paths) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(file, target);
    }
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config/platform-migration-manifest.json"), JSON.stringify(manifest));
    return await work(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export const definitionPath = "db/platform/migrations/20990101000000_catalog_purchase_admission.sql";
export const grantPath = "db/platform/migrations/20990101000100_catalog_checkout_owner_execute.sql";
export const definitionSql = checkoutOwnerRoutines.map((signature, index) => `
CREATE FUNCTION ${signature} RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  ${index < 2 ? "RETURN;" : "RAISE EXCEPTION 'fixture_checkout_writer_dark';"}
END;
$$;
REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;
`).join("");

export const definitionSlot: NativeStoreSlot = {
  row: "catalog-purchase-admission", path: definitionPath,
  createdFunctions: checkoutOwnerRoutines.map(signature => ({ signature, searchPath: "pg_catalog, pg_temp" })),
  replacedFunctions: [], grantOnlyFunctions: [], dataStatements: [],
};
export const grantSlot: NativeStoreSlot = {
  row: "catalog-checkout-owner-execute", path: grantPath, createdFunctions: [], replacedFunctions: [], dataStatements: [],
  grantOnlyFunctions: checkoutOwnerRoutines.map(signature => ({ signature, grantTo: [checkoutOwnerLogin], revokeFrom: [] })),
};
export function definitionPin(text = definitionSql) {
  const definitions = nativeStoreFunctionDefinitions(Buffer.from(text), checkoutOwnerRoutines, true);
  return { path: definitionPath, sha256: sqlSha256(text), functions: checkoutOwnerRoutines.map(signature =>
    ({ signature, beforeSha256: null, afterSha256: definitions.get(signature)! })) };
}
export const grantSql = renderCheckoutOwnerGrant(definitionPath, sqlSha256(definitionSql));

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const lockName = "openlup:public-platform-migrations:v1";
const files = [{ file: definitionPath, sha256: hash(definitionSql), sql: definitionSql }, { file: grantPath, sha256: hash(grantSql), sql: grantSql }];
const ledger = "ONLY public.platform_schema_migrations";
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
type QualifiedSelection = QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation;

export async function provisionCheckoutOwner(db: Pool, selection: QualifiedSelection, database: string, password: string, operator?: Pool) {
  assert.match(password, /^[a-z0-9-]+$/u);
  // A restricted CREATEROLE operator receives a bootstrap-granted edge on PG16.
  // Bootstrap owns the actual grantor edge and clears it before the handoff.
  await (operator ?? db).query(`CREATE ROLE ${checkoutOwnerLogin} LOGIN NOINHERIT PASSWORD '${password}'`);
  if (operator && selection.generation === "qualified-admin" && selection.roleMode === "operator-provisioned") {
    const edge = (await db.query(`SELECT pg_catalog.pg_get_userbyid(grantor) AS grantor,admin_option,inherit_option,set_option
      FROM pg_catalog.pg_auth_members WHERE roleid=$1::regrole AND member=$2::regrole`, [checkoutOwnerLogin, selection.operatorLogin])).rows;
    assert.deepEqual(edge, [{ grantor: selection.bootstrapLogin, admin_option: true, inherit_option: false, set_option: false }]);
    await db.query(`REVOKE ${checkoutOwnerLogin} FROM ${identifier(selection.operatorLogin)} GRANTED BY ${identifier(selection.bootstrapLogin)}`);
  }
  const existing = await db.query("SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1)", [
    [selection.runtimeLogin, selection.restoreLogin, "anon", "authenticated", "service_role", "platform_acquisition_runtime", "openlup_catalog_publication"],
  ]);
  await db.query(`REVOKE TEMP ON DATABASE ${identifier(database)} FROM PUBLIC;
    GRANT TEMP ON DATABASE ${identifier(database)} TO ${existing.rows.map(row => identifier(row.rolname)).join(", ")}`);
}

async function acl(client: PoolClient) {
  return (await client.query(`
    SELECT p.oid::pg_catalog.regprocedure::pg_catalog.text AS routine,
      pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS settings,
      ARRAY(SELECT pg_catalog.pg_get_userbyid(a.grantor) || ':' || a.privilege_type || ':' || a.is_grantable
        FROM pg_catalog.aclexplode(p.proacl) a JOIN pg_catalog.pg_roles r ON r.oid = a.grantee WHERE r.rolname = $2) AS grants
    FROM pg_catalog.pg_proc p WHERE p.oid = ANY(ARRAY(SELECT pg_catalog.to_regprocedure(s) FROM pg_catalog.unnest($1::text[]) s))
    ORDER BY CASE WHEN p.proname = 'catalog_admission_lock_shared' THEN 0 WHEN p.proname = 'catalog_admission_lock_checkout_price' THEN 1 ELSE 2 END`,
  [checkoutOwnerRoutines, checkoutOwnerLogin])).rows;
}

async function append(client: PoolClient, entry: (typeof files)[number]): Promise<void> {
  await client.query(entry.sql);
  await client.query(`INSERT INTO public.platform_schema_migrations (catalog_path,sha256,position)
    SELECT $1,$2,max(position)+1 FROM ${ledger}`, [entry.file, entry.sha256]);
}

export async function proveCheckoutOwnerGrant(connectionString: string, ordinaryConnectionString: string, selection: QualifiedSelection, password: string,
  freshConnectionString?: string): Promise<void> {
  const admin = selection.generation === "qualified-admin";
  const projected = admin ? (client: PoolClient) => qualifiedAdminPostgresCatalogPayload(client, selection, lockName)
    : (client: PoolClient) => qualifiedPostgresCatalogPayload(client, selection, lockName);
  const source = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as Parameters<typeof withPlatformCatalog>[0];
  const url = new URL(connectionString);
  url.searchParams.set("options", admin ? qualifiedAdminPostgresStartupOptions(selection) : qualifiedPostgresStartupOptions(selection));
  const pool = new Pool({ connectionString: url.href });
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1,0))", [lockName]);
    const prior = await projected(client);
    assert.ok(!prior.includes(checkoutOwnerLogin));
    await client.query("BEGIN");
    try {
      await append(client, files[0]!);
      assert.deepEqual((await acl(client)).map(row => row.grants), [[], [], []]);
      const prefix = (await client.query(`SELECT catalog_path,sha256,position FROM ${ledger} ORDER BY position`)).rows;
      for (const [position, message] of [[0, "rail"], [prefix.length - 1, "predecessor"]] as const) {
        await client.query("SAVEPOINT refused_grant");
        await client.query(`UPDATE public.platform_schema_migrations SET sha256=repeat('0',64) WHERE position=$1`, [position]);
        await assert.rejects(append(client, files[1]!), new RegExp(`checkout_owner_${message}_unverified`, "u"));
        await client.query("ROLLBACK TO SAVEPOINT refused_grant");
        assert.deepEqual((await client.query(`SELECT catalog_path,sha256,position FROM ${ledger} ORDER BY position`)).rows, prefix);
        assert.deepEqual((await acl(client)).map(row => row.grants), [[], [], []]);
      }
      await append(client, files[1]!);
      assert.deepEqual((await acl(client)).map(row => [row.owner, row.definer, row.settings, row.grants]),
        checkoutOwnerRoutines.map(() => [selection.migrationLogin, true, ["search_path=pg_catalog, pg_temp"], [`${selection.migrationLogin}:EXECUTE:false`]]));
      const payload = await projected(client);
      assert.ok(payload.includes(checkoutOwnerLogin));
      await client.query("ROLLBACK");
      await client.query("SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1,0))", [lockName]);
      await withPlatformCatalog(source, async root => {
        for (const plan of [source, source.qualified, source.qualifiedAdmin]) {
          plan.forward.push(...files.map(({ file, sha256 }) => ({ file, sha256 })));
        }
        if (admin) source.qualifiedAdmin.objectInventorySha256[selection.roleMode === "installer-managed" ? "installerManaged" : "operatorProvisioned"] = hash(payload);
        else source.qualified.objectInventorySha256[selection.bootstrapLogin === selection.migrationLogin ? "bootstrapMigrator" : "separateMigrator"].withRestore = hash(payload);
        for (const { file, sql } of files) {
          mkdirSync(dirname(join(root, file)), { recursive: true });
          writeFileSync(join(root, file), sql);
        }
        writeFileSync(join(root, "config/platform-migration-manifest.json"), JSON.stringify(source));
        const fixtureRunner = createPostgresMigrationRunner({ connectionString }, { root, installation: selection, poolFactory: () => pool });
        assert.deepEqual(await fixtureRunner.apply(), { applied: files.map(entry => entry.file) });
        assert.deepEqual(await fixtureRunner.apply(), { applied: [] });
        if (freshConnectionString && !admin) {
          const freshUrl = new URL(freshConnectionString);
          freshUrl.searchParams.set("options", qualifiedPostgresStartupOptions(selection));
          const freshPool = new Pool({ connectionString: freshUrl.href });
          try {
            const freshRunner = createPostgresMigrationRunner({ connectionString: freshConnectionString },
              { root, installation: selection, poolFactory: () => freshPool });
            const expected = [source.qualified.baseline, ...source.qualified.forward].map(entry => entry.file);
            assert.deepEqual(await freshRunner.status(), { pending: expected, applied: [] });
            assert.deepEqual(await freshRunner.apply(), { applied: expected });
            const observer = await freshPool.connect();
            try {
              await observer.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1,0))", [lockName]);
              assert.equal(await projected(observer), payload);
            } finally {
              await observer.query("SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1,0))", [lockName]);
              observer.release();
            }
          } finally {
            await freshPool.end();
          }
        }
      });
      await client.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1,0))", [lockName]);
      assert.equal(await projected(client), payload);
      const after = await client.query(`SELECT catalog_path,sha256,position FROM ${ledger} ORDER BY position`);
      assert.deepEqual(after.rows.slice(-2).map(row => [row.catalog_path,row.sha256]), files.map(row => [row.file,row.sha256]));

      const checkout = new URL(connectionString);
      checkout.username = checkoutOwnerLogin;
      checkout.password = password;
      const owner = new Pool({ connectionString: checkout.href });
      const ordinary = new Pool({ connectionString: ordinaryConnectionString });
      try {
        assert.equal((await owner.query("SELECT session_user AS login")).rows[0].login, checkoutOwnerLogin);
        await owner.query("SELECT public.catalog_admission_lock_shared(),public.catalog_admission_lock_checkout_price(NULL,NULL)");
        const countOrders = async () => (await client.query("SELECT pg_catalog.count(*) AS total FROM public.commerce_orders")).rows;
        const ordersBefore = await countOrders();
        await assert.rejects(owner.query("SELECT public.catalog_admission_create_order_draft(NULL,NULL,NULL,NULL,NULL)"), /fixture_checkout_writer_dark/u);
        assert.deepEqual(await countOrders(), ordersBefore);
        assert.deepEqual((await client.query(`SELECT catalog_path,sha256,position FROM ${ledger} ORDER BY position`)).rows, after.rows);
        for (const statement of [
          "SELECT id FROM public.clients", "CREATE TABLE public.fixture_denied(id int)", "CREATE TEMP TABLE fixture_denied(id int)",
          `SET ROLE ${identifier(selection.migrationLogin)}`, "SET session_replication_role=replica",
        ]) await assert.rejects(owner.query(statement), { code: "42501" });
        for (const statement of [
          "SELECT public.catalog_admission_lock_shared()", "SELECT public.catalog_admission_lock_checkout_price(NULL,NULL)",
          "SELECT public.catalog_admission_create_order_draft(NULL,NULL,NULL,NULL,NULL)",
        ]) await assert.rejects(ordinary.query(statement), { code: "42501" });
      } finally {
        await Promise.all([owner.end(), ordinary.end()]);
      }
      await client.query("BEGIN");
      await client.query(`DELETE FROM public.platform_schema_migrations WHERE catalog_path = ANY($1)`, [files.map(row => row.file)]);
      await client.query(`DROP FUNCTION ${checkoutOwnerRoutines.join(", ")}`);
      assert.equal(await projected(client), prior);
      await client.query("COMMIT");
    } finally { await client.query("ROLLBACK"); }
  } finally {
    await client.query("SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1,0))", [lockName]);
    client.release();
    await pool.end();
  }
}
