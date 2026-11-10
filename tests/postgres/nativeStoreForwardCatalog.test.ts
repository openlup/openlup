import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { readReviewedForwardRegistry, nativeStoreAddedForeignKeys, nativeStoreCreatedTable, nativeStoreTriggerDefinition, sqlSha256, sqlStatements, type NativeStoreSlot } from "../../scripts/reviewed-platform-forward.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

// The static native-store class is a first gate for ordinary mistakes. This test is the
// truth for function identity, attributes and ACLs: it applies a forward to a real
// database and compares what PostgreSQL itself reports with the slot's lists.
type CatalogSlot = Pick<NativeStoreSlot, "createdFunctions" | "replacedFunctions" | "grantOnlyFunctions" | "purposeCheck" | "insertSelectTables" | "absorptionCensusTables" | "checkSupersets" | "uniqueSupersets" | "droppedIndexes" | "createdViews" | "createdTriggers" | "existingTableStatements">;
// PostgreSQL creates its own objects below this OID; every object a forward adds is at or above it.
const FIRST_USER_OID = 16384;
// The floor is typed as oid, so every comparison with it resolves to pg_catalog's own oid >= oid and oid < oid. A bare integer
// would resolve to an operator for (oid, integer), which a forward can create in pg_catalog to hide the objects it adds.
const OID_FLOOR = `${FIRST_USER_OID}::pg_catalog.oid`;
const PURPOSE_CONSTRAINT = "public.communication_native_sync_state.communication_native_sync_state_purpose_check";
const GRANT_OPTION = " WITH GRANT OPTION";
// Node trees (default arguments, rules, policies, trigger conditions) store where the parser read them in the file, which
// moves when the same statement sits at another offset. That is compared as nothing; everything else in a tree is compared.
const POSITIONS = String.raw`':(?:stmt_)?location -?[0-9]+|:stmt_len [0-9]+', ':position'`;

type FunctionRow = { oid: number; name: string; owner: string; attrs: Record<string, unknown>; acl: string[]; src: string };
type RelationRow = { oid: number; name: string; schema: string; relation: string; kind: string; owner: string; rls: boolean; forceRls: boolean; options: string | null; acl: string[]; columnAcls: unknown };
type Snapshot = {
  indexes: { oid: number; name: string; table: string; definition: string; attrs: unknown }[];
  functions: FunctionRow[]; relations: RelationRow[]; columns: { rel: string; name: string; attrs: Record<string, unknown>; default: string | null }[]; system: { functions: string; relations: string };
  relationOids: number[]; constraintOids: number[]; constraints: { rel: string; name: string; def: string; validated: boolean; indexOid: number }[]; guards: Record<string, Record<string, unknown>[]>;
};
// Every guard catalog is read whole through to_jsonb, with its OID and volatile columns left out and parser positions in
// node trees normalized, so a new guard is one entry here. `relation` names the column that ties a row to a relation:
// those rows are compared for existing relations only. The documentation lists exactly these catalogs.
// `added` admits a row that appears after the forward and was not there before: only the enforcement trigger PostgreSQL creates
// for a constraint the forward itself adds. A relation is existing when any relation of that OID was there before, PostgreSQL's own included.
const GUARDS: { id: string; catalog: string; where?: string; drop?: string[]; relation?: string; added?: (row: Record<string, unknown>, newConstraints: Set<number>) => boolean }[] = [
  { id: "schemas", catalog: "pg_namespace", where: "t.nspname !~ '^pg_(toast_)?temp_'" },
  { id: "roles", catalog: "pg_authid" }, { id: "memberships", catalog: "pg_auth_members" }, { id: "dbSettings", catalog: "pg_db_role_setting" },
  { id: "databases", catalog: "pg_database", drop: ["datfrozenxid", "datminmxid"] }, { id: "defaultAcls", catalog: "pg_default_acl" },
  { id: "eventTriggers", catalog: "pg_event_trigger" }, { id: "extensions", catalog: "pg_extension" },
  { id: "casts", catalog: "pg_cast" }, { id: "parameterAcls", catalog: "pg_parameter_acl" },
  { id: "triggers", catalog: "pg_trigger", relation: "tgrelid", added: (row, newConstraints) => row.tgisinternal === true && newConstraints.has(Number(row.tgconstraint)) }, { id: "policies", catalog: "pg_policy", relation: "polrelid" },
  { id: "rules", catalog: "pg_rewrite", relation: "ev_class" },
];
const aclOf = (expr: string, kind: string, owner: string) => `ARRAY(SELECT (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END)||':'||a.privilege_type||(CASE WHEN a.is_grantable THEN '${GRANT_OPTION}' ELSE '' END)
  FROM aclexplode(COALESCE(${expr}, acldefault(${kind}, ${owner}))) a ORDER BY 1)`;

// Preserve every structural attribute; normalize only parse positions.
async function snapshot(db: PoolClient): Promise<Snapshot> {
  const functions = (await db.query(`SELECT p.oid::int AS oid, p.oid::regprocedure::text AS name, p.proowner::regrole::text AS owner,
    (to_jsonb(p)-'prosrc'-'proacl'-'proargdefaults')||jsonb_build_object('proargdefaults',regexp_replace(COALESCE(p.proargdefaults::text,''),${POSITIONS},'g')) AS attrs,
    ${aclOf("p.proacl", "'f'", "p.proowner")} AS acl, p.prosrc AS src
    FROM pg_proc p WHERE p.oid >= ${OID_FLOOR} ORDER BY p.oid`)).rows;
  const relations = (await db.query(`SELECT c.oid::int AS oid, c.oid::regclass::text AS name, n.nspname::text AS schema, c.relname::text AS relation,
    c.relkind::text AS kind, c.relowner::regrole::text AS owner,
    c.relrowsecurity AS rls, c.relforcerowsecurity AS "forceRls", c.reloptions::text AS options,
    ${aclOf("c.relacl", "(CASE WHEN c.relkind='S' THEN 's' ELSE 'r' END)::\"char\"", "c.relowner")} AS acl,
    (SELECT jsonb_agg(jsonb_build_array(a.attname,a.attacl::text) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attacl IS NOT NULL) AS "columnAcls"
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid >= ${OID_FLOOR} ORDER BY c.oid`)).rows;
  // Objects PostgreSQL ships are compared as one digest of the facts that carry privileges; statistics columns are left out
  // because autovacuum changes them between two snapshots.
  const system = (await db.query(`SELECT
    md5(COALESCE((SELECT string_agg(to_jsonb(p)::text, E'\\n' ORDER BY p.oid) FROM pg_proc p WHERE p.oid < ${OID_FLOOR}),'')) AS functions,
    md5(COALESCE((SELECT string_agg(jsonb_build_array(c.oid,c.relname,c.relnamespace,c.relowner,c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.reloptions,c.relacl::text)::text, E'\\n' ORDER BY c.oid) FROM pg_class c WHERE c.oid < ${OID_FLOOR}),'')
      || COALESCE((SELECT string_agg(a.attrelid||'.'||a.attname||'='||a.attacl::text, E'\\n' ORDER BY a.attrelid,a.attnum) FROM pg_attribute a WHERE a.attrelid < ${OID_FLOOR} AND a.attacl IS NOT NULL),'')) AS relations`)).rows[0];
  // The relation is schema-qualified explicitly: regclass text omits a schema that is on the search path.
  const constraints = (await db.query(`SELECT COALESCE(n.nspname||'.'||c.relname, 'type:'||con.contypid::regtype::text) AS rel, con.conname AS name, pg_get_constraintdef(con.oid) AS def, con.convalidated AS validated, con.conindid::int AS "indexOid"
    FROM pg_constraint con LEFT JOIN pg_class c ON c.oid=con.conrelid LEFT JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE con.contype <> 'n' ORDER BY 1,2`)).rows;
  const columns = (await db.query(`SELECT n.nspname||'.'||c.relname AS rel, a.attname AS name,
    to_jsonb(a)-'attrelid' AS attrs, pg_get_expr(d.adbin,d.adrelid) AS default
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE c.relkind IN ('r','p') AND a.attnum>0 ORDER BY 1,a.attnum`)).rows;
  const indexes = (await db.query(`SELECT c.oid::int AS oid, n.nspname||'.'||c.relname AS name,
    tn.nspname||'.'||t.relname AS table, pg_get_indexdef(c.oid) AS definition,
    regexp_replace(to_jsonb(i)::text, ${POSITIONS}, 'g')::jsonb AS attrs
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace tn ON tn.oid=t.relnamespace ORDER BY c.oid`)).rows;
  const relationOids = (await db.query("SELECT oid::int AS oid FROM pg_class ORDER BY oid")).rows.map(row => row.oid as number);
  const constraintOids = (await db.query("SELECT oid::int AS oid FROM pg_constraint ORDER BY oid")).rows.map(row => row.oid as number);
  const guards: Snapshot["guards"] = {};
  for (const guard of GUARDS) guards[guard.id] = (await db.query(`SELECT COALESCE(jsonb_agg(r ORDER BY r),'[]'::jsonb) AS rows FROM (
    SELECT regexp_replace((to_jsonb(t)${["oid", ...guard.drop ?? []].map(key => ` - '${key}'`).join("")})::text, ${POSITIONS}, 'g')::jsonb AS r
    FROM ${guard.catalog} t WHERE ${guard.where ?? "true"}) s`)).rows[0].rows;
  return { functions, relations, columns, indexes, system, relationOids, constraintOids, constraints, guards };
}

const norm = (path: string) => `search_path=${path.replace(/\s+/gu, " ").trim()}`;
const quotedValues = (list: string) => (list.match(/'((?:[^']|'')*)'/gu) ?? []).map(value => value.slice(1, -1).replaceAll("''", "'"));
// Only the positive IN shape PostgreSQL deparses reads as a value list. The superset guard
// strips NOT VALID only after proving equal validation states; other clauses remain refused.
const checkValues = (def: string, column: string) => {
  const shape = new RegExp(`^CHECK \\(\\(${column} = ANY \\(ARRAY\\[((?:'(?:[^']|'')*'::text)(?:, '(?:[^']|'')*'::text)*)\\]\\)\\)\\)$`, "u");
  const match = shape.exec(def); return match ? quotedValues(match[1]!) : null;
};
const PURPOSE_SHAPE = /^CHECK \(\(purpose = ANY \(ARRAY\[((?:'(?:[^']|'')*'::text)(?:, '(?:[^']|'')*'::text)*)\]\)\)\)$/u;
const purposeValues = (def: string) => { const match = PURPOSE_SHAPE.exec(def); return match ? quotedValues(match[1]!) : null; };
const uniqueDefinition = (def: string) => {
  const match = /^UNIQUE( NULLS NOT DISTINCT)? \(([a-z_][a-z0-9_]*(?:, [a-z_][a-z0-9_]*)*)\)$/u.exec(def);
  return match ? { columns: match[2]!.split(", "), nullsNotDistinct: Boolean(match[1]) } : null;
};
const fail = (message: string): never => { throw new Error(`catalog: ${message}`); };

