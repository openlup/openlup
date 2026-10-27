/** Read-only prerequisites of the immutable legacy fresh-install bootstrap, not install readiness. */
export interface PostgresInstallQuery {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface LegacyPostgresInstallRequest {
  /** Expected actual login: both current_user and session_user must match. */
  migrationLogin: string;
  /** Legacy bootstrap requires this to be the same login as the migrator. */
  runtimeLogin: string;
  roleMode: "installer-managed" | "operator-provisioned";
}

export interface PostgresInstallRoleObservation {
  name: string;
  login: boolean;
  superuser: boolean;
  inherit: boolean;
  createRole: boolean;
  createDatabase: boolean;
  replication: boolean;
  bypassRls: boolean;
}

export interface PostgresInstallMembershipObservation {
  role: string;
  member: string;
  grantor: string;
  admin: boolean;
  inherit: boolean;
  set: boolean;
}

export type LegacyPostgresInstallBlocker =
  | "migration_login_mismatch"
  | "legacy_bootstrap_requires_superuser"
  | "legacy_bootstrap_requires_shared_runtime_login"
  | "runtime_login_missing_or_not_login"
  | "legacy_bootstrap_requires_installer_managed_roles"
  | "legacy_bootstrap_role_already_exists";

export interface LegacyPostgresInstallRoleReport {
  scope: "legacy-fresh-bootstrap-role-prerequisites";
  database: string;
  currentUser: string;
  sessionUser: string;
  roles: PostgresInstallRoleObservation[];
  memberships: PostgresInstallMembershipObservation[];
  blockers: { code: LegacyPostgresInstallBlocker; role?: string }[];
  rolePrerequisitesMet: boolean;
}

const BOOTSTRAP_ROLES = ["anon", "authenticated", "platform_acquisition_owner", "platform_acquisition_runtime"];
// One statement observes identities and the relevant role graph in the same statement snapshot.
// No SQL, identifiers, credentials or catalog expectations come from the caller.
const OBSERVE = `SELECT current_database() AS database, current_user::text AS "currentUser",
  session_user::text AS "sessionUser",
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('name', rolname, 'login', rolcanlogin,
    'superuser', rolsuper, 'inherit', rolinherit, 'createRole', rolcreaterole,
    'createDatabase', rolcreatedb, 'replication', rolreplication, 'bypassRls', rolbypassrls)
    ORDER BY rolname), '[]'::jsonb) FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[]) OR rolname = current_user) AS roles,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object('role', granted.rolname, 'member', member.rolname,
    'grantor', grantor.rolname, 'admin', m.admin_option, 'inherit', m.inherit_option, 'set', m.set_option)
    ORDER BY granted.rolname, member.rolname, grantor.rolname), '[]'::jsonb)
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = m.member
    JOIN pg_catalog.pg_roles grantor ON grantor.oid = m.grantor
    WHERE granted.rolname = ANY($1::text[]) OR member.rolname = ANY($1::text[])) AS memberships`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validRows<T>(value: unknown, texts: string[], flags: string[]): value is T[] {
  return Array.isArray(value) && value.every(row => isRecord(row)
    && texts.every(key => typeof row[key] === "string" && row[key].length > 0)
    && flags.every(key => typeof row[key] === "boolean"));
}

/**
 * Observes PostgreSQL 16+ legacy role prerequisites without changing the database.
 * A true result says nothing about schema inventory, object ACLs, pooling, import safety or hosting.
 * Query/driver errors are redacted because they can contain connection credentials.
 */
export async function inspectLegacyPostgresInstallRoles(
  db: PostgresInstallQuery,
  request: LegacyPostgresInstallRequest,
): Promise<LegacyPostgresInstallRoleReport> {
  if (![request.migrationLogin, request.runtimeLogin].every(name => typeof name === "string" && name.trim().length > 0)
    || !["installer-managed", "operator-provisioned"].includes(request.roleMode)) {
    throw new Error("postgres_install_request_invalid");
  }
  let rows: Record<string, unknown>[];
  try {
    ({ rows } = await db.query(OBSERVE, [[...new Set([...BOOTSTRAP_ROLES, request.migrationLogin, request.runtimeLogin])]]));
  } catch {
    throw new Error("postgres_install_observation_failed");
  }
  const row = rows[0];
  if (rows.length !== 1 || !row
    || ![row.database, row.currentUser, row.sessionUser].every(value => typeof value === "string" && value.length > 0)
    || !validRows<PostgresInstallRoleObservation>(row.roles, ["name"], ["login", "superuser", "inherit", "createRole", "createDatabase", "replication", "bypassRls"])
    || !validRows<PostgresInstallMembershipObservation>(row.memberships, ["role", "member", "grantor"], ["admin", "inherit", "set"])) {
    throw new Error("postgres_install_observation_invalid");
  }
  const roles = row.roles;
  const blockers: LegacyPostgresInstallRoleReport["blockers"] = [];
  if (row.currentUser !== request.migrationLogin || row.sessionUser !== request.migrationLogin) blockers.push({ code: "migration_login_mismatch" });
  if (!roles.some(role => role.name === row.currentUser && role.superuser)) blockers.push({ code: "legacy_bootstrap_requires_superuser" });
  if (row.currentUser !== request.runtimeLogin) blockers.push({ code: "legacy_bootstrap_requires_shared_runtime_login" });
  if (!roles.some(role => role.name === request.runtimeLogin && role.login)) blockers.push({ code: "runtime_login_missing_or_not_login" });
  if (request.roleMode !== "installer-managed") blockers.push({ code: "legacy_bootstrap_requires_installer_managed_roles" });
  for (const name of BOOTSTRAP_ROLES) {
    if (roles.some(role => role.name === name)) blockers.push({ code: "legacy_bootstrap_role_already_exists", role: name });
  }
  return {
    scope: "legacy-fresh-bootstrap-role-prerequisites",
    database: row.database as string, currentUser: row.currentUser as string, sessionUser: row.sessionUser as string,
    roles, memberships: row.memberships, blockers, rolePrerequisitesMet: blockers.length === 0,
  };
}
