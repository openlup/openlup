import type { PoolClient } from "pg";
import {
  readSelectedCatalogRowsForQualifiedInstall,
  selectedCatalogRowsPayloadForQualifiedInstall,
} from "./selectedCatalogProjection.js";

export interface QualifiedPostgresInstallation {
  generation: "qualified-v2";
  roleMode: "installer-managed" | "operator-provisioned";
  migrationLogin: string;
  bootstrapLogin: string;
  runtimeLogin: string;
  restoreLogin?: string;
}
type Applied = Readonly<{ file: string; sha256: string; position: number }>;
type CatalogRow = Awaited<ReturnType<typeof readSelectedCatalogRowsForQualifiedInstall>>[number];
type Attributes = Record<string, unknown>;
const BASELINE = "db/platform/migrations/q2_00000000000000_platform_baseline.sql";
const ACTOR = "db/platform/migrations/q2_20260810180001_self_host_actor_auth.sql";
const ACQUISITION = "db/platform/migrations/q2_20260816140000_acquisition_case_foundation.sql";
const IMPORT = "db/platform/migrations/q2_20261026140000_retained_client_subscription_import.sql";
const ACTOR_GROUPS = ["anon", "authenticated", "service_role"];
const ACQUISITION_GROUPS = ["platform_acquisition_owner", "platform_acquisition_runtime", "openlup_retained_import_owner"];
const GROUPS = [...ACTOR_GROUPS, ...ACQUISITION_GROUPS];
// PostgreSQL 16 predefined roles are a fixed host profile, not names supplied by the caller.
// https://www.postgresql.org/docs/16/predefined-roles.html
const PREDEFINED = ["pg_database_owner", "pg_read_all_data", "pg_write_all_data", "pg_read_all_settings", "pg_read_all_stats", "pg_stat_scan_tables", "pg_monitor", "pg_signal_backend", "pg_read_server_files", "pg_write_server_files", "pg_execute_server_program", "pg_checkpoint", "pg_use_reserved_connections", "pg_create_subscription"];
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
function fail(code: string): never { throw new Error(`qualified PostgreSQL installation refused: ${code}`); }
function attributes(row: CatalogRow): Attributes {
  const value: unknown = JSON.parse(row.attributes);
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("malformed_catalog_attributes");
  return value as Attributes;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function assertQualifiedPostgresSelection(value: QualifiedPostgresInstallation): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_selection");
  const keys = Object.keys(value).sort();
  const expected = ["generation", "roleMode", "migrationLogin", "bootstrapLogin", "runtimeLogin", ...(value.restoreLogin === undefined ? [] : ["restoreLogin"])].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected) || value.generation !== "qualified-v2"
    || !["installer-managed", "operator-provisioned"].includes(value.roleMode)) fail("invalid_selection");
  const names = [value.migrationLogin, value.bootstrapLogin, value.runtimeLogin, ...(value.restoreLogin === undefined ? [] : [value.restoreLogin])];
  if (names.some(name => typeof name !== "string" || !SAFE_NAME.test(name) || name.toUpperCase() === "PUBLIC" || GROUPS.includes(name) || PREDEFINED.includes(name))) fail("invalid_principal_name");
  if (value.runtimeLogin === value.migrationLogin || value.runtimeLogin === value.bootstrapLogin
    || value.restoreLogin !== undefined && [value.runtimeLogin, value.migrationLogin, value.bootstrapLogin].includes(value.restoreLogin)) fail("principal_alias_not_permitted");
}

/** Fixed, identifier-only startup transport. It grants no database capability. */
export function qualifiedPostgresStartupOptions(value: QualifiedPostgresInstallation): string {
  assertQualifiedPostgresSelection(value);
  return `-c openlup.qualified.runtime_login=${value.runtimeLogin} -c openlup.qualified.role_mode=${value.roleMode}${value.restoreLogin === undefined ? "" : ` -c openlup.qualified.restore_login=${value.restoreLogin}`}`;
}