/** Compare PostgreSQL's own before/after catalogs with one slot's closed lists. Throws on any difference. */
async function assertSlotCatalog(db: PoolClient, slot: CatalogSlot, before: Snapshot, after: Snapshot, migrationRole: string, forward = "") {
  const resolve = async (signature: string) => Number((await db.query("SELECT $1::regprocedure::oid::int AS oid", [signature])).rows[0].oid);
  const created = new Map<number, CatalogSlot["createdFunctions"][number]>();
  for (const fn of slot.createdFunctions) created.set(await resolve(fn.signature), fn);
  const replaced = new Set<number>(); for (const fn of slot.replacedFunctions) replaced.add(await resolve(fn.signature));
  const grantOnly = new Map<number, CatalogSlot["grantOnlyFunctions"][number]>();
  for (const fn of slot.grantOnlyFunctions) grantOnly.set(await resolve(fn.signature), fn);

  // 0. Nothing PostgreSQL ships changes: not a function, a relation privilege or a column privilege.
  if (JSON.stringify(before.system) !== JSON.stringify(after.system)) fail("a system catalog function, relation or column privilege changed");

  // 1. New functions are exactly the created list, wherever they were created.
  const knownFunctions = new Set(before.functions.map(row => row.oid));
  const added = after.functions.filter(row => !knownFunctions.has(row.oid));
  const byOid = (x: number, y: number) => x - y;
  if (JSON.stringify(added.map(row => row.oid).sort(byOid)) !== JSON.stringify([...created.keys()].sort(byOid))) fail(`created functions differ from the slot list: ${added.map(row => row.name).join(", ")}`);

  // 2. Existing functions change only inside the replaced and grant-only lists.
  const current = new Map(after.functions.map(row => [row.oid, row]));
  for (const old of before.functions) {
    const now = current.get(old.oid);
    if (!now) return fail(`function ${old.name} was dropped`);
    if (replaced.has(old.oid)) {
      if (JSON.stringify(now.attrs) !== JSON.stringify(old.attrs) || JSON.stringify(now.acl) !== JSON.stringify(old.acl)) fail(`replaced function ${old.name} changed attributes or ACL`);
    } else if (grantOnly.has(old.oid)) {
      const entry = grantOnly.get(old.oid)!;
      if (JSON.stringify(now.attrs) !== JSON.stringify(old.attrs) || now.src !== old.src) fail(`grant-only function ${old.name} was redefined`);
      const gained = now.acl.filter(item => !old.acl.includes(item)); const lost = old.acl.filter(item => !now.acl.includes(item));
      const ok = (item: string, roles: string[]) => roles.some(role => item.startsWith(`${role}:`));
      if (gained.some(item => !item.endsWith(":EXECUTE") || !ok(item, entry.grantTo))) fail(`grant-only function ${old.name} gained ${gained.join(", ")} outside its grant list`);
      if (lost.some(item => !ok(item, [...entry.revokeFrom, ...entry.grantTo]))) fail(`grant-only function ${old.name} lost ${lost.join(", ")} outside its role lists`);
    } else if (JSON.stringify(now) !== JSON.stringify(old)) fail(`function ${old.name} changed but is on no slot list`);
  }

  // 3. Created functions: owned by the migration role, pinned search_path for every definer, no PUBLIC or anon execute, closed grantees only.
  for (const row of added) {
    const entry = created.get(row.oid)!;
    if (row.owner !== migrationRole) fail(`created function ${row.name} is owned by ${row.owner}, not the migration role`);
    const config = row.attrs.proconfig as string[] | null;
    if (entry.searchPath !== null) { if (JSON.stringify(config) !== JSON.stringify([norm(entry.searchPath)])) fail(`created function ${row.name} has proconfig ${JSON.stringify(config)}, not the pinned search_path`); }
    else if (row.attrs.prosecdef) fail(`created definer ${row.name} has no pinned search_path in its slot`);
    else if (config !== null) fail(`created function ${row.name} has proconfig ${JSON.stringify(config)} but its slot pins none`);
    if (row.acl.some(item => item.startsWith("PUBLIC:"))) fail(`created function ${row.name} keeps PUBLIC execute`);
    for (const item of row.acl) {
      const grantee = item.slice(0, item.indexOf(":"));
      if (grantee !== migrationRole && !["authenticated", "service_role"].includes(grantee)) fail(`created function ${row.name} grants ${item}`);
      if (grantee !== migrationRole && item.endsWith(GRANT_OPTION)) fail(`created function ${row.name} grants ${item}, which can pass the privilege on`);
    }
  }

  // 4. Relations: no privilege or row-security change on an existing one; a new one is owned by the migration role and carries only its privileges.
  const oldRelations = new Map(before.relations.map(row => [row.oid, row]));
  const currentRelations = new Map(after.relations.map(row => [row.oid, row]));
  const replacedUniqueIndexes = new Set(before.constraints.filter(old => slot.uniqueSupersets?.some(entry => entry.table === old.rel && entry.constraint === old.name)).map(old => old.indexOid));
  const droppedIndexes = new Set<number>(), listedIndexes = new Set((slot.droppedIndexes ?? []).map(entry => `public.${entry.name}`));
  for (const entry of slot.droppedIndexes ?? []) {
    const name = `public.${entry.name}`, index = before.indexes.find(index => index.name === name);
    if (!index || index.table !== entry.table || before.constraints.some(constraint => constraint.indexOid === index.oid) || after.indexes.some(now => now.oid === index.oid || now.name === name)) fail(`listed index ${name} must be a removed standalone index on ${entry.table}`);
    droppedIndexes.add(index!.oid);
    for (const facts of ["columns", "constraints"] as const) if (JSON.stringify(before[facts].filter(row => row.rel === entry.table)) !== JSON.stringify(after[facts].filter(row => row.rel === entry.table))) fail(`dropped index table ${entry.table} changed ${facts}`);
    for (const old of before.indexes.filter(old => old.table === entry.table && !listedIndexes.has(old.name))) if (JSON.stringify(after.indexes.find(now => now.oid === old.oid)) !== JSON.stringify(old)) fail(`other index ${old.name} changed beside a listed drop`);
    // History can reach the index without naming it (escaped identifiers, built SQL), so PostgreSQL
    // proves that the dropped index is exactly what its pinned CREATE builds.
    const create = indexStatements.get(entry.beforeSha256) ?? fail(`listed index ${name} has no pinned CREATE`);
    await db.query("SAVEPOINT pinned_index");
    try {
      await db.query(create);
      if ((await db.query("SELECT pg_get_indexdef($1::regclass) AS definition", [name])).rows[0].definition !== index!.definition) fail(`listed index ${name} differs from its pinned CREATE`);
    } finally { await db.query("ROLLBACK TO SAVEPOINT pinned_index"); }
  }
  for (const old of before.relations) if (!replacedUniqueIndexes.has(old.oid) && !droppedIndexes.has(old.oid) && JSON.stringify(currentRelations.get(old.oid)) !== JSON.stringify(old)) fail(`existing relation ${old.name} changed its owner, ACL, row security, options or column ACLs`);
  const clientReferences = new Set((await db.query(`SELECT DISTINCT conrelid::int AS oid FROM pg_constraint
    WHERE contype='f' AND confrelid=to_regclass('public.clients')`)).rows.map(row => Number(row.oid)));
  const censusSeen = new Set<string>();
  for (const row of after.relations) if (!oldRelations.has(row.oid)) {
    if (row.owner !== migrationRole) fail(`new relation ${row.name} is owned by ${row.owner}, not the migration role`);
    // The absorber joins the raw relname, never regclass's quoted display text.
    const censusIdentity = row.schema === "public" ? `public.${row.relation}` : undefined;
    const classification = clientReferences.has(row.oid)
      ? (await db.query("SELECT disposition FROM public.client_absorption_policy WHERE table_name=$1", [row.relation])).rows : [];
    if (clientReferences.has(row.oid) && classification.length === 0) fail(`new relation ${row.name} has no absorption classification`);
    if (censusIdentity && slot.absorptionCensusTables?.includes(censusIdentity)) {
      const role = (await db.query("SELECT oid::int AS oid FROM pg_roles WHERE rolname='service_role'")).rows[0]?.oid as number | undefined;
      const policies = after.guards.policies!.filter(policy => Number(policy.polrelid) === row.oid);
      const expressions = (await db.query("SELECT pg_get_expr(polqual,polrelid) AS qual, pg_get_expr(polwithcheck,polrelid) AS check_expr FROM pg_policy WHERE polrelid=$1::oid", [row.oid])).rows;
      const columns = (await db.query(`SELECT a.attname AS column, x.grantee::regrole::text AS role, x.privilege_type AS privilege, x.is_grantable AS grantable
        FROM pg_attribute a, LATERAL aclexplode(a.attacl) x WHERE a.attrelid=$1::oid ORDER BY 1,2,3`, [row.oid])).rows;
      const reference = (await db.query(`SELECT 1 FROM pg_constraint f JOIN pg_attribute a ON a.attrelid=f.conrelid AND f.conkey=ARRAY[a.attnum]
        JOIN pg_attribute target ON target.attrelid=f.confrelid AND f.confkey=ARRAY[target.attnum]
        WHERE f.contype='f' AND f.conrelid=$1::oid AND f.confrelid='public.clients'::regclass AND a.attname='client_id' AND target.attname='id'`, [row.oid])).rows;
      if (row.kind !== "r" || !row.rls || row.forceRls || row.acl.some(item => !item.startsWith(`${row.owner}:`)) || reference.length !== 1
        || JSON.stringify(columns) !== JSON.stringify(role ? [{ column: "client_id", role: "service_role", privilege: "SELECT", grantable: false }] : [])
        || JSON.stringify(classification) !== JSON.stringify([{ disposition: "block" }]) || policies.length !== (role ? 1 : 0)
        || (role && (policies[0]!.polname !== `${row.relation}_absorption_census` || policies[0]!.polcmd !== "r"
          || policies[0]!.polpermissive !== true || JSON.stringify(policies[0]!.polroles) !== JSON.stringify([String(role)])
          || expressions[0]?.qual !== "true" || expressions[0]?.check_expr !== null))) fail(`new relation ${row.name} exceeds its absorption census shape`);
      censusSeen.add(censusIdentity); continue;
    }
    if (row.name === "public.subscription_notice_refusals" && JSON.stringify(slot.insertSelectTables) === JSON.stringify([row.name])) {
      const role = (await db.query("SELECT oid::int AS oid FROM pg_roles WHERE rolname='service_role'")).rows[0]?.oid as number | undefined;
      const acl = row.acl.filter(item => !item.startsWith(`${row.owner}:`));
      const policies = after.guards.policies!.filter(policy => Number(policy.polrelid) === row.oid);
      const expressions = (await db.query("SELECT pg_get_expr(polqual,polrelid) AS qual, pg_get_expr(polwithcheck,polrelid) AS check_expr FROM pg_policy WHERE polrelid=$1::oid", [row.oid])).rows;
      if (row.kind !== "r" || !row.rls || row.forceRls || JSON.stringify(acl) !== JSON.stringify(role ? ["service_role:INSERT", "service_role:SELECT"] : [])
        || policies.length !== (role ? 1 : 0) || (role && (policies[0]!.polname !== "subscription_notice_refusals_runtime" || policies[0]!.polcmd !== "*" || policies[0]!.polpermissive !== true
          || JSON.stringify(policies[0]!.polroles) !== JSON.stringify([String(role)]) || expressions[0]?.qual !== "true" || expressions[0]?.check_expr !== "true"))) fail(`new relation ${row.name} exceeds its pinned INSERT/SELECT shape`);
    } else for (const item of row.acl) if (!item.startsWith(`${row.owner}:`)) fail(`new relation ${row.name} grants ${item}`);
    if (row.columnAcls !== null) fail(`new relation ${row.name} has column privileges ${JSON.stringify(row.columnAcls)}`);
  }
  if (slot.absorptionCensusTables?.some(table => !censusSeen.has(table))) fail("absorption census requires a new relation in this slot");

  const newViews = after.relations.filter(row => !oldRelations.has(row.oid) && row.kind === "v").map(row => row.name).sort();
  if (JSON.stringify(newViews) !== JSON.stringify((slot.createdViews ?? []).map(view => view.name).sort())) fail("created views differ from the slot list");

  // New entries compare the installed definitions, independently of historical SQL text.
  const constraintKey = (row: { rel: string; name: string }) => `${row.rel}.${row.name}`;
  const nowConstraints = new Map(after.constraints.map(row => [constraintKey(row), row.def]));
  const checks = slot.checkSupersets ?? [], uniques = slot.uniqueSupersets ?? [];
  const sorted = (values: string[]) => JSON.stringify([...new Set(values)].sort());
  for (const entry of checks) {
    const old = before.constraints.find(old => old.rel === entry.table && old.name === entry.constraint);
    const current = after.constraints.find(row => row.rel === entry.table && row.name === entry.constraint);
    if (old && current && old.validated !== current.validated) fail(`CHECK changed its validation state: ${entry.table}.${entry.constraint}`);
    const values = (row: Snapshot["constraints"][number] | undefined) => row ? checkValues(row.validated ? row.def : row.def.replace(/ NOT VALID$/u, ""), entry.column) : null;
    const oldValues = values(old), newValues = values(current);
    if (!oldValues || !newValues || oldValues.some(value => !newValues.includes(value)) || sorted(entry.values) !== sorted(newValues)) fail(`CHECK changed beyond its listed widening: ${current?.def}`);
  }
  for (const entry of uniques) {
    const old = before.constraints.find(old => old.rel === entry.table && old.name === entry.constraint);
    const oldDef = old ? uniqueDefinition(old.def) : null;
    const def = nowConstraints.get(`${entry.table}.${entry.constraint}`), newDef = def ? uniqueDefinition(def) : null;
    if (!oldDef || !newDef || oldDef.columns.some(column => !entry.columns.includes(column)) || (oldDef.nullsNotDistinct && !entry.nullsNotDistinct) || JSON.stringify(newDef) !== JSON.stringify({ columns: entry.columns, nullsNotDistinct: entry.nullsNotDistinct })) fail(`UNIQUE changed beyond its listed superset: ${def}`);
  }
  const protectedTables = new Set([...checks, ...uniques].map(entry => entry.table));
  for (const old of before.columns.filter(column => protectedTables.has(column.rel))) {
    const now = after.columns.find(column => column.rel === old.rel && column.name === old.name);
    // DROP NOT NULL is the existing-table weakening; all other stored column facts stay fixed.
    const expected = now?.attrs.attnotnull === false && old.attrs.attnotnull === true ? { ...old, attrs: { ...old.attrs, attnotnull: false } } : old;
    if (JSON.stringify(now) !== JSON.stringify(expected)) fail(`column ${old.rel}.${old.name} changed outside its constraint replacement`);
  }
  for (const old of before.constraints) {
    if (checks.some(entry => entry.table === old.rel && entry.constraint === old.name) || uniques.some(entry => entry.table === old.rel && entry.constraint === old.name)) continue;
    const def = nowConstraints.get(constraintKey(old));
    if (constraintKey(old) === PURPOSE_CONSTRAINT && def !== undefined && def !== old.def) {
      const oldValues = purposeValues(old.def), newValues = purposeValues(def);
      const sorted = (values: string[]) => JSON.stringify([...new Set(values)].sort());
      if (!slot.purposeCheck || !oldValues || !newValues || sorted(slot.purposeCheck.values) !== sorted(oldValues) || oldValues.some(value => !newValues.includes(value))) fail(`purpose CHECK changed beyond a widening of its listed values: ${def}`);
    } else if (def !== old.def) fail(`constraint ${constraintKey(old)} was dropped or rewritten`);
  }

  // Only declared fresh-column FK actions may extend an existing table. Read the
  // actual target, key, action and validation state from PostgreSQL, not SQL history.
  const foreignKeys = nativeStoreAddedForeignKeys(slot.existingTableStatements ?? []);
  const installedKeys = (await db.query(`SELECT c.conrelid::int AS relation, c.conname AS name,
    c.confrelid::int AS target, c.confdeltype::text AS deletion, c.confupdtype::text AS update,
    c.confmatchtype::text AS match, c.convalidated AS validated, c.condeferrable AS deferrable,
    c.condeferred AS deferred, c.conkey::int[] AS columns, c.confkey::int[] AS keys
    FROM pg_constraint c WHERE c.contype='f'`)).rows;
  const freshKeys = installedKeys.filter(key => oldRelations.has(key.relation) && !before.constraints.some(old => old.rel === oldRelations.get(key.relation)!.name && old.name === key.name) && ["c", "n"].includes(key.deletion));
  if (freshKeys.length !== foreignKeys.length) fail("FK delete actions differ from the slot's existing-table list");
  for (const key of foreignKeys) {
    const table = before.relations.find(row => row.name === key.table && row.kind === "r");
    const installed = freshKeys.find(row => row.relation === table?.oid && row.name === key.name);
    const column = after.columns.find(row => row.rel === key.table && row.name === key.column);
    const target = after.relations.find(row => row.name === key.reference && row.kind === "r");
    const targetKey = after.columns.find(row => row.rel === key.reference && row.name === key.key);
    if (!table || !column || before.columns.some(row => row.rel === key.table && row.name === key.column)) fail("FK delete action requires a fresh column on an existing table");
    if (!installed || !target || !targetKey || installed.target !== target.oid || installed.deletion !== key.deletion || installed.validated !== key.validated
      || installed.update !== "a" || installed.match !== "s" || installed.deferrable || installed.deferred
      || JSON.stringify(installed.columns) !== JSON.stringify([column!.attrs.attnum]) || JSON.stringify(installed.keys) !== JSON.stringify([targetKey!.attrs.attnum])) fail("FK target, key, delete action or validation state differs from its entry");
    for (const old of before.columns.filter(row => row.rel === key.table)) if (JSON.stringify(after.columns.find(row => row.rel === old.rel && row.name === old.name)) !== JSON.stringify(old)) fail(`FK table column ${old.rel}.${old.name} changed`);
  }

  const admittedTriggers = new Set<string>();
  for (const entry of slot.createdTriggers ?? []) {
    const statement = triggerStatements.get(entry.sha256), expected = statement ? nativeStoreTriggerDefinition(statement) : null;
    if (!expected || expected.name !== entry.name || expected.table !== entry.table) fail("created trigger source differs from its listed hash and identity");
    if (before.guards.triggers!.some(row => row.tgname === entry.name)) fail("created trigger name existed in the prefix");
    const prefixTable = before.relations.find(row => row.name === entry.table && row.kind === "r");
    const statements = prefixTable ? [] : sqlStatements(forward, false, false, true);
    const triggerPosition = statements.findIndex(statement => sqlSha256(statement) === entry.sha256);
    const createdPosition = statements.findIndex(statement => nativeStoreCreatedTable(statement) === entry.table);
    const table = prefixTable ?? after.relations.find(row => row.name === entry.table && row.kind === "r" && !before.relationOids.includes(row.oid)
      && row.owner === migrationRole && createdPosition >= 0 && createdPosition < triggerPosition);
    const fn = slot.createdFunctions.find(fn => fn.signature === expected!.signature);
    if (!table || !fn || !fn.searchPath) fail("created trigger requires a prefix or earlier same-slot owned table and same-slot created function");
    const functionOid = await resolve(expected!.signature), functionRow = added.find(row => row.oid === functionOid);
    const attrs = (await db.query("SELECT prorettype = 'pg_catalog.trigger'::regtype AS returns_trigger, prosecdef FROM pg_proc WHERE oid=$1::oid", [functionOid])).rows[0];
    if (!functionRow || !attrs?.returns_trigger || attrs.prosecdef || functionRow.acl.some(item => !item.startsWith(`${migrationRole}:`))) fail("created trigger function must be an owner-only invoker returning trigger");
    const rows = after.guards.triggers!.filter(row => row.tgname === entry.name && Number(row.tgrelid) === table!.oid);
    const row = rows[0];
    if (rows.length !== 1 || row!.tgenabled !== "O" || row!.tgisinternal !== false || Number(row!.tgfoid) !== functionOid || Number(row!.tgconstraint) !== 0 || Number(row!.tgnargs) !== 0) fail("created trigger binding or enabled state differs from its entry");
    const definition = String((await db.query("SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgname=$1 AND tgrelid=$2::oid", [entry.name, table!.oid])).rows[0].definition);
    const actual = nativeStoreTriggerDefinition(`${definition};`);
    const eventKey = (events: NonNullable<typeof actual>["events"]) => JSON.stringify(events.map(event => ({ ...event, columns: [...event.columns].sort() })).sort((a, b) => a.event.localeCompare(b.event)));
    if (!actual || actual.name !== expected!.name || actual.table !== expected!.table || actual.signature !== expected!.signature || actual.timing !== expected!.timing || eventKey(actual.events) !== eventKey(expected!.events)) fail("created trigger events or row shape differ from its entry");
    admittedTriggers.add(JSON.stringify(row));
  }

  for (const row of after.guards.triggers!) if (row.tgisinternal === false && !before.relationOids.includes(Number(row.tgrelid)) && !admittedTriggers.has(JSON.stringify(row))) fail("unlisted trigger on a new relation");

  // 6. Guard catalogs: every row that existed stays as it was, and nothing attaches behaviour (a trigger, a policy, a
  // rewrite rule, a view's own included) to an existing relation. A new row is a change unless the guard admits it.
  const existing = new Set(before.relationOids), knownConstraints = new Set(before.constraintOids);
  const newConstraints = new Set(after.constraintOids.filter(oid => !knownConstraints.has(oid)));
  for (const guard of GUARDS) {
    const rows = (snap: Snapshot) => snap.guards[guard.id]!.filter(row => !guard.relation || existing.has(Number(row[guard.relation])));
    const was = new Set(rows(before).map(row => JSON.stringify(row))), now = rows(after);
    const kept = new Set(now.map(row => JSON.stringify(row)));
    if ([...was].some(row => !kept.has(row)) || now.some(row => !was.has(JSON.stringify(row)) && !guard.added?.(row, newConstraints) && !(guard.id === "triggers" && admittedTriggers.has(JSON.stringify(row))))) fail(`${guard.id} ${guard.relation ? "on existing relations " : ""}changed`);
  }
}

