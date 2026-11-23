import { readFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { assertQualifiedAdminPostgresSelection, assertQualifiedPostgresSelection, assertQualifiedPostgresSession, qualifiedPostgresStartupOptions,
  type QualifiedAdminPostgresInstallation } from "./qualifiedInstall.js";

const selection = {
  generation: "qualified-v2", roleMode: "installer-managed", migrationLogin: "migration_login",
  bootstrapLogin: "cluster_root", runtimeLogin: "runtime_login", restoreLogin: "restore_login",
} as const;

describe("qualified PostgreSQL role input transport", () => {
  it("admits only the explicit RDS serial pair and preserves other extra-field refusals", () => {
    const admin = { ...selection, generation: "qualified-admin" } as const;
    expect(() => assertQualifiedAdminPostgresSelection(admin)).not.toThrow();
    expect(() => assertQualifiedAdminPostgresSelection({ ...admin, target: "rds", layout: "serial-cluster" })).not.toThrow();
    for (const extra of [{ target: "neon", layout: "serial-cluster" }, { target: "rds" },
      { layout: "serial-cluster" }, { target: "rds", layout: "parallel" }, { target: undefined, layout: undefined }]) {
      expect(() => assertQualifiedAdminPostgresSelection({ ...admin, ...extra } as QualifiedAdminPostgresInstallation))
        .toThrow("invalid_selection_keys");
    }
  });
  it("transports only the fixed enum and validated identifiers without credentials or arbitrary options", () => {
    expect(qualifiedPostgresStartupOptions(selection)).toBe("-c openlup.qualified.runtime_login=runtime_login -c openlup.qualified.role_mode=installer-managed -c openlup.qualified.restore_login=restore_login");
    expect(qualifiedPostgresStartupOptions({ ...selection, roleMode: "operator-provisioned", migrationLogin: "cluster_root" })).toContain("role_mode=operator-provisioned");
    const { restoreLogin: _restoreLogin, ...withoutRestore } = selection;
    expect(qualifiedPostgresStartupOptions(withoutRestore)).toBe("-c openlup.qualified.runtime_login=runtime_login -c openlup.qualified.role_mode=installer-managed");
  });

  it("refuses unsafe identifiers, aliases, unsupported modes and additional startup fields", () => {
    for (const runtimeLogin of ["runtime -c session_replication_role=replica", "runtime'", "runtime;SELECT", "a".repeat(64), "ümlaut", "PUBLIC", "service_role", "pg_read_all_data", "migration_login", "cluster_root", "restore_login"]) {
      expect(() => assertQualifiedPostgresSelection({ ...selection, runtimeLogin })).toThrow("refused");
    }
    expect(() => assertQualifiedPostgresSelection({ ...selection, restoreLogin: "runtime_login" })).toThrow("principal_alias_not_permitted");
    expect(() => assertQualifiedPostgresSelection({ ...selection, roleMode: "automatic" } as unknown as typeof selection)).toThrow("invalid_selection");
    expect(() => assertQualifiedPostgresSelection({ ...selection, options: "-c role=cluster_root" } as unknown as typeof selection)).toThrow("invalid_selection");
  });
});

const publicationForward = "db/platform/migrations/q2_20261123192500_catalog_publication_authority.sql";
it("provisions the reserved restricted login only in installer-managed mode", () => {
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
  expect(manifest.qualified.forward).toContainEqual({ file: publicationForward, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  expect(readFileSync(publicationForward, "utf8")).toContain(
    "IF current_setting('openlup.qualified.role_mode', true) = 'installer-managed' THEN\n    CREATE ROLE openlup_catalog_publication LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;");
  expect(() => assertQualifiedPostgresSelection({ ...selection, runtimeLogin: "openlup_catalog_publication" })).toThrow("invalid_principal_name");
});

it.each([
  { unsafe: false, diagnostic: /catalog_publication_login_missing.*Provision openlup_catalog_publication/u },
  { unsafe: true, diagnostic: /catalog_publication_login_invalid.*reset session_replication_role for openlup_catalog_publication/u },
])("gives the publication login its own refusal ($diagnostic)", async ({ unsafe, diagnostic }) => {
  const applied = [
    { file: "db/platform/migrations/q2_00000000000000_platform_baseline.sql", position: 0, sha256: "0".repeat(64) },
    { file: publicationForward, position: 1, sha256: "1".repeat(64) },
  ];
  const role = (name: string, inherit: boolean, elevated: boolean) => ({
    kind: "role", schema: null, name, arguments: [], definition: null,
    attributes: JSON.stringify({ login: true, inherit, superuser: inherit, createRole: elevated, createDb: elevated,
      replication: elevated, bypassRls: elevated, connectionLimit: -1, validUntil: null }),
  });
  const client = { async query(sql: string | object) { return typeof sql === "string" ? { rows: [{
    effective_search_path: ["pg_catalog", "public"], current_user: selection.migrationLogin, session_user: selection.migrationLogin,
    bootstrap_login: selection.bootstrapLogin, database_owner: selection.migrationLogin, server_version_num: 160014,
    replication_role: "origin", session_lock_held: true, runtime_unsafe: false, restore_unsafe: false,
    publication_replication_default_unsafe: unsafe, unsafe_replication_default: false,
    default_privileges_exist: false, runtime_setting: selection.runtimeLogin,
    restore_setting: selection.restoreLogin, mode_setting: "installer-managed", ledger_exists: true, ledger_owner: selection.migrationLogin,
  }] } : { rows: [{ checkout: null, checkoutPaths: [], catalog: [
    role(selection.bootstrapLogin, true, true), role(selection.migrationLogin, true, false),
    role(selection.runtimeLogin, false, false), role(selection.restoreLogin, false, false),
    ...(unsafe ? [role("openlup_catalog_publication", false, false)] : []),
  ] }] }; } } as PoolClient;
  await expect(assertQualifiedPostgresSession(client, applied, selection, "fixture"))
    .rejects.toThrow(diagnostic);
});

it.each([
  { kind: "role-membership", schema: null, name: "service_role", args: [],
    attributes: { grantedRole: "service_role", memberRole: "openlup_checkout_owner", grantorRole: "cluster_root" },
    publicText: "Remove all membership and grantor edges for the checkout login.",
    diagnostic: "Membership of openlup_checkout_owner in service_role issued by cluster_root." },
  { kind: "role-membership", schema: null, name: "openlup_checkout_owner", args: [],
    attributes: { grantedRole: "openlup_checkout_owner", memberRole: "fixture_member", grantorRole: "cluster_root" },
    publicText: "Remove all membership and grantor edges for the checkout login.",
    diagnostic: "Membership of fixture_member in openlup_checkout_owner issued by cluster_root." },
  { kind: "acl-grant", schema: "public", name: "fixture_function",
    args: ["routine", "uuid", "migration_login", "openlup_checkout_owner", "execute", "false", "stored"],
    attributes: { targetClass: "routine", grantee: "openlup_checkout_owner" },
    publicText: "Remove additional catalog access for the checkout login.",
    diagnostic: "Additional catalog access on routine public.fixture_function(uuid)." },
])("names the offending $kind in the maintainer diagnostic", async ({ kind, schema, name, args, attributes, publicText, diagnostic }) => {
  const client = { async query(sql: string | object) { return typeof sql === "string" ? { rows: [{
    effective_search_path: ["pg_catalog", "public"], current_user: selection.migrationLogin, session_user: selection.migrationLogin,
    bootstrap_login: selection.bootstrapLogin, database_owner: selection.migrationLogin, server_version_num: 160014,
    replication_role: "origin", session_lock_held: true, runtime_unsafe: false, restore_unsafe: false,
    unsafe_replication_default: false, default_privileges_exist: false, runtime_setting: selection.runtimeLogin,
    restore_setting: selection.restoreLogin, mode_setting: selection.roleMode, ledger_exists: false,
  }] } : { rows: [{ checkout: null, checkoutPaths: [], catalog: [
    { kind, schema, name, arguments: args, definition: null, attributes: JSON.stringify(attributes) },
  ] }] }; } } as PoolClient;
  await expect(assertQualifiedPostgresSession(client, [], selection, "fixture")).rejects.toMatchObject({
    message: `qualified PostgreSQL installation refused: checkout_owner_login_unready: openlup_checkout_owner. ${publicText}`,
    cause: { message: diagnostic },
  });
});