const SESSION_FACTS_SQL = String.raw`
SELECT current_user::pg_catalog.text AS current_user,session_user::pg_catalog.text AS session_user,
  pg_catalog.current_schemas(true)::pg_catalog.text[] AS effective_search_path,
  (SELECT rolname::pg_catalog.text FROM pg_catalog.pg_roles WHERE oid OPERATOR(pg_catalog.=) 10) AS bootstrap_login,
  (SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_catalog.pg_database WHERE datname OPERATOR(pg_catalog.=) pg_catalog.current_database()) AS database_owner,
  pg_catalog.current_setting('server_version_num')::pg_catalog.int4 AS server_version_num,
  pg_catalog.current_setting('session_replication_role') AS replication_role,
  pg_catalog.current_setting('openlup.qualified.runtime_login',true) AS runtime_setting,
  pg_catalog.current_setting('openlup.qualified.restore_login',true) AS restore_setting,
  pg_catalog.current_setting('openlup.qualified.role_mode',true) AS mode_setting,
  pg_catalog.to_regclass('public.platform_schema_migrations') IS NOT NULL AS ledger_exists,
  (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid OPERATOR(pg_catalog.=) pg_catalog.to_regclass('public.platform_schema_migrations')) AS ledger_owner,
  EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE pid OPERATOR(pg_catalog.=) pg_catalog.pg_backend_pid()
    AND locktype OPERATOR(pg_catalog.=) 'advisory' AND granted AND objsubid OPERATOR(pg_catalog.=) 1
    AND classid OPERATOR(pg_catalog.=) ((pg_catalog.hashtextextended($3,0) OPERATOR(pg_catalog.>>) 32) OPERATOR(pg_catalog.&) 4294967295)::pg_catalog.oid
    AND objid OPERATOR(pg_catalog.=) (pg_catalog.hashtextextended($3,0) OPERATOR(pg_catalog.&) 4294967295)::pg_catalog.oid
    AND database OPERATOR(pg_catalog.=) (SELECT oid FROM pg_catalog.pg_database WHERE datname OPERATOR(pg_catalog.=) pg_catalog.current_database())) AS session_lock_held,
  EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl) AS default_privileges_exist,
  -- The exact admitted membership graph permits these SET targets even when
  -- INHERIT is false. Their capabilities must be denied before normalization.
  EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE
    (r.rolname OPERATOR(pg_catalog.=) $1 OR r.rolname OPERATOR(pg_catalog.=) ANY(ARRAY['anon','authenticated','service_role','platform_acquisition_runtime']::pg_catalog.name[])) AND
    (pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CREATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE pg_catalog.left(n.nspname,3) OPERATOR(pg_catalog.<>) 'pg_' AND n.nspname OPERATOR(pg_catalog.<>) 'information_schema' AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
    OR pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM'))) AS runtime_unsafe,
  CASE WHEN $2::pg_catalog.text IS NULL THEN false ELSE COALESCE((SELECT pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CREATE')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE pg_catalog.left(n.nspname,3) OPERATOR(pg_catalog.<>) 'pg_' AND n.nspname OPERATOR(pg_catalog.<>) 'information_schema' AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
    OR pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')
    FROM pg_catalog.pg_roles r WHERE r.rolname OPERATOR(pg_catalog.=) $2),true) END AS restore_unsafe,
  EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s CROSS JOIN LATERAL pg_catalog.unnest(s.setconfig) setting
    WHERE (s.setdatabase OPERATOR(pg_catalog.=) 0 OR s.setdatabase OPERATOR(pg_catalog.=) (SELECT oid FROM pg_catalog.pg_database WHERE datname OPERATOR(pg_catalog.=) pg_catalog.current_database()))
      AND (s.setrole OPERATOR(pg_catalog.=) 0 OR s.setrole OPERATOR(pg_catalog.=) ANY(SELECT oid FROM pg_catalog.pg_roles WHERE rolname OPERATOR(pg_catalog.=) $1 OR rolname OPERATOR(pg_catalog.=) $2))
      AND setting OPERATOR(pg_catalog.~~) 'session_replication_role=%' AND setting OPERATOR(pg_catalog.<>) 'session_replication_role=origin') AS unsafe_replication_default`;