// Names in the catalog reads and the signature lookup resolve through the catalog first, so neither the forward's own
// search_path nor a temporary object named like a catalog can capture them.
async function pinned<T>(db: PoolClient, run: () => Promise<T>): Promise<T> {
  await db.query("SET search_path = pg_catalog, pg_temp");
  try { return await run(); } finally { await db.query("RESET search_path").catch(() => undefined); }
}

// Run a forward in a transaction on a real database and check it against the slot. It is rolled
// back, except that `keep` commits a forward that passed so the next slot sees the cumulative chain.
async function checkForward(pool: Pool, slot: CatalogSlot, forward: string, keep = false, setup = "") {
  const db = await pool.connect();
  let passed = false;
  try {
    const migrationRole = String((await db.query("SELECT current_user::text::regrole::text AS role")).rows[0].role);
    await db.query("BEGIN");
    try {
      if (setup) await db.query(setup);
      const before = await pinned(db, () => snapshot(db));
      await db.query(forward);
      await pinned(db, async () => assertSlotCatalog(db, slot, before, await snapshot(db), migrationRole, forward));
      passed = true;
    } finally { await db.query(keep && passed ? "COMMIT" : "ROLLBACK"); }
  } finally { db.release(); }
}

// ---- Synthetic cases: the comparator itself, on real PostgreSQL ---------------------------------
const SYNTHETIC_BASE = `
CREATE TABLE public.clients (id uuid PRIMARY KEY);
CREATE TABLE public.client_absorption_policy (table_name text PRIMARY KEY, disposition text NOT NULL, note text);
CREATE TABLE public.cat_existing_table (id int PRIMARY KEY, owner_ref uuid NOT NULL);
CREATE TABLE public.cat_parameters (id uuid, extra uuid, owner_ref uuid, status text, kind text, CONSTRAINT cat_status CHECK (status IN ('open','closed')), CONSTRAINT cat_kind CHECK (kind IN ('first','second')), CONSTRAINT cat_key UNIQUE (id));
CREATE TABLE public.communication_native_sync_state (purpose text NOT NULL CONSTRAINT communication_native_sync_state_purpose_check CHECK (purpose IN ('a','b')));
CREATE FUNCTION public.cat_replaced(p text, q boolean DEFAULT false) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT 'before' $$;
REVOKE ALL ON FUNCTION public.cat_replaced(text,boolean) FROM PUBLIC;
CREATE FUNCTION public.cat_grant_only(p text) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT 'x' $$;
REVOKE ALL ON FUNCTION public.cat_grant_only(text) FROM PUBLIC;
CREATE FUNCTION public.cat_trigger_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER cat_base_trigger BEFORE INSERT ON public.cat_existing_table FOR EACH ROW EXECUTE FUNCTION public.cat_trigger_fn();
CREATE VIEW public.cat_view AS SELECT id FROM public.cat_existing_table;
CREATE TABLE public.cat_child (parent_id int REFERENCES public.cat_existing_table(id));
CREATE UNIQUE INDEX cat_active_idx ON public.cat_parameters (id) WHERE id IS NOT NULL;
CREATE INDEX cat_other_idx ON public.cat_parameters (extra);`;
// A default argument stores parser locations, which move when the replacement sits at another file offset.
const SYNTHETIC_SLOT: CatalogSlot = {
  replacedFunctions: [{ signature: "public.cat_replaced(text,boolean)", beforeSha256: null, searchPath: "pg_catalog, pg_temp" }],
  createdFunctions: [{ signature: "public.cat_created(text)", searchPath: "pg_catalog, pg_temp" }],
  grantOnlyFunctions: [{ signature: "public.cat_grant_only(text)", grantTo: ["service_role"], revokeFrom: ["anon", "authenticated"] }],
};
// The slot lists the purposes the CHECK holds before the forward, as the registry does.
const PURPOSE_SLOT: CatalogSlot = { ...SYNTHETIC_SLOT, purposeCheck: { beforeSha256: sqlSha256(sqlStatements(SYNTHETIC_BASE).find(statement => statement.startsWith("CREATE TABLE public.communication_native_sync_state"))!), values: ["a", "b"] } };
const purposeCheck = (definition: string) => `ALTER TABLE public.communication_native_sync_state DROP CONSTRAINT communication_native_sync_state_purpose_check;
ALTER TABLE public.communication_native_sync_state ADD CONSTRAINT communication_native_sync_state_purpose_check ${definition};`;
// An invoker function pins no search_path, so the slot lists none and the catalog must show none.
const INVOKER_SLOT: CatalogSlot = { ...SYNTHETIC_SLOT, createdFunctions: [{ signature: "public.cat_created(text)", searchPath: null }] };
const invoker = (attributes: string) => `CREATE FUNCTION public.cat_created(p text) RETURNS text LANGUAGE sql${attributes} AS $$ SELECT p $$;\nREVOKE ALL ON FUNCTION public.cat_created(text) FROM PUBLIC;`;
const guarded = (role: string, privilege: string, target: string) => `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN EXECUTE '${privilege} ${target}'; END IF; END; $$;`;
const REPLACE_PART = "-- the replacement sits later in the file than the original\nCREATE OR REPLACE FUNCTION public.cat_replaced(p text, q boolean DEFAULT false) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT 'after' $$;";
const GRANT_PART = guarded("service_role", "GRANT EXECUTE ON FUNCTION", "public.cat_grant_only(text) TO service_role;");
const TABLE_PART = `CREATE TABLE public.cat_created_table (id int);
REVOKE ALL ON TABLE public.cat_created_table FROM PUBLIC;
ALTER TABLE public.cat_created_table ENABLE ROW LEVEL SECURITY;`;
// The shapes of a row that changes an existing table: a dropped NOT NULL, an added column and constraint.
const EXISTING_PART = `ALTER TABLE public.cat_existing_table ALTER COLUMN owner_ref DROP NOT NULL, ADD COLUMN purchase_ref uuid;
ALTER TABLE public.cat_existing_table ADD CONSTRAINT cat_owner_check CHECK ((owner_ref IS NULL) = (purchase_ref IS NOT NULL)) NOT VALID;
ALTER TABLE public.cat_existing_table VALIDATE CONSTRAINT cat_owner_check;`;
const CREATE_PINNED = "CREATE FUNCTION public.cat_created(p text) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT p $$;";
const REVOKE_CREATED = "REVOKE ALL ON FUNCTION public.cat_created(text) FROM PUBLIC;";
const CREATED_OK = `${CREATE_PINNED}\n${REVOKE_CREATED}\n${guarded("service_role", "GRANT EXECUTE ON FUNCTION", "public.cat_created(text) TO service_role;")}`;
const forward = (created: string, extra = "") => [REPLACE_PART, created, GRANT_PART, TABLE_PART, EXISTING_PART, extra].filter(Boolean).join("\n");
const CONFORMING = forward(CREATED_OK);
const TRIGGER_FUNCTION = "CREATE FUNCTION public.cat_created_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN NEW; END; $$;";
const TRIGGER_REVOKE = "REVOKE ALL ON FUNCTION public.cat_created_guard() FROM PUBLIC;";
const TRIGGER_BEFORE = "CREATE TRIGGER cat_created_guard BEFORE INSERT OR DELETE OR UPDATE OF owner_ref, id ON public.cat_existing_table FOR EACH ROW EXECUTE FUNCTION public.cat_created_guard();";
const TRIGGER_AFTER = "CREATE TRIGGER cat_created_event AFTER INSERT ON public.cat_parameters FOR EACH ROW EXECUTE FUNCTION public.cat_created_guard();";
const TRIGGER_SLOT: CatalogSlot = { ...SYNTHETIC_SLOT,
  createdFunctions: [...SYNTHETIC_SLOT.createdFunctions, { signature: "public.cat_created_guard()", searchPath: "pg_catalog, pg_temp" }],
  createdTriggers: [{ name: "cat_created_guard", table: "public.cat_existing_table", sha256: sqlSha256(TRIGGER_BEFORE) }, { name: "cat_created_event", table: "public.cat_parameters", sha256: sqlSha256(TRIGGER_AFTER) }],
};
const TRIGGER_SQL = `${TRIGGER_FUNCTION}\n${TRIGGER_REVOKE}\n${TRIGGER_BEFORE}\n${TRIGGER_AFTER}`;

