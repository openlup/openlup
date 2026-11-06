import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { readReviewedForwardRegistry, nativeStoreChecks, nativeStoreCheckPreimage, nativeStoreUniqueDefinition, nativeStoreTriggerDefinition, sqlSha256, sqlStatements, type NativeStoreSlot } from "../../scripts/reviewed-platform-forward.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

// The static native-store class is a first gate for ordinary mistakes. This test is the
// truth for function identity, attributes and ACLs: it applies a forward to a real
// database and compares what PostgreSQL itself reports with the slot's lists.
type CatalogSlot = Pick<NativeStoreSlot, "createdFunctions" | "replacedFunctions" | "grantOnlyFunctions" | "purposeCheck" | "insertSelectTables" | "checkSupersets" | "uniqueSupersets" | "createdViews" | "createdTriggers">;
// PostgreSQL creates its own objects below this OID; every object a forward adds is at or above it.
const FIRST_USER_OID = 16384;
// The floor is typed as oid, so every comparison with it resolves to pg_catalog's own oid >= oid and oid < oid. A bare integer
// would resolve to an operator for (oid, integer), which a forward can create in pg_catalog to hide the objects it adds.
const OID_FLOOR = `${FIRST_USER_OID}::pg_catalog.oid`;
const GRANT_OPTION = " WITH GRANT OPTION";
// Node trees (default arguments, rules, policies, trigger conditions) store where the parser read them in the file, which
// moves when the same statement sits at another offset. That is compared as nothing; everything else in a tree is compared.
const POSITIONS = String.raw`':(?:stmt_)?location -?[0-9]+|:stmt_len [0-9]+', ':position'`;

type FunctionRow = { oid: number; name: string; owner: string; attrs: Record<string, unknown>; acl: string[]; src: string };
type RelationRow = { oid: number; name: string; kind: string; owner: string; rls: boolean; forceRls: boolean; options: string | null; acl: string[]; columnAcls: unknown };
type Snapshot = {
  functions: FunctionRow[]; relations: RelationRow[]; system: { functions: string; relations: string };
  relationOids: number[]; constraintOids: number[]; constraints: { rel: string; name: string; def: string; indexOid: number }[]; guards: Record<string, Record<string, unknown>[]>;
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
  const relations = (await db.query(`SELECT c.oid::int AS oid, c.oid::regclass::text AS name, c.relkind::text AS kind, c.relowner::regrole::text AS owner,
    c.relrowsecurity AS rls, c.relforcerowsecurity AS "forceRls", c.reloptions::text AS options,
    ${aclOf("c.relacl", "(CASE WHEN c.relkind='S' THEN 's' ELSE 'r' END)::\"char\"", "c.relowner")} AS acl,
    (SELECT jsonb_agg(jsonb_build_array(a.attname,a.attacl::text) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attacl IS NOT NULL) AS "columnAcls"
    FROM pg_class c WHERE c.oid >= ${OID_FLOOR} ORDER BY c.oid`)).rows;
  // Objects PostgreSQL ships are compared as one digest of the facts that carry privileges; statistics columns are left out
  // because autovacuum changes them between two snapshots.
  const system = (await db.query(`SELECT
    md5(COALESCE((SELECT string_agg(to_jsonb(p)::text, E'\\n' ORDER BY p.oid) FROM pg_proc p WHERE p.oid < ${OID_FLOOR}),'')) AS functions,
    md5(COALESCE((SELECT string_agg(jsonb_build_array(c.oid,c.relname,c.relnamespace,c.relowner,c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.reloptions,c.relacl::text)::text, E'\\n' ORDER BY c.oid) FROM pg_class c WHERE c.oid < ${OID_FLOOR}),'')
      || COALESCE((SELECT string_agg(a.attrelid||'.'||a.attname||'='||a.attacl::text, E'\\n' ORDER BY a.attrelid,a.attnum) FROM pg_attribute a WHERE a.attrelid < ${OID_FLOOR} AND a.attacl IS NOT NULL),'')) AS relations`)).rows[0];
  // The relation is schema-qualified explicitly: regclass text omits a schema that is on the search path.
  const constraints = (await db.query(`SELECT COALESCE(n.nspname||'.'||c.relname, 'type:'||con.contypid::regtype::text) AS rel, con.conname AS name, pg_get_constraintdef(con.oid) AS def, con.conindid::int AS "indexOid"
    FROM pg_constraint con LEFT JOIN pg_class c ON c.oid=con.conrelid LEFT JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE con.contype <> 'n' ORDER BY 1,2`)).rows;
  const relationOids = (await db.query("SELECT oid::int AS oid FROM pg_class ORDER BY oid")).rows.map(row => row.oid as number);
  const constraintOids = (await db.query("SELECT oid::int AS oid FROM pg_constraint ORDER BY oid")).rows.map(row => row.oid as number);
  const guards: Snapshot["guards"] = {};
  for (const guard of GUARDS) guards[guard.id] = (await db.query(`SELECT COALESCE(jsonb_agg(r ORDER BY r),'[]'::jsonb) AS rows FROM (
    SELECT regexp_replace((to_jsonb(t)${["oid", ...guard.drop ?? []].map(key => ` - '${key}'`).join("")})::text, ${POSITIONS}, 'g')::jsonb AS r
    FROM ${guard.catalog} t WHERE ${guard.where ?? "true"}) s`)).rows[0].rows;
  return { functions, relations, system, relationOids, constraintOids, constraints, guards };
}

