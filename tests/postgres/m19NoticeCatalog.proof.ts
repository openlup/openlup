// Explicit local manifest measurement: node --import tsx tests/postgres/m19NoticeCatalog.proof.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresCatalogPayload, qualifiedPostgresStartupOptions, qualifiedAdminPostgresCatalogPayload,
  qualifiedAdminPostgresStartupOptions, type QualifiedPostgresInstallation, type QualifiedAdminPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "../../server/adapters/postgres/selectedCatalogProjection.js";
import { selectPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";

const forward = "db/platform/migrations/20261101231000_native_paid_email.sql";
const bytes = readFileSync(forward, "utf8");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const baseCommit = execFileSync("git", ["merge-base", "HEAD", "origin/main"], { encoding: "utf8" }).trim();
const base = JSON.parse(execFileSync("git", ["show", `${baseCommit}:config/platform-migration-manifest.json`], { encoding: "utf8" })) as PlatformMigrationManifest;
assert.equal(base.schemaVersion, 3);
if (base.schemaVersion !== 3) throw new Error("Native notice proof requires all three selected catalog generations");
assert.equal(base.forward.some(unit => unit.file === forward), false, "Native notice measurement requires its pre-feature review base");
const next = structuredClone(base);
mkdirSync(".context/scratch", { recursive: true });
const prefix = mkdtempSync(".context/scratch/g8-catalog-");
for (const { file } of [base.baseline, ...base.forward, base.qualified.baseline, ...base.qualified.forward,
  base.qualifiedAdmin.baseline, ...base.qualifiedAdmin.forward]) {
  mkdirSync(dirname(join(prefix, file)), { recursive: true }); copyFileSync(file, join(prefix, file));
}
mkdirSync(join(prefix, "config"));
writeFileSync(join(prefix, "config/platform-migration-manifest.json"), JSON.stringify(base));
const lock = "openlup:public-platform-migrations:v1";
const password = "synthetic-only";
const groups = ["anon", "authenticated", "service_role", "platform_acquisition_owner", "platform_acquisition_runtime", "openlup_retained_import_owner"];
try {
  for (const profile of ["legacy", "qualified-bootstrap", "qualified-separate", "admin-installer", "admin-operator"] as const) {
    const container = await runPostgresContainer({ name: `m19-g8-catalog-${profile}-${process.pid}`, password: "synthetic-conformance" });
    const pools: Pool[] = [];
    try {
      assert.equal(await waitForPostgresTcpReady(container.connectionString), true);
      const make = (connectionString: string, options?: string) => { const pool = new Pool({ connectionString, options }); pools.push(pool); return pool; };
      const login = (role: string) => { const url = new URL(container.connectionString); url.username = role; url.password = password; return url.toString(); };
      const admin = make(container.connectionString);
      let selection: { generation: "legacy" } | QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation = { generation: "legacy" };
      let connection = container.connectionString, startup: string | undefined;
      if (profile !== "legacy") {
        const restricted = profile.startsWith("admin-");
        const operator = profile === "admin-operator";
        const separate = profile !== "qualified-bootstrap";
        if (separate) {
          await admin.query(`CREATE ROLE g8_catalog_m LOGIN ${restricted ? "NOINHERIT NOSUPERUSER" : "INHERIT SUPERUSER"}
            ${restricted && !operator ? "CREATEROLE" : "NOCREATEROLE"} NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}';
            ALTER DATABASE postgres OWNER TO g8_catalog_m`);
          connection = login("g8_catalog_m");
        }
        await admin.query(`CREATE ROLE g8_catalog_r LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}';
          CREATE ROLE g8_catalog_s LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
        if (operator) {
          await admin.query(`CREATE ROLE g8_catalog_o LOGIN NOINHERIT NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
          const authority = make(login("g8_catalog_o"));
          for (const group of groups) {
            await admin.query(`CREATE ROLE ${group} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS;
              GRANT ${group} TO g8_catalog_o WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
            await authority.query(`GRANT ${group} TO g8_catalog_m WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY g8_catalog_o`);
            if (["anon", "authenticated", "service_role", "platform_acquisition_runtime"].includes(group))
              await authority.query(`GRANT ${group} TO g8_catalog_r WITH ADMIN FALSE, INHERIT ${group === "service_role" ? "TRUE" : "FALSE"}, SET TRUE GRANTED BY g8_catalog_o`);
          }
        }
        if (restricted) {
          const common = { generation: "qualified-admin" as const, bootstrapLogin: "postgres",
            migrationLogin: "g8_catalog_m", runtimeLogin: "g8_catalog_r", restoreLogin: "g8_catalog_s" };
          selection = operator ? { ...common, roleMode: "operator-provisioned", operatorLogin: "g8_catalog_o" }
            : { ...common, roleMode: "installer-managed" };
          startup = qualifiedAdminPostgresStartupOptions(selection);
        } else {
          selection = { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres",
            migrationLogin: separate ? "g8_catalog_m" : "postgres", runtimeLogin: "g8_catalog_r", restoreLogin: "g8_catalog_s" };
          startup = qualifiedPostgresStartupOptions(selection);
        }
      }
      const migration = make(connection, startup);
      const runner = createPostgresMigrationRunner({ connectionString: connection }, { root: prefix, installation: selection, poolFactory: () => migration });
      await runner.apply();
      assert.deepEqual((await runner.status()).pending, []);
      const caller = await migration.connect();
      try {
        await caller.query("SET search_path=pg_catalog,public");
        await caller.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [lock]);
        const project = () => selection.generation === "legacy" ? readSelectedCatalogProjection(caller).then(selectedCatalogProjectionPayload)
          : selection.generation === "qualified-v2" ? qualifiedPostgresCatalogPayload(caller, selection, lock)
          : qualifiedAdminPostgresCatalogPayload(caller, selection, lock);
        const before = hash(await project());
        const expected = selection.generation === "legacy" ? selectPlatformMigrationManifest(base, "legacy")
          : selection.generation === "qualified-v2" ? selectPlatformMigrationManifest(base, "qualified-v2", { migrationIsBootstrap: profile === "qualified-bootstrap", hasRestore: true })
          : selectPlatformMigrationManifest(base, "qualified-admin", { roleMode: selection.roleMode });
        assert.equal(before, expected.objectInventorySha256);
        await caller.query(bytes);
        const after = hash(await project());
        if (profile === "legacy") next.objectInventorySha256 = after;
        else if (profile === "qualified-bootstrap") next.qualified.objectInventorySha256.bootstrapMigrator.withRestore = after;
        else if (profile === "qualified-separate") next.qualified.objectInventorySha256.separateMigrator.withRestore = after;
        else next.qualifiedAdmin.objectInventorySha256[profile === "admin-installer" ? "installerManaged" : "operatorProvisioned"] = after;
        console.info(JSON.stringify({ profile, before, after }));
      } finally { await caller.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lock]); caller.release(); }
    } finally { await closePostgres(container, pools); }
  }
  for (const units of [next.forward, next.qualified.forward, next.qualifiedAdmin.forward]) units.push({ file: forward, sha256: hash(bytes) });
  writeFileSync(".context/scratch/g8-manifest.json", `${JSON.stringify(next, null, 2)}\n`);
} finally { rmSync(prefix, { recursive: true, force: true }); }