const NOTICE_SLOT: CatalogSlot = { ...SYNTHETIC_SLOT, insertSelectTables: ["public.subscription_notice_refusals"] };
const NOTICE_TABLE = "CREATE TABLE public.subscription_notice_refusals (id int); ALTER TABLE public.subscription_notice_refusals ENABLE ROW LEVEL SECURITY; REVOKE ALL ON TABLE public.subscription_notice_refusals FROM PUBLIC;";
const NOTICE_GRANT = guarded("service_role", "GRANT SELECT, INSERT ON", "public.subscription_notice_refusals TO service_role;");
const NOTICE_POLICY = guarded("service_role", "CREATE POLICY subscription_notice_refusals_runtime ON", "public.subscription_notice_refusals FOR ALL TO service_role USING (true) WITH CHECK (true);");
const NOTICE_SQL = [NOTICE_TABLE, NOTICE_GRANT, NOTICE_POLICY].join("\n");
const CENSUS_SLOT: CatalogSlot = { ...SYNTHETIC_SLOT, absorptionCensusTables: ["public.cat_census"] };
const CENSUS_CLASSIFICATION = "INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('cat_census', 'block', 'Subject history prevents absorption.');";
const CENSUS_SQL = `CREATE TABLE public.cat_census (id uuid PRIMARY KEY, client_id uuid REFERENCES public.clients(id), payload jsonb);
ALTER TABLE public.cat_census ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cat_census FROM PUBLIC;
${CENSUS_CLASSIFICATION}
${guarded("service_role", "GRANT SELECT (client_id) ON TABLE", "public.cat_census TO service_role;")}
${guarded("service_role", "CREATE POLICY cat_census_absorption_census ON", "public.cat_census FOR SELECT TO service_role USING (true);")}`;
const CLIENT_TABLE = `CREATE TABLE public.cat_client_history (id uuid PRIMARY KEY, subject_id uuid REFERENCES public.clients(id));
ALTER TABLE public.cat_client_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cat_client_history FROM PUBLIC;`;
const classifiedClientTable = (disposition: string) => `${CLIENT_TABLE}
INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('cat_client_history', '${disposition}', 'Subject history has an explicit disposition.');`;
const classifiedQuotedClientTable = (disposition: string, key = "CensusHistory") => `${CLIENT_TABLE.replaceAll("public.cat_client_history", 'public."CensusHistory"')}
INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('${key}', '${disposition}', 'Subject history has an explicit disposition.');`;
// The statement reported as FC-R1B-001, unchanged: a quoted default hides an `AS $q$` so a static
// header reader takes a fake search_path attribute list for the real one.
const HIDDEN_HEADER = "CREATE FUNCTION public.cat_created(p text DEFAULT ' SET search_path = pg_catalog, pg_temp AS $q$') RETURNS text LANGUAGE sql SECURITY DEFINER AS 'select p' SET application_name = x$q$;";
// The statement reported as FC-R5B-001, unchanged and run here without the static class: a backslash ends a standard literal
// early in PostgreSQL, so after the listed function the database also creates an operator for (oid, integer) in pg_catalog
// and a second definer. Read with a bare integer floor, the operator hid that definer from this comparison.
const OPERATOR_CAPTURE = String.raw`CREATE FUNCTION public.cat_created(p text DEFAULT ' SET search_path = pg_catalog, pg_temp AS $q$') RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS 'select 1 --\';
CREATE FUNCTION pg_catalog.cat_ge(oid, integer) RETURNS boolean LANGUAGE sql STABLE AS $b$ SELECT $1::bigint >= $2 AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid = $1 AND proname IN ($n$cat_ge$n$, $n$cat_evil$n$)) $b$;
CREATE OPERATOR pg_catalog.>= (LEFTARG = oid, RIGHTARG = integer, FUNCTION = pg_catalog.cat_ge);
CREATE FUNCTION public.cat_evil(c text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $b$ BEGIN EXECUTE c; END $b$;
SELECT ' $a$ ';
SELECT 1 AS x$a$, 2 AS y$q$;
REVOKE ALL ON FUNCTION public.cat_created(text) FROM PUBLIC;`;
const UNLISTED = "CREATE FUNCTION public.cat_unlisted(p text) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT p $$;\nREVOKE ALL ON FUNCTION public.cat_unlisted(text) FROM PUBLIC;";
const REFUSALS: [string, string, RegExp, boolean, CatalogSlot][] = [
  ["a quoted client table with a quoted retain classification key", forward(CREATED_OK, classifiedQuotedClientTable("retain", '"CensusHistory"')), /no absorption classification/u, false, SYNTHETIC_SLOT],
  ["a quoted client table with a quoted block classification key", forward(CREATED_OK, classifiedQuotedClientTable("block", '"CensusHistory"')), /no absorption classification/u, false, SYNTHETIC_SLOT],
  ["an unlisted, unclassified client-referencing table", forward(CREATED_OK, CLIENT_TABLE), /no absorption classification/u, false, SYNTHETIC_SLOT],
  ["a listed census table without its client foreign key", forward(CREATED_OK, CENSUS_SQL.replace(" REFERENCES public.clients(id)", "")), /absorption census shape/u, false, CENSUS_SLOT],
  ["a listed census table referencing another relation", forward(CREATED_OK, CENSUS_SQL.replace("REFERENCES public.clients(id)", "REFERENCES public.cat_parameters(id)")), /absorption census shape/u, false, CENSUS_SLOT],
  ["a retained table with an unlisted column grant", forward(CREATED_OK, classifiedClientTable("retain") + "\nGRANT SELECT (subject_id) ON TABLE public.cat_client_history TO service_role;"), /column privileges/u, true, SYNTHETIC_SLOT],
  ["an unlisted block table with a table grant", forward(CREATED_OK, classifiedClientTable("block") + "\nGRANT SELECT ON TABLE public.cat_client_history TO service_role;"), /new relation .* grants/u, true, SYNTHETIC_SLOT],
  ["a census table with an extra column grant", forward(CREATED_OK, CENSUS_SQL + "\nGRANT SELECT (payload) ON TABLE public.cat_census TO service_role;"), /absorption census shape/u, true, CENSUS_SLOT],
  ["a census table with a table grant", forward(CREATED_OK, CENSUS_SQL + "\nGRANT SELECT ON TABLE public.cat_census TO service_role;"), /absorption census shape/u, true, CENSUS_SLOT],
  ["a census table with a second policy", forward(CREATED_OK, CENSUS_SQL + "\nCREATE POLICY census_extra ON public.cat_census FOR SELECT TO service_role USING (true);"), /absorption census shape/u, true, CENSUS_SLOT],
  ["a census table without block classification", forward(CREATED_OK, CENSUS_SQL.replace(CENSUS_CLASSIFICATION, "")), /no absorption classification/u, false, CENSUS_SLOT],
  ["a census table with retain classification", forward(CREATED_OK, CENSUS_SQL.replace("'block'", "'retain'")), /absorption census shape/u, false, CENSUS_SLOT],
  ["another new relation with the named table's runtime ACL", forward(CREATED_OK, guarded("service_role", "GRANT SELECT, INSERT ON", "public.cat_created_table TO service_role;")), /new relation public\.cat_created_table grants service_role:/u, true, NOTICE_SLOT],
  ["the named runtime table without RLS", forward(CREATED_OK, NOTICE_SQL.replace("ENABLE ROW LEVEL SECURITY", "DISABLE ROW LEVEL SECURITY")), /pinned INSERT\/SELECT shape/u, true, NOTICE_SLOT],
  ["the named runtime table with an extra privilege", forward(CREATED_OK, NOTICE_SQL.replace("GRANT SELECT, INSERT", "GRANT SELECT, INSERT, UPDATE")), /pinned INSERT\/SELECT shape/u, true, NOTICE_SLOT],
  ["the named runtime table with a second policy", forward(CREATED_OK, NOTICE_SQL + "\nCREATE POLICY notice_extra ON public.subscription_notice_refusals TO service_role USING (true);"), /pinned INSERT\/SELECT shape/u, true, NOTICE_SLOT],
  ["the named runtime table with a PUBLIC policy", forward(CREATED_OK, NOTICE_SQL.replace("FOR ALL TO service_role", "FOR ALL TO PUBLIC")), /pinned INSERT\/SELECT shape/u, true, NOTICE_SLOT],
  ["the FC-R1B-001 header under a listed signature", forward(`${HIDDEN_HEADER}\n${REVOKE_CREATED}`), /pinned search_path/u, false, SYNTHETIC_SLOT],
  ["an unlisted function", forward(CREATED_OK, UNLISTED), /created functions differ/u, false, SYNTHETIC_SLOT],
  ["a function created in pg_catalog", forward(CREATED_OK, "CREATE FUNCTION pg_catalog.cat_shadow(p text) RETURNS text LANGUAGE sql AS $$ SELECT p $$;"), /created functions differ/u, false, SYNTHETIC_SLOT],
  ["a definer without the pinned search_path", forward(`${CREATE_PINNED.replace(" SET search_path = pg_catalog, pg_temp", "")}\n${REVOKE_CREATED}`), /pinned search_path/u, false, SYNTHETIC_SLOT],
  ["an invoker function that carries a SET its slot does not pin", forward(invoker(" SET application_name = x")), /slot pins none/u, false, INVOKER_SLOT],
  ["a created function owned by another role", forward(CREATED_OK, "ALTER FUNCTION public.cat_created(text) OWNER TO anon;"), /not the migration role/u, false, SYNTHETIC_SLOT],
  ["retained PUBLIC execute", forward(CREATE_PINNED), /PUBLIC execute/u, false, SYNTHETIC_SLOT],
  ["a grant to PUBLIC on a created function", forward(CREATED_OK, "GRANT EXECUTE ON FUNCTION public.cat_created(text) TO PUBLIC;"), /PUBLIC execute/u, false, SYNTHETIC_SLOT],
  ["a grant option on a created function", forward(CREATED_OK, "GRANT EXECUTE ON FUNCTION public.cat_created(text) TO authenticated WITH GRANT OPTION;"), /pass the privilege on/u, false, SYNTHETIC_SLOT],
  ["a grant option on a grant-only function", forward(CREATED_OK, "GRANT EXECUTE ON FUNCTION public.cat_grant_only(text) TO service_role WITH GRANT OPTION;"), /outside its grant list/u, true, SYNTHETIC_SLOT],
  ["a grant on an existing table", forward(CREATED_OK, "GRANT SELECT ON public.cat_existing_table TO service_role;"), /existing relation/u, true, SYNTHETIC_SLOT],
  ["a grant on a new table", forward(CREATED_OK, "GRANT SELECT ON public.cat_created_table TO authenticated;"), /new relation .* grants/u, false, SYNTHETIC_SLOT],
  ["a column privilege on a new table", forward(CREATED_OK, "GRANT SELECT (id) ON public.cat_created_table TO authenticated;"), /column privileges/u, false, SYNTHETIC_SLOT],
  ["a new table owned by another role", forward(CREATED_OK, "ALTER TABLE public.cat_created_table OWNER TO authenticated;"), /not the migration role/u, false, SYNTHETIC_SLOT],
  ["a grant on a system function", forward(CREATED_OK, "GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO authenticated;"), /system catalog/u, false, SYNTHETIC_SLOT],
  ["a grant on a system table", forward(CREATED_OK, "GRANT SELECT ON pg_catalog.pg_authid TO authenticated;"), /system catalog/u, false, SYNTHETIC_SLOT],
  ["a column privilege on a system table", forward(CREATED_OK, "GRANT SELECT (rolpassword) ON pg_catalog.pg_authid TO authenticated;"), /system catalog/u, false, SYNTHETIC_SLOT],
  ["a role membership",forward(CREATED_OK, "GRANT authenticated TO anon;"), /memberships changed/u, false, SYNTHETIC_SLOT],
  ["a schema privilege", forward(CREATED_OK, "GRANT CREATE ON SCHEMA public TO authenticated;"), /schemas changed/u, false, SYNTHETIC_SLOT],
  ["a database privilege", forward(CREATED_OK, "GRANT CONNECT ON DATABASE synthetic TO anon;"), /databases changed/u, false, SYNTHETIC_SLOT],
  ["a per-database role setting", forward(CREATED_OK, "ALTER ROLE authenticated IN DATABASE synthetic SET search_path = public;"), /dbSettings changed/u, false, SYNTHETIC_SLOT],
  ["a new trigger on an existing table", forward(CREATED_OK, "CREATE TRIGGER cat_trigger BEFORE INSERT ON public.cat_existing_table FOR EACH ROW EXECUTE FUNCTION public.cat_trigger_fn();"), /triggers on existing relations/u, false, SYNTHETIC_SLOT],
  ["a trigger dropped from an existing table", forward(CREATED_OK, "DROP TRIGGER cat_base_trigger ON public.cat_existing_table;"), /triggers on existing relations/u, false, SYNTHETIC_SLOT],
  ["a trigger redefined with other events", forward(CREATED_OK, "CREATE OR REPLACE TRIGGER cat_base_trigger BEFORE INSERT OR UPDATE ON public.cat_existing_table FOR EACH ROW EXECUTE FUNCTION public.cat_trigger_fn();"), /triggers on existing relations/u, false, SYNTHETIC_SLOT],
  ["the internal foreign-key triggers of an existing table disabled", forward(CREATED_OK, "ALTER TABLE public.cat_child DISABLE TRIGGER ALL;"), /triggers on existing relations/u, false, SYNTHETIC_SLOT],
  ["a rule on a view PostgreSQL ships", forward(CREATED_OK, "CREATE OR REPLACE VIEW information_schema.enabled_roles AS SELECT a.rolname::information_schema.sql_identifier AS role_name, a.rolpassword AS leaked FROM pg_catalog.pg_authid a;"), /rules on existing relations/u, false, SYNTHETIC_SLOT],
  ["a constraint PostgreSQL ships dropped", forward(CREATED_OK, "ALTER DOMAIN information_schema.cardinal_number DROP CONSTRAINT cardinal_number_domain_check;"), /dropped or rewritten/u, false, SYNTHETIC_SLOT],
  ["options of an existing index", forward(CREATED_OK, "ALTER INDEX public.cat_existing_table_pkey SET (fillfactor = 70);"), /existing relation/u, false, SYNTHETIC_SLOT],
  ["a temporary view that hides a catalog", forward(CREATED_OK, "CREATE TEMP VIEW pg_proc AS SELECT * FROM pg_catalog.pg_proc WHERE proname <> 'cat_evil';\nCREATE FUNCTION public.cat_evil() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;"), /created functions differ/u, false, SYNTHETIC_SLOT],
  ["an operator that hides what the statement after a backslash creates", OPERATOR_CAPTURE, /created functions differ/u, false, SYNTHETIC_SLOT],
  ["a privilege on a server parameter", forward(CREATED_OK, "GRANT SET ON PARAMETER session_replication_role TO anon;"), /parameterAcls changed/u, false, SYNTHETIC_SLOT],
  ["a policy on an existing table",forward(CREATED_OK, "CREATE POLICY cat_policy ON public.cat_existing_table USING (true);"), /policies on existing relations/u, false, SYNTHETIC_SLOT],
  ["a rewrite rule on an existing table", forward(CREATED_OK, "CREATE RULE cat_rule AS ON INSERT TO public.cat_existing_table DO INSTEAD NOTHING;"), /rules on existing relations/u, false, SYNTHETIC_SLOT],
  ["a redefined view", forward(CREATED_OK, "CREATE OR REPLACE VIEW public.cat_view AS SELECT id, owner_ref FROM public.cat_existing_table;"), /rules on existing relations/u, false, SYNTHETIC_SLOT],
  ["a purpose CHECK that drops a value", forward(CREATED_OK, purposeCheck("CHECK (purpose IN ('b','c'))")), /purpose CHECK/u, false, PURPOSE_SLOT],
  ["a purpose CHECK inverted by NOT IN", forward(CREATED_OK, purposeCheck("CHECK (purpose NOT IN ('a','b'))")), /purpose CHECK/u, false, PURPOSE_SLOT],
  ["a purpose CHECK voided by OR true", forward(CREATED_OK, purposeCheck("CHECK (purpose IN ('a','b','c') OR true)")), /purpose CHECK/u, false, PURPOSE_SLOT],
  ["a purpose CHECK added NOT VALID", forward(CREATED_OK, purposeCheck("CHECK (purpose IN ('a','b','c')) NOT VALID")), /purpose CHECK/u, false, PURPOSE_SLOT],
  ["a purpose CHECK whose slot lists other preimage values", forward(CREATED_OK, purposeCheck("CHECK (purpose IN ('a','b','c'))")), /purpose CHECK/u, false, { ...SYNTHETIC_SLOT, purposeCheck: { beforeSha256: PURPOSE_SLOT.purposeCheck!.beforeSha256, values: ["a"] } }],
  ["a purpose CHECK rewritten by a slot that lists none", forward(CREATED_OK, purposeCheck("CHECK (purpose IN ('a','b','c'))")), /purpose CHECK/u, false, SYNTHETIC_SLOT],
];