const norm = (path: string) => `search_path=${path.replace(/\s+/gu, " ").trim()}`;
const quotedValues = (list: string) => (list.match(/'((?:[^']|'')*)'/gu) ?? []).map(value => value.slice(1, -1).replaceAll("''", "'"));
// The only shape the purpose CHECK may take, as PostgreSQL deparses it. A NOT IN, an OR, NOT VALID or NO INHERIT
// spelling does not match and so never reads as a list of allowed values.
const checkValues = (def: string, column: string) => {
  const shape = new RegExp(`^CHECK \\(\\(${column} = ANY \\(ARRAY\\[((?:'(?:[^']|'')*'::text)(?:, '(?:[^']|'')*'::text)*)\\]\\)\\)\\)$`, "u");
  const match = shape.exec(def); return match ? quotedValues(match[1]!) : null;
};
const fail = (message: string): never => { throw new Error(`catalog: ${message}`); };

/** Compare PostgreSQL's own before/after catalogs with one slot's closed lists. Throws on any difference. */
async function assertSlotCatalog(db: PoolClient, slot: CatalogSlot, before: Snapshot, after: Snapshot, migrationRole: string) {
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
  for (const old of before.relations) if (!replacedUniqueIndexes.has(old.oid) && JSON.stringify(currentRelations.get(old.oid)) !== JSON.stringify(old)) fail(`existing relation ${old.name} changed its owner, ACL, row security, options or column ACLs`);
  for (const row of after.relations) if (!oldRelations.has(row.oid)) {
    if (row.owner !== migrationRole) fail(`new relation ${row.name} is owned by ${row.owner}, not the migration role`);
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

  const newViews = after.relations.filter(row => !oldRelations.has(row.oid) && row.kind === "v").map(row => row.name).sort();
  if (JSON.stringify(newViews) !== JSON.stringify((slot.createdViews ?? []).map(view => view.name).sort())) fail("created views differ from the slot list");

  // Installed definitions must equal the parsed, hash-bound preimages before
  // the forward, even when unrelated additive DDL intervened on the same table.
  const constraintKey = (row: { rel: string; name: string }) => `${row.rel}.${row.name}`;
  const nowConstraints = new Map(after.constraints.map(row => [constraintKey(row), row.def]));
  const checks = nativeStoreChecks(slot), uniques = slot.uniqueSupersets ?? [];
  const sorted = (values: string[]) => JSON.stringify([...new Set(values)].sort());
  for (const entry of checks) {
    const old = before.constraints.find(old => old.rel === entry.table && old.name === entry.constraint);
    const source = preimages.get(entry.beforeSha256), parsed = source ? nativeStoreCheckPreimage(source, entry) : null;
    const oldValues = old ? checkValues(old.def, entry.column) : null;
    const def = nowConstraints.get(`${entry.table}.${entry.constraint}`), newValues = def ? checkValues(def, entry.column) : null;
    if (!parsed || !oldValues || sorted(parsed) !== sorted(oldValues) || !newValues || oldValues.some(value => !newValues.includes(value)) || sorted(entry.values) !== sorted(entry.legacy ? oldValues : newValues)) fail(`purpose CHECK changed beyond a widening of its listed values: ${def}`);
  }
  for (const entry of uniques) {
    const old = before.constraints.find(old => old.rel === entry.table && old.name === entry.constraint);
    const source = preimages.get(entry.beforeSha256), parsed = source ? nativeStoreUniqueDefinition(source, entry.constraint) : null;
    const oldDef = old ? nativeStoreUniqueDefinition(`CONSTRAINT ${entry.constraint} ${old.def}`, entry.constraint) : null;
    const def = nowConstraints.get(`${entry.table}.${entry.constraint}`), newDef = def ? nativeStoreUniqueDefinition(`CONSTRAINT ${entry.constraint} ${def}`, entry.constraint) : null;
    if (!parsed || JSON.stringify(parsed) !== JSON.stringify(oldDef) || !newDef || parsed.columns.some(column => !entry.columns.includes(column)) || JSON.stringify(newDef) !== JSON.stringify({ columns: entry.columns, nullsNotDistinct: entry.nullsNotDistinct })) fail(`UNIQUE changed beyond its listed superset: ${def}`);
  }
  for (const old of before.constraints) {
    if (checks.some(entry => entry.table === old.rel && entry.constraint === old.name) || uniques.some(entry => entry.table === old.rel && entry.constraint === old.name)) continue;
    if (nowConstraints.get(constraintKey(old)) !== old.def) fail(`constraint ${constraintKey(old)} was dropped or rewritten`);
  }

  const admittedTriggers = new Set<string>();
  for (const entry of slot.createdTriggers ?? []) {
    const statement = preimages.get(entry.sha256), expected = statement ? nativeStoreTriggerDefinition(statement) : null;
    if (!expected || expected.name !== entry.name || expected.table !== entry.table) fail("created trigger source differs from its listed hash and identity");
    if (before.guards.triggers!.some(row => row.tgname === entry.name)) fail("created trigger name existed in the prefix");
    const table = before.relations.find(row => row.name === entry.table && row.kind === "r");
    const fn = slot.createdFunctions.find(fn => fn.signature === expected!.signature);
    if (!table || !fn || !fn.searchPath) fail("created trigger requires an existing table and same-slot created function");
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
      await pinned(db, async () => assertSlotCatalog(db, slot, before, await snapshot(db), migrationRole));
      passed = true;
    } finally { await db.query(keep && passed ? "COMMIT" : "ROLLBACK"); }
  } finally { db.release(); }
}