type SessionFacts = {
  current_user: unknown; session_user: unknown; bootstrap_login: unknown; database_owner: unknown;
  server_version_num: unknown; replication_role: unknown; runtime_setting: unknown; restore_setting: unknown;
  mode_setting: unknown; ledger_exists: unknown; ledger_owner: unknown; session_lock_held: unknown;
  runtime_unsafe: unknown; restore_unsafe: unknown; unsafe_replication_default: unknown; default_privileges_exist: unknown;
  effective_search_path: unknown;
};
type CheckedCatalog = { rows: readonly CatalogRow[]; protectedNames: ReadonlySet<string> };

function assertFlags(row: CatalogRow | undefined, expected: { login: boolean; inherit: boolean; superuser: boolean; elevated: boolean }): void {
  if (!row) return fail("required_role_missing");
  const a = attributes(row);
  if (a.login !== expected.login || a.inherit !== expected.inherit || a.superuser !== expected.superuser
    || ["createRole", "createDb", "replication", "bypassRls"].some(key => a[key] !== expected.elevated)
    || a.connectionLimit !== -1 || a.validUntil !== null) fail("role_flags_differ_from_qualified_profile");
}

async function checkedCatalog(client: PoolClient, selection: QualifiedPostgresInstallation, applied: readonly Applied[], lockName: string): Promise<CheckedCatalog> {
  assertQualifiedPostgresSelection(selection);
  const facts = (await client.query<SessionFacts>(SESSION_FACTS_SQL, [selection.runtimeLogin, selection.restoreLogin ?? null, lockName])).rows[0];
  // The bound observation is safe before this check. Canonical visibility also
  // keeps reg* casts and PostgreSQL deparser output aligned with the fixed pins.
  if (!facts || !Array.isArray(facts.effective_search_path)
    || facts.effective_search_path.length !== 2 || facts.effective_search_path[0] !== "pg_catalog"
    || facts.effective_search_path[1] !== "public") fail("qualified_profile_requires_canonical_search_path");
  if (!facts || facts.current_user !== selection.migrationLogin || facts.session_user !== selection.migrationLogin
    || facts.bootstrap_login !== selection.bootstrapLogin || facts.database_owner !== selection.migrationLogin) fail("actual_login_or_database_owner_mismatch");
  if (typeof facts.server_version_num !== "number" || Math.trunc(facts.server_version_num / 10_000) !== 16) fail("requires_qualified_postgresql_16_profile");
  if (facts.session_lock_held !== true) fail("migration_session_lock_not_held");
  if (facts.replication_role !== "origin" || facts.runtime_unsafe !== false || facts.restore_unsafe !== false || facts.unsafe_replication_default !== false) fail("runtime_ddl_or_replication_capability_unsafe");
  if (facts.default_privileges_exist !== false) fail("qualified_profile_requires_canonical_default_privileges");
  if (facts.runtime_setting !== selection.runtimeLogin || facts.mode_setting !== selection.roleMode
    || (facts.restore_setting ?? "") !== (selection.restoreLogin ?? "")) fail("startup_binding_transport_mismatch");
  if (facts.ledger_exists !== true && facts.ledger_exists !== false) fail("malformed_ledger_observation");
  if (facts.ledger_exists === true && (applied.length === 0 || facts.ledger_owner !== selection.migrationLogin)) fail("empty_or_differently_owned_ledger");
  if (applied.length > 0 && applied[0]!.file !== BASELINE) fail("wrong_generation_prefix");
  if (applied.some(({ file }) => file === IMPORT) && selection.restoreLogin === undefined) fail("retained_import_requires_restore_login");
  const rows = await readSelectedCatalogRowsForQualifiedInstall(client);
  // Preserve the existing catalog parser's identity/ACL/role consistency checks.
  selectedCatalogRowsPayloadForQualifiedInstall(rows);
  const roles = new Map(rows.filter(row => row.kind === "role").map(row => [row.name, row]));
  assertFlags(roles.get(selection.bootstrapLogin), { login: true, inherit: true, superuser: true, elevated: true });
  if (selection.migrationLogin !== selection.bootstrapLogin) assertFlags(roles.get(selection.migrationLogin), { login: true, inherit: true, superuser: true, elevated: false });
  for (const name of [selection.runtimeLogin, ...(selection.restoreLogin === undefined ? [] : [selection.restoreLogin])]) assertFlags(roles.get(name), { login: true, inherit: false, superuser: false, elevated: false });
  const actorPresent = selection.roleMode === "operator-provisioned" || applied.some(({ file }) => file === ACTOR);
  const acquisitionPresent = selection.roleMode === "operator-provisioned" || applied.some(({ file }) => file === ACQUISITION);
  for (const name of GROUPS) {
    const present = ACTOR_GROUPS.includes(name) ? actorPresent : acquisitionPresent;
    if (present) assertFlags(roles.get(name), { login: false, inherit: false, superuser: false, elevated: false });
    else if (roles.has(name)) fail("installer_managed_role_preexists");
  }
  for (const name of PREDEFINED) {
    const role = roles.get(name);
    if (!role) fail("predefined_role_missing");
    const a = attributes(role);
    if (a.login !== false || a.superuser !== false || ["createRole", "createDb", "replication", "bypassRls"].some(key => a[key] !== false)) fail("predefined_role_elevated");
  }
  const protectedNames = new Set([...GROUPS, ...PREDEFINED, selection.migrationLogin, selection.bootstrapLogin, selection.runtimeLogin, ...(selection.restoreLogin === undefined ? [] : [selection.restoreLogin])]);
  for (const [name, role] of roles) if (!protectedNames.has(name)) {
    const a = attributes(role);
    if (name.startsWith("pg_")) fail("unsupported_predefined_role");
    if (["superuser", "createRole", "createDb", "replication", "bypassRls"].some(key => a[key] !== false)) fail("outside_role_has_host_authority");
  }
  const expectedEdges = ["pg_read_all_settings", "pg_read_all_stats", "pg_stat_scan_tables"].map(role => [role, "pg_monitor", selection.bootstrapLogin, false, true, true]);
  for (const name of actorPresent ? ACTOR_GROUPS : []) expectedEdges.push([name, selection.runtimeLogin, selection.bootstrapLogin, false, name === "service_role", true]);
  if (acquisitionPresent) expectedEdges.push(["platform_acquisition_runtime", selection.runtimeLogin, selection.bootstrapLogin, false, false, true]);
  const actualEdges: unknown[][] = [];
  for (const row of rows.filter(row => row.kind === "role-membership")) {
    const a = attributes(row);
    const edge = [a.grantedRole, a.memberRole, a.grantorRole, a.adminOption, a.inheritOption, a.setOption];
    if (protectedNames.has(String(a.grantedRole)) || protectedNames.has(String(a.memberRole))) actualEdges.push(edge);
    else if (protectedNames.has(String(a.grantorRole)) && a.grantorRole !== selection.bootstrapLogin && a.grantorRole !== selection.migrationLogin) fail("protected_grantor_has_outside_edge");
  }
  if (stable(actualEdges.map(stable).sort()) !== stable(expectedEdges.map(stable).sort())) fail("protected_membership_graph_differs");
  for (const row of rows) {
    if (row.kind === "role" || row.kind === "role-membership") continue;
    const a = attributes(row);
    if (row.kind === "default-privilege") fail("qualified_profile_requires_canonical_default_privileges");
    const principals = [a.owner, a.ownerRole, a.grantor, a.grantee,
      ...(row.kind === "policy" && Array.isArray(a.roles) ? a.roles : [])];
    if (principals.some(name => typeof name === "string" && name !== "PUBLIC" && !protectedNames.has(name))) fail("outside_principal_references_selected_catalog");
    if (typeof a.owner === "string" && ![selection.migrationLogin, selection.bootstrapLogin, "pg_database_owner", "platform_acquisition_owner", "openlup_retained_import_owner"].includes(a.owner)) fail("runtime_or_actor_owns_selected_object");
    if (a.owner === "openlup_retained_import_owner" && (!applied.some(({ file }) => file === IMPORT)
      || row.kind !== "function" || row.schema !== "public" || !["client_import_retained_row", "subscription_cycle_import_retained_row"].includes(row.name))) fail("unexpected_import_owner_object");
    if (row.kind === "schema" && !["public", "auth", "acquisition_private"].includes(row.name)) fail("unsupported_selected_schema");
  }
  if (facts.ledger_exists === false) {
    for (const row of rows) {
      const a = attributes(row);
      if (row.kind === "role" || row.kind === "role-membership"
        || row.kind === "extension" && row.name === "plpgsql"
        || row.kind === "schema" && row.name === "public"
        || row.kind === "acl-grant" && a.targetClass === "schema" && row.name === "public") continue;
      fail("fresh_generation_requires_empty_database");
    }
  }
  return { rows, protectedNames };
}