// ---- Real forwards: every bound native slot, replayed on the cumulative native chain -----------
const registry = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"));
const manifest: PlatformMigrationManifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
const bound = (registry.nativeStoreForwards ?? []).map(pin => ({ pin, slot: registry.nativeStoreForwardClass!.slots.find(slot => slot.path === pin.path)! }))
  .sort((x, y) => x.pin.path.localeCompare(y.pin.path));
const boundPaths = new Set(bound.map(entry => entry.pin.path));
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
// Manifest units that are not bound forwards (a landed bound forward is also in the manifest).
const chain = [manifest.baseline, ...manifest.forward].filter(unit => !boundPaths.has(unit.file)).map(unit => {
  const bytes = readFileSync(unit.file);
  if (sha(bytes) !== unit.sha256) throw new Error(`native chain unit differs from the manifest: ${unit.file}`);
  return { path: unit.file, sql: bytes.toString("utf8") };
});
const indexStatements = new Map([SYNTHETIC_BASE, ...chain.map(unit => unit.sql), ...bound.map(entry => readFileSync(entry.pin.path, "utf8"))].flatMap(sql => sqlStatements(sql, true, false, true).map(statement => [sqlSha256(statement), statement] as const)));
const triggerStatements = new Map([TRIGGER_SQL, ...bound.filter(entry => entry.slot.createdTriggers?.length).map(entry => readFileSync(entry.pin.path, "utf8"))].flatMap(sql => sqlStatements(sql).map(statement => [sqlSha256(statement), statement] as const)));
const PARAMETER_SLOT: CatalogSlot = { ...SYNTHETIC_SLOT, checkSupersets: [
  { table: "public.cat_parameters", constraint: "cat_status", column: "status", values: ["open", "closed", "paused"] },
  { table: "public.cat_parameters", constraint: "cat_kind", column: "kind", values: ["first", "second", "third"] },
] };
const PARAMETER_CHECKS = "ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_status; ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_status CHECK (status IN ('open','closed','paused')); ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_kind; ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_kind CHECK (kind IN ('first','second','third'));";
const UNVALIDATED_PARAMETER_SETUP = "ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_status; ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_status CHECK (status IN ('open','closed')) NOT VALID;";
const UNVALIDATED_PARAMETER_CHECKS = PARAMETER_CHECKS.replace("('open','closed','paused'));", "('open','closed','paused')) NOT VALID;");
const UNIQUE_SLOT: CatalogSlot = { ...SYNTHETIC_SLOT, uniqueSupersets: [{ table: "public.cat_parameters", constraint: "cat_key", columns: ["id", "extra"], nullsNotDistinct: true }] };
const UNIQUE_SQL = "ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_key; ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_key UNIQUE NULLS NOT DISTINCT (id,extra);";
const DROP_INDEX_SLOT: CatalogSlot = { ...SYNTHETIC_SLOT, droppedIndexes: [{ table: "public.cat_parameters", name: "cat_active_idx", beforeSha256: sqlSha256("CREATE UNIQUE INDEX cat_active_idx ON public.cat_parameters (id) WHERE id IS NOT NULL;") }] };
const DROP_INDEX_SQL = "DROP INDEX public.cat_active_idx; CREATE INDEX cat_replacement_idx ON public.cat_parameters (id, extra DESC);";
const DROP_TWO_INDEXES_SLOT: CatalogSlot = { ...DROP_INDEX_SLOT, droppedIndexes: [...DROP_INDEX_SLOT.droppedIndexes!, { table: "public.cat_parameters", name: "cat_other_idx", beforeSha256: sqlSha256("CREATE INDEX cat_other_idx ON public.cat_parameters (extra);") }] };