// ---- Synthetic cases: the comparator itself, on real PostgreSQL ---------------------------------
const SYNTHETIC_BASE = `
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
CREATE TABLE public.cat_child (parent_id int REFERENCES public.cat_existing_table(id));`;
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
  ["a purpose CHECK rewritten by a slot that lists none", forward(CREATED_OK, purposeCheck("CHECK (purpose IN ('a','b','c'))")), /dropped or rewritten/u, false, SYNTHETIC_SLOT],
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
const preimages = new Map([SYNTHETIC_BASE, TRIGGER_SQL, ...chain.map(unit => unit.sql), ...bound.map(entry => readFileSync(entry.pin.path, "utf8"))].flatMap(sql => sqlStatements(sql, true).map(statement => [sqlSha256(statement), statement] as const)));
const parameterSource = sqlStatements(SYNTHETIC_BASE).find(statement => statement.startsWith("CREATE TABLE public.cat_parameters"))!;
const PARAMETER_SLOT: CatalogSlot = { ...SYNTHETIC_SLOT, checkSupersets: [
  { table: "public.cat_parameters", constraint: "cat_status", column: "status", beforeSha256: sqlSha256(parameterSource), values: ["open", "closed", "paused"] },
  { table: "public.cat_parameters", constraint: "cat_kind", column: "kind", beforeSha256: sqlSha256(parameterSource), values: ["first", "second", "third"] },
] };
const PARAMETER_CHECKS = "ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_status; ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_status CHECK (status IN ('open','closed','paused')); ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_kind; ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_kind CHECK (kind IN ('first','second','third'));";
const UNIQUE_SLOT: CatalogSlot = { ...SYNTHETIC_SLOT, uniqueSupersets: [{ table: "public.cat_parameters", constraint: "cat_key", beforeSha256: sqlSha256(parameterSource), columns: ["id", "extra"], nullsNotDistinct: true }] };
const UNIQUE_SQL = "ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_key; ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_key UNIQUE NULLS NOT DISTINCT (id,extra);";
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
  it("admits a conforming forward", async () => { await checkForward(pool, SYNTHETIC_SLOT, CONFORMING); });
  it("admits only the named new table runtime ACL and policy", async () => { await checkForward(pool, NOTICE_SLOT, forward(CREATED_OK, NOTICE_SQL)); });
  it("admits a widened purpose CHECK that its slot lists", async () => { await checkForward(pool, PURPOSE_SLOT, forward(CREATED_OK, purposeCheck("CHECK (purpose IN ('a','b','c'))"))); });
  it("admits multiple named CHECK widenings after unrelated additive DDL", async () => {
    await checkForward(pool, PARAMETER_SLOT, forward(CREATED_OK, PARAMETER_CHECKS), false, "ALTER TABLE public.cat_parameters ADD COLUMN unrelated uuid; ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_unrelated CHECK (unrelated IS NULL) NOT VALID;");
  });
  it("requires installed CHECK preimages to equal the hash-bound parsed values", async () => {
    const setup = "ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_status; ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_status CHECK (status IN ('open'));";
    await expect(checkForward(pool, PARAMETER_SLOT, forward(CREATED_OK, PARAMETER_CHECKS), false, setup)).rejects.toThrow(/CHECK changed/u);
  });
  it("proves a UNIQUE superset and its exact NULLS mode in the installed catalog", async () => {
    await checkForward(pool, UNIQUE_SLOT, forward(CREATED_OK, UNIQUE_SQL));
    await expect(checkForward(pool, UNIQUE_SLOT, forward(CREATED_OK, UNIQUE_SQL.replace("(id,extra)", "(extra)")))).rejects.toThrow(/UNIQUE changed/u);
    await expect(checkForward(pool, UNIQUE_SLOT, forward(CREATED_OK, UNIQUE_SQL.replace(" NULLS NOT DISTINCT", "")))).rejects.toThrow(/UNIQUE changed/u);
    await expect(checkForward(pool, UNIQUE_SLOT, forward(CREATED_OK, UNIQUE_SQL), false, "ALTER TABLE public.cat_parameters DROP CONSTRAINT cat_key; ALTER TABLE public.cat_parameters ADD CONSTRAINT cat_key UNIQUE (extra);")).rejects.toThrow(/UNIQUE changed/u);
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
    preimages.set(sqlSha256(statement), statement);
    const slot = { ...TRIGGER_SLOT, createdTriggers: [TRIGGER_SLOT.createdTriggers![0]!, { name: "cat_base_trigger", table: "public.cat_parameters", sha256: sqlSha256(statement) }] };
    await expect(checkForward(pool, slot, forward(CREATED_OK, TRIGGER_SQL.replace(TRIGGER_AFTER, statement)))).rejects.toThrow("catalog: created trigger name existed in the prefix");
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