/** One read-only admission boundary called by the existing runner while its session lock is held. */
export async function assertQualifiedPostgresSession(client: PoolClient, applied: readonly Applied[], selection: QualifiedPostgresInstallation, lockName: string): Promise<void> {
  await checkedCatalog(client, selection, applied, lockName);
}

/** A distinct payload format; the issued selected-catalog-v2 payload remains untouched. */
export async function qualifiedPostgresCatalogPayload(client: PoolClient, selection: QualifiedPostgresInstallation, lockName: string): Promise<string> {
  const applied = (await client.query<{ file: string; sha256: string; position: number }>("SELECT catalog_path AS file,sha256,position FROM ONLY public.platform_schema_migrations ORDER BY position")).rows;
  const { rows, protectedNames } = await checkedCatalog(client, selection, applied, lockName);
  const sameRoot = selection.migrationLogin === selection.bootstrapLogin;
  const bindings = new Map<string, string>([
    [selection.migrationLogin, sameRoot ? "@q2:migrator-bootstrap" : "@q2:migrator"],
    [selection.bootstrapLogin, sameRoot ? "@q2:migrator-bootstrap" : "@q2:bootstrap"],
    [selection.runtimeLogin, "@q2:runtime"],
    ...(selection.restoreLogin === undefined ? [] : [[selection.restoreLogin, "@q2:restore"] as [string, string]]),
  ]);
  const principal = (value: unknown): unknown => typeof value === "string" ? bindings.get(value) ?? value : value;
  const normalized: CatalogRow[] = [];
  for (const row of rows) {
    const a = attributes(row);
    if (row.kind === "role" && !protectedNames.has(row.name)) continue;
    if (row.kind === "role-membership" && !protectedNames.has(String(a.grantedRole)) && !protectedNames.has(String(a.memberRole))) continue;
    let name = row.name;
    const args = [...row.arguments];
    if (typeof a.owner === "string") a.owner = principal(a.owner);
    if (row.kind === "role") name = String(principal(name));
    if (row.kind === "role-membership") {
      name = String(principal(name));
      args[0] = String(principal(args[0])); args[1] = String(principal(args[1]));
      a.grantedRole = principal(a.grantedRole); a.memberRole = principal(a.memberRole); a.grantorRole = principal(a.grantorRole);
    } else if (row.kind === "acl-grant") {
      args[args.length - 5] = String(principal(args[args.length - 5]));
      args[args.length - 4] = String(principal(args[args.length - 4]));
      a.grantor = principal(a.grantor); a.grantee = principal(a.grantee);
    } else if (row.kind === "default-privilege") {
      name = String(principal(name));
      args[1] = String(principal(args[1])); args[2] = String(principal(args[2]));
      a.ownerRole = principal(a.ownerRole); a.grantor = principal(a.grantor); a.grantee = principal(a.grantee);
    } else if (row.kind === "policy") {
      if (!Array.isArray(a.roles) || !a.roles.every(role => typeof role === "string")) fail("malformed_policy_principals");
      a.roles = a.roles.map(principal).sort();
    }
    normalized.push({ ...row, name, arguments: args, attributes: stable(a) });
  }
  const catalog: unknown = JSON.parse(selectedCatalogRowsPayloadForQualifiedInstall(normalized));
  return stable({ format: "qualified-catalog-v1", bindingShape: { migrationIsBootstrap: sameRoot, hasRestore: selection.restoreLogin !== undefined },
    criticalSession: { replicationRole: "origin", runtimeReplicationCapability: false, restoreReplicationCapability: false }, catalog });
}