// The chain creates anon and authenticated itself; service_role comes from the host bootstrap, so it is
// the one role these two modes toggle for the whole run. With no bound forward this is a plain replay of
// the chain, so the replay is proved before the first feature change relies on it.
async function replayChain(connectionString: string) {
  const outcomes = new Map<string, Error | null>();
  let applied = 0;
  const chainDb = new Pool({ connectionString });
  const steps = [...chain.map(unit => ({ path: unit.path, unit })), ...bound.map(entry => ({ path: entry.pin.path, entry }))].sort((x, y) => x.path.localeCompare(y.path));
  try {
    for (const step of steps) {
      if ("unit" in step) { await chainDb.query(step.unit.sql); applied += 1; continue; }
      const { pin, slot } = step.entry;
      const bytes = readFileSync(pin.path);
      if (sha(bytes) !== pin.sha256) throw new Error(`bound forward differs from its pin: ${pin.path}`);
      outcomes.set(pin.path, await checkForward(chainDb, slot, bytes.toString("utf8"), true).then(() => null, (error: Error) => error));
    }
  } finally { await chainDb.end(); }
  return { outcomes, applied };
}

describe.each([{ serviceRole: true }, { serviceRole: false }])("native store forward catalog, service_role present: $serviceRole", ({ serviceRole }) => {
  let container: PostgresContainer | undefined;
  let pool: Pool;
  let replay = { outcomes: new Map<string, Error | null>(), applied: 0 };
  beforeAll(async () => {
    if (!await dockerAvailable()) throw new Error("The native store catalog proof requires real PostgreSQL");
    container = await runPostgresContainer({ name: `native-catalog-${serviceRole ? "role" : "bare"}-${process.pid}`, password: "synthetic-conformance" });
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Native store catalog PostgreSQL unavailable");
    const admin = new Pool({ connectionString: container.connectionString });
    try {
      if (serviceRole) await admin.query("CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS");
      await admin.query("CREATE DATABASE native_chain");
      await admin.query("CREATE DATABASE synthetic");
      replay = await replayChain(container.connectionStringFor("native_chain"));
      // The closed roles exist after the chain; the synthetic database needs them either way.
      for (const role of ["anon", "authenticated"]) await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END; $$`);
    } finally { await admin.end(); }
    const synthetic = new Pool({ connectionString: container.connectionStringFor("synthetic") });
    await synthetic.query(SYNTHETIC_BASE); await synthetic.end();
    pool = new Pool({ connectionString: container.connectionStringFor("synthetic") });
  }, postgresSetupTimeoutMs);
  afterAll(async () => { await closePostgres(container, pool); }, postgresTeardownTimeoutMs);

  it("replays every unbound native chain unit", () => { expect(replay.applied).toBe(chain.length); });
  it("admits only the client census column and SELECT policy on a new block-classified table", async () => {
    await checkForward(pool, CENSUS_SLOT, forward(CREATED_OK, CENSUS_SQL));
  });
  it.each(["retain", "block"])("admits an unlisted %s client table with owner-only privileges", async disposition => {
    await checkForward(pool, SYNTHETIC_SLOT, forward(CREATED_OK, classifiedClientTable(disposition)));
  });
  it.each(["retain", "block"])("uses raw relname for a quoted client table's %s classification", async disposition => {
    await checkForward(pool, SYNTHETIC_SLOT, forward(CREATED_OK, classifiedQuotedClientTable(disposition)));
  });
  it("installs two replacement slots with pinned bodies and unchanged function attributes and ACL", async () => {
    const db = await pool.connect(), signature = "public.cat_replaced(text,boolean)";
    const definition = (body: string) => `CREATE OR REPLACE FUNCTION public.cat_replaced(p text, q boolean DEFAULT false) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$${body}$$;`;
    const original = sqlStatements(SYNTHETIC_BASE).find(statement => statement.startsWith("CREATE FUNCTION public.cat_replaced("))!;
    let beforeSha256 = sqlSha256(original);
    try {
      await db.query("BEGIN");
      let before = await pinned(db, () => snapshot(db));
      const migrationRole = String((await db.query("SELECT current_user::text AS role")).rows[0].role);
      for (const body of [" SELECT 'first replacement' ", " SELECT 'second replacement' "]) {
        const statement = definition(body), afterSha256 = sqlSha256(statement);
        const slot: CatalogSlot = { createdFunctions: [], replacedFunctions: [{ signature, beforeSha256, searchPath: "pg_catalog, pg_temp" }], grantOnlyFunctions: [] };
        await db.query(statement);
        const after = await pinned(db, () => snapshot(db));
        await pinned(db, async () => assertSlotCatalog(db, slot, before, after, migrationRole));
        const installed = after.functions.find(fn => fn.oid === before.functions.find(fn => fn.name === "public.cat_replaced(text,boolean)")!.oid)!;
        expect(installed.src).toBe(body);
        // afterSha256 binds a split statement; combine its fixed header with PostgreSQL's exact installed body.
        expect(sqlSha256(definition(installed.src))).toBe(afterSha256);
        before = after; beforeSha256 = afterSha256;
      }
    } finally { await db.query("ROLLBACK"); db.release(); }
  });
  it.each(["header", "ACL"])("refuses a second replacement that changes its %s", async change => {
    const statement = REPLACE_PART.replace("'after'", "'second replacement'");
    const sql = change === "header" ? statement.replace("LANGUAGE sql", "LANGUAGE sql STABLE") : `${statement} GRANT EXECUTE ON FUNCTION public.cat_replaced(text,boolean) TO authenticated;`;
    const slot: CatalogSlot = { createdFunctions: [], replacedFunctions: SYNTHETIC_SLOT.replacedFunctions, grantOnlyFunctions: [] };
    await expect(checkForward(pool, slot, sql, false, REPLACE_PART)).rejects.toThrow(/changed attributes or ACL/u);
  });
  it("drops a listed standalone index, preserving its table, constraints, other indexes and ACL", async () => {
    await checkForward(pool, DROP_INDEX_SLOT, forward(CREATED_OK, DROP_INDEX_SQL));
  });
  it("drops two listed standalone indexes of one table", async () => {
    await checkForward(pool, DROP_TWO_INDEXES_SLOT, forward(CREATED_OK, `${DROP_INDEX_SQL} DROP INDEX public.cat_other_idx;`));
  });
  it("refuses a listed index that history rebuilt without naming it", async () => {
    const rebuilt = "DO $$ BEGIN EXECUTE 'DROP INDEX public.cat_' || 'active_idx'; EXECUTE 'CREATE UNIQUE INDEX cat_' || 'active_idx ON public.cat_parameters (extra)'; END $$;";
    await expect(checkForward(pool, DROP_INDEX_SLOT, forward(CREATED_OK, DROP_INDEX_SQL), false, rebuilt)).rejects.toThrow(/differs from its pinned CREATE/u);
  });
  it.each([
    ["missing drop", "", /must be a removed standalone index/u],
    ["recreated listed name", `${DROP_INDEX_SQL} CREATE INDEX cat_active_idx ON public.cat_parameters (id);`, /must be a removed standalone index/u],
    ["renamed instead of dropped", "ALTER INDEX public.cat_active_idx RENAME TO cat_renamed_idx;", /must be a removed standalone index/u],
    ["added column", `${DROP_INDEX_SQL} ALTER TABLE public.cat_parameters ADD COLUMN unexpected text;`, /changed columns/u],
    ["column default", `${DROP_INDEX_SQL} ALTER TABLE public.cat_parameters ALTER COLUMN status SET DEFAULT 'open';`, /changed columns/u],
    ["dropped constraint", `${DROP_INDEX_SQL} ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_status;`, /changed constraints/u],
    ["added constraint", `${DROP_INDEX_SQL} ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_unlisted CHECK (kind IS NOT NULL);`, /changed constraints/u],
    ["other index dropped", `${DROP_INDEX_SQL} DROP INDEX public.cat_other_idx;`, /other index .* changed/u],
    ["other index altered", `${DROP_INDEX_SQL} ALTER INDEX public.cat_other_idx SET (fillfactor=80);`, /other index .* changed/u],
    ["table ACL", `${DROP_INDEX_SQL} GRANT SELECT ON public.cat_parameters TO authenticated;`, /existing relation .* changed/u],
  ] as const)("refuses a listed index drop with %s", async (_label, sql, error) => {
    await expect(checkForward(pool, DROP_INDEX_SLOT, forward(CREATED_OK, sql))).rejects.toThrow(error);
  });
  it.each(["missing index", "different table", "unlisted"])("refuses a catalog drop with %s inventory", async attack => {
    const slot = structuredClone(DROP_INDEX_SLOT);
    if (attack === "missing index") slot.droppedIndexes![0]!.name = "cat_missing_idx";
    if (attack === "different table") slot.droppedIndexes![0]!.table = "public.cat_existing_table";
    if (attack === "unlisted") delete slot.droppedIndexes;
    await expect(checkForward(pool, slot, forward(CREATED_OK, DROP_INDEX_SQL))).rejects.toThrow(/must be a removed standalone index|existing relation .* changed/u);
  });
  it.each([
    ["cat_existing_table", "cat_existing_table_pkey", ""],
    ["cat_parameters", "cat_key", ""],
    ["cat_exclusion", "cat_exclusion_key", "CREATE TABLE public.cat_exclusion (span int4range, CONSTRAINT cat_exclusion_key EXCLUDE USING gist (span WITH &&));"],
    ["cat_parameters", "cat_adopted_idx", "CREATE UNIQUE INDEX cat_adopted_idx ON public.cat_parameters (status); ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_adopted_idx UNIQUE USING INDEX cat_adopted_idx;"],
  ] as const)("refuses a constraint-backed index (%s %s)", async (table, name, setup) => {
    const slot = { ...SYNTHETIC_SLOT, droppedIndexes: [{ table: `public.${table}`, name, beforeSha256: "0".repeat(64) }] };
    await expect(checkForward(pool, slot, forward(CREATED_OK, `ALTER TABLE public.${table} DROP CONSTRAINT ${name} CASCADE;`), false, setup)).rejects.toThrow(/must be a removed standalone index/u);
  });
  it("admits a conforming forward", async () => { await checkForward(pool, SYNTHETIC_SLOT, CONFORMING); });
  it("admits only the named new table runtime ACL and policy", async () => { await checkForward(pool, NOTICE_SLOT, forward(CREATED_OK, NOTICE_SQL)); });
  it("admits a widened purpose CHECK that its slot lists", async () => { await checkForward(pool, PURPOSE_SLOT, forward(CREATED_OK, purposeCheck("CHECK (purpose IN ('a','b','c'))"))); });
  it("admits multiple named CHECK widenings after unrelated additive DDL", async () => {
    await checkForward(pool, PARAMETER_SLOT, forward(CREATED_OK, PARAMETER_CHECKS), false, "ALTER TABLE public.cat_parameters ADD COLUMN unrelated uuid; ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_unrelated CHECK (unrelated IS NULL) NOT VALID;");
  });
  it("preserves an unvalidated CHECK while widening without rechecking historical rows", async () => {
    const setup = UNVALIDATED_PARAMETER_SETUP.replace("ALTER TABLE public.cat_parameters ADD", "INSERT INTO public.cat_parameters(status) VALUES ('historical'); ALTER TABLE public.cat_parameters ADD");
    await checkForward(pool, PARAMETER_SLOT, forward(CREATED_OK, UNVALIDATED_PARAMETER_CHECKS), false, setup);
  });
  it.each([
    { beforeValidated: false, afterValidated: true },
    { beforeValidated: true, afterValidated: false },
  ])("refuses CHECK validation state $beforeValidated -> $afterValidated", async ({ beforeValidated, afterValidated }) => {
    await expect(checkForward(pool, PARAMETER_SLOT, forward(CREATED_OK, afterValidated ? PARAMETER_CHECKS : UNVALIDATED_PARAMETER_CHECKS), false,
      beforeValidated ? "" : UNVALIDATED_PARAMETER_SETUP)).rejects.toThrow(/CHECK changed its validation state/u);
  });
  it("refuses a narrowed unvalidated CHECK even when its ADD exactly matches its slot", async () => {
    const slot = { ...PARAMETER_SLOT, checkSupersets: [{ ...PARAMETER_SLOT.checkSupersets![0]!, values: ["open", "paused"] }, PARAMETER_SLOT.checkSupersets![1]!] };
    await expect(checkForward(pool, slot, forward(CREATED_OK, UNVALIDATED_PARAMETER_CHECKS.replace("'open','closed','paused'", "'open','paused'")), false,
      UNVALIDATED_PARAMETER_SETUP)).rejects.toThrow(/CHECK changed beyond its listed widening/u);
  });
  it.each(["before", "after"])("refuses a non-list unvalidated CHECK %s the slot", async side => {
    const setup = side === "before" ? UNVALIDATED_PARAMETER_SETUP.replace("status IN ('open','closed')", "status <> 'blocked'") : UNVALIDATED_PARAMETER_SETUP;
    const sql = side === "after" ? UNVALIDATED_PARAMETER_CHECKS.replace("status IN ('open','closed','paused')", "status <> 'blocked'") : UNVALIDATED_PARAMETER_CHECKS;
    await expect(checkForward(pool, PARAMETER_SLOT, forward(CREATED_OK, sql), false, setup)).rejects.toThrow(/CHECK changed beyond its listed widening/u);
  });
  it("refuses a narrowed CHECK even when its ADD exactly matches its slot", async () => {
    const slot = { ...SYNTHETIC_SLOT, checkSupersets: [{ ...PARAMETER_SLOT.checkSupersets![0]!, values: ["open", "paused"] }] };
    const sql = PARAMETER_CHECKS.split(" ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_kind")[0]!.replace("'open','closed','paused'", "'open','paused'");
    await expect(checkForward(pool, slot, forward(CREATED_OK, sql))).rejects.toThrow(/CHECK changed/u);
  });
  it.each(["missing", "non-closed"])("refuses an installed CHECK that is %s before the slot", async shape => {
    const setup = `ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_status; ${shape === "non-closed" ? "ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_status CHECK (status <> 'blocked');" : ""}`;
    const sql = shape === "missing" ? PARAMETER_CHECKS.replace("ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_status; ", "") : PARAMETER_CHECKS;
    await expect(checkForward(pool, PARAMETER_SLOT, forward(CREATED_OK, sql), false, setup)).rejects.toThrow(/CHECK changed/u);
  });
  it("proves a UNIQUE superset and its exact NULLS mode in the installed catalog", async () => {
    await checkForward(pool, UNIQUE_SLOT, forward(CREATED_OK, UNIQUE_SQL));
    await expect(checkForward(pool, UNIQUE_SLOT, forward(CREATED_OK, UNIQUE_SQL.replace(" NULLS NOT DISTINCT", "")))).rejects.toThrow(/UNIQUE changed/u);
  });
  it("refuses a dropped UNIQUE column even when its ADD exactly matches its slot", async () => {
    const slot = { ...UNIQUE_SLOT, uniqueSupersets: [{ ...UNIQUE_SLOT.uniqueSupersets![0]!, columns: ["extra"] }] };
    await expect(checkForward(pool, slot, forward(CREATED_OK, UNIQUE_SQL.replace("(id,extra)", "(extra)")))).rejects.toThrow(/UNIQUE changed/u);
  });
  it.each(["missing", "non-closed"])("refuses an installed UNIQUE that is %s before the slot", async shape => {
    const setup = `ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_key; ${shape === "non-closed" ? "ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_key UNIQUE (id) DEFERRABLE;" : ""}`;
    await expect(checkForward(pool, UNIQUE_SLOT, forward(CREATED_OK, shape === "missing" ? UNIQUE_SQL.replace("ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_key; ", "") : UNIQUE_SQL), false, setup)).rejects.toThrow(/UNIQUE changed/u);
  });
  it("refuses removing NULLS NOT DISTINCT while admitting its addition", async () => {
    const slot = { ...UNIQUE_SLOT, uniqueSupersets: [{ ...UNIQUE_SLOT.uniqueSupersets![0]!, nullsNotDistinct: false }] };
    const setup = "ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_key; ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_key UNIQUE NULLS NOT DISTINCT (id);";
    await expect(checkForward(pool, slot, forward(CREATED_OK, UNIQUE_SQL.replace(" NULLS NOT DISTINCT", "")), false, setup)).rejects.toThrow(/UNIQUE changed/u);
  });
  it("retains the existing DROP NOT NULL weakening beside a UNIQUE replacement", async () => {
    await checkForward(pool, UNIQUE_SLOT, forward(CREATED_OK, `${UNIQUE_SQL} ALTER TABLE public.cat_parameters ALTER COLUMN id DROP NOT NULL;`), false, "ALTER TABLE public.cat_parameters ALTER COLUMN id SET NOT NULL;");
  });
  it.each(["ALTER COLUMN status TYPE varchar", "ALTER COLUMN status SET DEFAULT 'closed'", "DROP COLUMN kind CASCADE"])("preserves other installed column facts during a listed widening: %s", change => {
    return expect(checkForward(pool, UNIQUE_SLOT, forward(CREATED_OK, `${UNIQUE_SQL} ALTER TABLE public.cat_parameters ${change};`))).rejects.toThrow(/column .* changed/u);
  });
  it("preserves other installed constraints during a listed widening", async () => {
    await expect(checkForward(pool, UNIQUE_SLOT, forward(CREATED_OK, `${UNIQUE_SQL} ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_status;`))).rejects.toThrow(/constraint .* dropped or rewritten/u);
  });
  it("admits only a listed fresh view with owner-only privileges", async () => {
    const view = "CREATE VIEW public.cat_created_view AS SELECT id FROM public.cat_existing_table;";
    const slot = { ...SYNTHETIC_SLOT, createdViews: [{ name: "public.cat_created_view", sha256: sqlSha256(view) }] };
    await checkForward(pool, slot, forward(CREATED_OK, `${view} REVOKE ALL ON TABLE public.cat_created_view FROM PUBLIC;`));
    await expect(checkForward(pool, slot, forward(CREATED_OK, `${view} GRANT SELECT ON public.cat_created_view TO authenticated;`))).rejects.toThrow(/new relation .* grants/u);
    await expect(checkForward(pool, SYNTHETIC_SLOT, forward(CREATED_OK, view))).rejects.toThrow(/created views differ/u);
  });
  it("lets plain PostgreSQL DDL refuse duplicate views, duplicate triggers and missing targets", async () => {
    await expect(checkForward(pool, SYNTHETIC_SLOT, forward(CREATED_OK, "CREATE VIEW public.cat_view AS SELECT id FROM public.cat_existing_table;"))).rejects.toThrow('relation "cat_view" already exists');
    await expect(checkForward(pool, SYNTHETIC_SLOT, forward(CREATED_OK, "CREATE TRIGGER cat_base_trigger BEFORE INSERT ON public.cat_existing_table FOR EACH ROW EXECUTE FUNCTION public.cat_trigger_fn();"))).rejects.toThrow('trigger "cat_base_trigger" for relation "cat_existing_table" already exists');
    await expect(checkForward(pool, SYNTHETIC_SLOT, forward(CREATED_OK, "CREATE TRIGGER missing BEFORE INSERT ON public.cat_missing FOR EACH ROW EXECUTE FUNCTION public.cat_trigger_fn();"))).rejects.toThrow('relation "public.cat_missing" does not exist');
    await expect(checkForward(pool, SYNTHETIC_SLOT, forward(CREATED_OK, "ALTER TABLE public.cat_missing ADD COLUMN extra text;"))).rejects.toThrow('relation "public.cat_missing" does not exist');
  });
  it("proves listed enabled row triggers and their owner-only invoker binding on existing tables", async () => {
    await checkForward(pool, TRIGGER_SLOT, forward(CREATED_OK, TRIGGER_SQL));
  });
  it.each([
    ["disabled trigger", `${TRIGGER_SQL} ALTER TABLE public.cat_existing_table DISABLE TRIGGER cat_created_guard;`, /binding or enabled state/u],
    ["changed events", TRIGGER_SQL.replace("BEFORE INSERT OR DELETE OR UPDATE OF owner_ref, id", "AFTER INSERT"), /events or row shape/u],
    ["different table", TRIGGER_SQL.replace("ON public.cat_existing_table FOR EACH", "ON public.cat_parameters FOR EACH"), /binding or enabled state/u],
    ["different function", TRIGGER_SQL.replaceAll("EXECUTE FUNCTION public.cat_created_guard()", "EXECUTE FUNCTION public.cat_trigger_fn()"), /binding or enabled state/u],
    ["function grant", `${TRIGGER_SQL} GRANT EXECUTE ON FUNCTION public.cat_created_guard() TO authenticated;`, /owner-only invoker/u],
    ["definer function", TRIGGER_SQL.replace("SECURITY INVOKER", "SECURITY DEFINER"), /owner-only invoker/u],
    ["WHEN clause", TRIGGER_SQL.replace("FOR EACH ROW EXECUTE FUNCTION", "FOR EACH ROW WHEN (true) EXECUTE FUNCTION"), /events or row shape/u],
  ] as const)("refuses a listed trigger with %s", async (_label, sql, message) => {
    await expect(checkForward(pool, TRIGGER_SLOT, forward(CREATED_OK, sql))).rejects.toThrow(message);
  });
  it("refuses a listed trigger name already present on a different prefix table", async () => {
    const statement = TRIGGER_AFTER.replace("cat_created_event", "cat_base_trigger");
    triggerStatements.set(sqlSha256(statement), statement);
    const slot = { ...TRIGGER_SLOT, createdTriggers: [TRIGGER_SLOT.createdTriggers![0]!, { name: "cat_base_trigger", table: "public.cat_parameters", sha256: sqlSha256(statement) }] };
    await expect(checkForward(pool, slot, forward(CREATED_OK, TRIGGER_SQL.replace(TRIGGER_AFTER, statement)))).rejects.toThrow("catalog: created trigger name existed in the prefix");
  });
  it("preserves an installed compact legacy search_path and refuses a changed path", async () => {
    const setup="CREATE FUNCTION public.cat_compact(p text) RETURNS text LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT p $$; REVOKE ALL ON FUNCTION public.cat_compact(text) FROM PUBLIC;";
    const replacement="CREATE OR REPLACE FUNCTION public.cat_compact(p text) RETURNS text LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $$ SELECT 'after' $$;";
    const slot={...SYNTHETIC_SLOT,replacedFunctions:[...SYNTHETIC_SLOT.replacedFunctions,{signature:"public.cat_compact(text)",beforeSha256:null,searchPath:"pg_catalog"}]};
    await checkForward(pool,slot,forward(CREATED_OK,replacement),false,setup);
    await expect(checkForward(pool,slot,forward(CREATED_OK,replacement.replace("search_path=pg_catalog","search_path=public")),false,setup)).rejects.toThrow(/changed attributes or ACL/u);
  });
  const addedColumn="ALTER TABLE public.cat_parameters ADD COLUMN parent_id int;";
  const addedFk="ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_parent_fk FOREIGN KEY (parent_id) REFERENCES public.cat_existing_table(id) ON DELETE SET NULL NOT VALID;";
  const fkSlot={...SYNTHETIC_SLOT,existingTableStatements:[addedColumn,addedFk]};
  it.each(["CASCADE","SET NULL"])("proves fresh-column %s FK actions and both validation states", async action=>{
    for(const suffix of [""," NOT VALID"]) {
      const statement=addedFk.replace("SET NULL NOT VALID",action+suffix);
      await checkForward(pool,{...SYNTHETIC_SLOT,existingTableStatements:[addedColumn,statement]},forward(CREATED_OK,addedColumn+statement));
    }
  });
  it.each([
    ["a pre-existing column",addedColumn+addedFk,addedColumn,/fresh column/u],
    ["a different action",addedColumn+addedFk.replace("SET NULL","CASCADE"),"",/FK target, key, delete action or validation/u],
    ["a wrong target",addedColumn+addedFk.replace("cat_existing_table(id)","cat_other_parent(id)"),"CREATE TABLE public.cat_other_parent(id int PRIMARY KEY);",/FK target, key, delete action or validation/u],
    ["a wrong referenced key",addedColumn+addedFk.replace("cat_existing_table(id)","cat_existing_table(other_id)"),"ALTER TABLE public.cat_existing_table ADD COLUMN other_id int UNIQUE;",/FK target, key, delete action or validation/u],
    ["a changed validation state",addedColumn+addedFk+"ALTER TABLE public.cat_parameters VALIDATE CONSTRAINT cat_parent_fk;","",/FK target, key, delete action or validation/u],
    ["an unlisted action",addedColumn+addedFk,"",/FK delete actions differ/u],
    ["a changed prior column",addedColumn+addedFk+"ALTER TABLE public.cat_parameters ALTER COLUMN status SET DEFAULT 'closed';","",/FK table column/u],
    ["a dropped FK",addedColumn+addedFk+"ALTER TABLE public.cat_child DROP CONSTRAINT cat_child_parent_id_fkey;","",/dropped or rewritten/u],
    ["a rewritten FK",addedColumn+addedFk+"ALTER TABLE public.cat_child DROP CONSTRAINT cat_child_parent_id_fkey; ALTER TABLE public.cat_child ADD CONSTRAINT cat_child_parent_id_fkey FOREIGN KEY(parent_id) REFERENCES public.cat_existing_table(id) ON DELETE CASCADE;","",/dropped or rewritten/u],
  ] as const)("refuses fresh-column FK drift: %s",async(label,sql,setup,message)=>{
    // The pre-existing-column case installs it before the snapshot, then only adds the FK.
    const actual=label==="a pre-existing column"?addedFk:sql;
    await expect(checkForward(pool,label==="an unlisted action"?SYNTHETIC_SLOT:fkSlot,forward(CREATED_OK,actual),false,setup)).rejects.toThrow(message);
  });
  const freshTrigger=TRIGGER_BEFORE.replace("public.cat_existing_table","public.cat_trigger_table");
  const freshCreate="CREATE TABLE public.cat_trigger_table(id int,owner_ref uuid); REVOKE ALL ON TABLE public.cat_trigger_table FROM PUBLIC;";
  const freshSlot={...SYNTHETIC_SLOT,createdFunctions:[...SYNTHETIC_SLOT.createdFunctions,{signature:"public.cat_created_guard()",searchPath:"pg_catalog, pg_temp"}],createdTriggers:[{name:"cat_created_guard",table:"public.cat_trigger_table",sha256:sqlSha256(freshTrigger)}]};
  triggerStatements.set(sqlSha256(freshTrigger),freshTrigger);
  it("proves a row trigger on a table created earlier in the same slot",async()=>{
    await checkForward(pool,freshSlot,forward(CREATED_OK,freshCreate+TRIGGER_FUNCTION+TRIGGER_REVOKE+freshTrigger));
  });
  it.each([
    ["an unlisted trigger",freshCreate+TRIGGER_FUNCTION+TRIGGER_REVOKE+freshTrigger,/unlisted trigger on a new relation/u],
    ["an unrelated prefix target",freshCreate+TRIGGER_FUNCTION+TRIGGER_REVOKE+TRIGGER_BEFORE,/source differs/u],
    ["an undeclared table creation",`DO $$ BEGIN CREATE TABLE public.cat_trigger_table(id int,owner_ref uuid); END; $$;`+TRIGGER_FUNCTION+TRIGGER_REVOKE+freshTrigger,/earlier same-slot owned table/u],
    ["a DEFINER function",freshCreate+TRIGGER_FUNCTION.replace("SECURITY INVOKER","SECURITY DEFINER")+TRIGGER_REVOKE+freshTrigger,/owner-only invoker/u],
    ["a WHEN clause",freshCreate+TRIGGER_FUNCTION+TRIGGER_REVOKE+freshTrigger.replace("FOR EACH ROW EXECUTE","FOR EACH ROW WHEN (true) EXECUTE"),/source differs/u],
    ["a statement trigger",freshCreate+TRIGGER_FUNCTION+TRIGGER_REVOKE+freshTrigger.replace("FOR EACH ROW","FOR EACH STATEMENT").replace(" OR UPDATE OF owner_ref, id",""),/source differs/u],
    ["a constraint trigger",freshCreate+TRIGGER_FUNCTION+TRIGGER_REVOKE+freshTrigger.replace("CREATE TRIGGER","CREATE CONSTRAINT TRIGGER").replace("BEFORE INSERT OR DELETE OR UPDATE OF owner_ref, id","AFTER INSERT"),/source differs/u],
  ] as const)("refuses a same-slot trigger with %s",async(label,sql,message)=>{
    const statement=sqlStatements(sql).find(statement=>/^CREATE (?:CONSTRAINT )?TRIGGER /u.test(statement))!;
    triggerStatements.set(sqlSha256(statement),statement);
    const slot={...freshSlot,createdTriggers:label==="an unlisted trigger"?[]:[{...freshSlot.createdTriggers[0]!,sha256:sqlSha256(statement)}]};
    await expect(checkForward(pool,slot,forward(CREATED_OK,sql))).rejects.toThrow(message);
  });
  it("keeps static preimages distinct from a DO-patched installed body", async () => {
    const patch = "DO $$ BEGIN EXECUTE $patch$CREATE OR REPLACE FUNCTION public.cat_replaced(p text, q boolean DEFAULT false) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $body$ SELECT 'patched' $body$;$patch$; END; $$;";
    await checkForward(pool, SYNTHETIC_SLOT, CONFORMING, false, patch);
  });
  // A view recreated byte-for-byte but for spacing differs only in stored parser positions.
  it("admits a view redefinition that changes only parser positions", async () => { await checkForward(pool, SYNTHETIC_SLOT, [REPLACE_PART, CREATED_OK, GRANT_PART, TABLE_PART, "CREATE OR REPLACE VIEW public.cat_view AS SELECT    id   FROM   public.cat_existing_table;"].join("\n")); });
  // The new table's foreign key adds internal triggers to the existing table it references; PostgreSQL creates them, not the forward.
  it("admits a new table with a foreign key to an existing table", async () => { await checkForward(pool, SYNTHETIC_SLOT, forward(CREATED_OK, "CREATE TABLE public.cat_created_child (parent_id int REFERENCES public.cat_existing_table(id));")); });
  // The deferrable unique constraint brings its own internal recheck trigger to the existing table; the forward added the constraint.
  it("admits a deferrable unique constraint on an existing table", async () => { await checkForward(pool, SYNTHETIC_SLOT, forward(CREATED_OK, "ALTER TABLE public.cat_existing_table ADD CONSTRAINT cat_unique UNIQUE (owner_ref) DEFERRABLE;")); });
  it("admits an invoker function that carries no SET", async () => { await checkForward(pool, INVOKER_SLOT, forward(invoker(""))); });
  it.each(REFUSALS.filter(([, , , needsServiceRole]) => serviceRole || !needsServiceRole))("refuses %s", async (_name, sql, message, _needsServiceRole, slot) => {
    await expect(checkForward(pool, slot, sql)).rejects.toThrow(message);
  });
  // Every read that compares an OID with the floor, the three system digests included, must resolve to pg_catalog's own
  // operators: operators a forward creates for (oid, integer) in pg_catalog hide nothing from the snapshot.
  it("reads the OID floor through pg_catalog's own operators", async () => {
    const db = await pool.connect();
    try {
      const before = await pinned(db, () => snapshot(db));
      await db.query("BEGIN");
      try {
        await db.query(`CREATE FUNCTION pg_catalog.cat_hide_ge(oid, integer) RETURNS boolean LANGUAGE sql AS 'select false';
          CREATE FUNCTION pg_catalog.cat_hide_lt(oid, integer) RETURNS boolean LANGUAGE sql AS 'select false';
          CREATE OPERATOR pg_catalog.>= (LEFTARG = oid, RIGHTARG = integer, FUNCTION = pg_catalog.cat_hide_ge);
          CREATE OPERATOR pg_catalog.< (LEFTARG = oid, RIGHTARG = integer, FUNCTION = pg_catalog.cat_hide_lt);`);
        const after = await pinned(db, () => snapshot(db));
        expect(after.functions.length).toBe(before.functions.length + 2);
        expect(after.relations).toEqual(before.relations);
        expect(after.system).toEqual(before.system);
      } finally { await db.query("ROLLBACK"); }
    } finally { db.release(); }
  });
  it("names exactly the guard catalogs in the documentation", () => {
    const section = readFileSync("docs/platform/DATA_AND_MIGRATIONS.md", "utf8").split("- The guard catalogs")[1]?.split(/\n(?:- |\n)/u)[0] ?? "";
    expect([...new Set([...section.matchAll(/`(pg_[a-z_]+)`/gu)].map(match => match[1]))].sort()).toEqual(GUARDS.map(guard => guard.catalog).sort());
  });
  // Each guard catalog is wired into the comparison: one extra row in the after snapshot is a change.
  it.each(GUARDS)("compares every row of the guard catalog $catalog", async ({ id, relation }) => {
    const db = await pool.connect();
    try {
      const before = await snapshot(db);
      const after = structuredClone(before);
      after.guards[id]!.push({ probe: "extra row", tgisinternal: true, tgconstraint: 0, ...relation ? { [relation]: before.relations[0]!.oid } : {} });
      await expect(assertSlotCatalog(db, { createdFunctions: [], replacedFunctions: [], grantOnlyFunctions: [] }, before, after, "postgres")).rejects.toThrow(`catalog: ${id} `);
    } finally { db.release(); }
  });
  it.each(bound)("holds the catalog boundary of $pin.path", ({ pin }) => {
    expect(replay.outcomes.get(pin.path), pin.path).toBeNull();
  });
});
