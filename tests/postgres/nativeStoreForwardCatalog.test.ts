import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { readReviewedForwardRegistry, type NativeStoreSlot } from "../../scripts/reviewed-platform-forward.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

// The static native-store class is a first gate for ordinary mistakes. This test is the
// truth for function identity, attributes and ACLs: it applies a forward to a real
// database and compares what PostgreSQL itself reports with the slot's lists.
type CatalogSlot = Pick<NativeStoreSlot, "createdFunctions" | "replacedFunctions" | "grantOnlyFunctions" | "purposeCheck">;
const PURPOSE_CONSTRAINT = "public.communication_native_sync_state.communication_native_sync_state_purpose_check";
const SYSTEM_SCHEMAS = "(SELECT oid FROM pg_namespace WHERE nspname IN ('pg_catalog','information_schema') OR nspname LIKE 'pg_toast%' OR nspname LIKE 'pg_temp_%')";

type FunctionRow = { oid: number; name: string; attrs: Record<string, unknown>; acl: string[]; src: string };
type RelationRow = { oid: number; name: string; kind: string; owner: string; rls: boolean; forceRls: boolean; options: string | null; acl: string[]; columnAcls: unknown };
type Snapshot = {
  functions: FunctionRow[]; relations: RelationRow[]; constraints: { rel: string; name: string; def: string }[];
  guards: { schemas: string[]; roles: unknown; defaultAcls: unknown; eventTriggers: unknown; extensions: string[]; casts: unknown; triggers: [number, ...unknown[]][]; policies: [number, ...unknown[]][]; rules: [number, ...unknown[]][] };
};
const GRANT_OPTION = " WITH GRANT OPTION";
const aclOf = (expr: string, kind: string, owner: string) => `ARRAY(SELECT (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END)||':'||a.privilege_type||(CASE WHEN a.is_grantable THEN '${GRANT_OPTION}' ELSE '' END)
  FROM aclexplode(COALESCE(${expr}, acldefault('${kind}', ${owner}))) a ORDER BY 1)`;

// Preserve every structural attribute; normalize only parse locations, which PostgreSQL records
// from file offsets rather than from function semantics.
async function snapshot(db: PoolClient): Promise<Snapshot> {
  const functions = (await db.query(`SELECT p.oid::int AS oid, p.oid::regprocedure::text AS name,
    (to_jsonb(p)-'prosrc'-'proacl'-'proargdefaults')||jsonb_build_object('proargdefaults',regexp_replace(COALESCE(p.proargdefaults::text,''),':location -?[0-9]+',':location -1','g')) AS attrs,
    ${aclOf("p.proacl", "f", "p.proowner")} AS acl, p.prosrc AS src
    FROM pg_proc p WHERE p.pronamespace NOT IN ${SYSTEM_SCHEMAS} ORDER BY p.oid`)).rows;
  const relations = (await db.query(`SELECT c.oid::int AS oid, c.oid::regclass::text AS name, c.relkind::text AS kind, c.relowner::regrole::text AS owner,
    c.relrowsecurity AS rls, c.relforcerowsecurity AS "forceRls", c.reloptions::text AS options,
    ${aclOf("c.relacl", "r", "c.relowner")} AS acl,
    (SELECT jsonb_agg(jsonb_build_array(a.attname,a.attacl::text) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attacl IS NOT NULL) AS "columnAcls"
    FROM pg_class c WHERE c.relnamespace NOT IN ${SYSTEM_SCHEMAS} AND c.relkind IN ('r','p','v','m','S','f') ORDER BY c.oid`)).rows;
  // The relation is schema-qualified explicitly: regclass text omits a schema that is on the search path.
  const constraints = (await db.query(`SELECT COALESCE(n.nspname||'.'||c.relname,'-') AS rel, con.conname AS name, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con LEFT JOIN pg_class c ON c.oid=con.conrelid LEFT JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE con.connamespace NOT IN ${SYSTEM_SCHEMAS} ORDER BY 1,2`)).rows;
  const guards = (await db.query(`SELECT ARRAY(SELECT nspname::text FROM pg_namespace ORDER BY 1) AS schemas,
    (SELECT jsonb_agg(to_jsonb(r)-'oid' ORDER BY r.rolname) FROM pg_roles r) AS roles,
    (SELECT jsonb_agg(to_jsonb(d)-'oid' ORDER BY d.defaclrole,d.defaclnamespace,d.defaclobjtype) FROM pg_default_acl d) AS "defaultAcls",
    (SELECT jsonb_agg(to_jsonb(e)-'oid' ORDER BY e.evtname) FROM pg_event_trigger e) AS "eventTriggers",
    ARRAY(SELECT extname||'@'||extversion FROM pg_extension ORDER BY 1) AS extensions,
    (SELECT jsonb_agg(to_jsonb(k)-'oid' ORDER BY k.castsource,k.casttarget) FROM pg_cast k WHERE k.oid>=16384) AS casts,
    (SELECT COALESCE(jsonb_agg(jsonb_build_array(t.tgrelid::int,t.tgname,t.tgfoid::int,t.tgenabled::text) ORDER BY t.tgrelid,t.tgname),'[]'::jsonb) FROM pg_trigger t WHERE NOT t.tgisinternal) AS triggers,
    (SELECT COALESCE(jsonb_agg(jsonb_build_array(p.polrelid::int,p.polname,p.polcmd::text,p.polpermissive,p.polroles::text,pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polrelid,p.polname),'[]'::jsonb) FROM pg_policy p) AS policies,
    (SELECT COALESCE(jsonb_agg(jsonb_build_array(r.ev_class::int,r.rulename,pg_get_ruledef(r.oid)) ORDER BY r.ev_class,r.rulename),'[]'::jsonb) FROM pg_rewrite r WHERE r.rulename<>'_RETURN') AS rules`)).rows[0];
  return { functions, relations, constraints, guards };
}

const norm = (path: string) => `search_path=${path.replace(/\s+/gu, " ").trim()}`;
const quotedValues = (def: string) => (def.match(/'((?:[^']|'')*)'/gu) ?? []).map(value => value.slice(1, -1).replaceAll("''", "'"));
const fail = (message: string): never => { throw new Error(`catalog: ${message}`); };

/** Compare PostgreSQL's own before/after catalogs with one slot's closed lists. Throws on any difference. */
async function assertSlotCatalog(db: PoolClient, slot: CatalogSlot, before: Snapshot, after: Snapshot) {
  const resolve = async (signature: string) => Number((await db.query("SELECT $1::regprocedure::oid::int AS oid", [signature])).rows[0].oid);
  const created = new Map<number, CatalogSlot["createdFunctions"][number]>();
  for (const fn of slot.createdFunctions) created.set(await resolve(fn.signature), fn);
  const replaced = new Set<number>(); for (const fn of slot.replacedFunctions) replaced.add(await resolve(fn.signature));
  const grantOnly = new Map<number, CatalogSlot["grantOnlyFunctions"][number]>();
  for (const fn of slot.grantOnlyFunctions) grantOnly.set(await resolve(fn.signature), fn);

  // 1. New functions are exactly the created list.
  const knownFunctions = new Set(before.functions.map(row => row.oid));
  const added = after.functions.filter(row => !knownFunctions.has(row.oid));
  const addedNames = added.map(row => row.name).sort(); const wantedNames = after.functions.filter(row => created.has(row.oid)).map(row => row.name).sort();
  if (JSON.stringify(addedNames) !== JSON.stringify(wantedNames) || created.size !== wantedNames.length) fail(`created functions differ from the slot list: ${addedNames.join(", ")} versus ${wantedNames.join(", ")}`);

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

  // 3. Created functions: pinned search_path for every definer, no PUBLIC or anon execute, closed grantees only.
  for (const row of added) {
    const entry = created.get(row.oid)!;
    const owner = String((await db.query("SELECT proowner::regrole::text AS owner FROM pg_proc WHERE oid=$1", [row.oid])).rows[0].owner);
    const config = row.attrs.proconfig as string[] | null;
    if (entry.searchPath !== null) { if (JSON.stringify(config) !== JSON.stringify([norm(entry.searchPath)])) fail(`created function ${row.name} has proconfig ${JSON.stringify(config)}, not the pinned search_path`); }
    else if (row.attrs.prosecdef) fail(`created definer ${row.name} has no pinned search_path in its slot`);
    else if (config !== null) fail(`created function ${row.name} has proconfig ${JSON.stringify(config)} but its slot pins none`);
    if (row.acl.some(item => item.startsWith("PUBLIC:"))) fail(`created function ${row.name} keeps PUBLIC execute`);
    for (const item of row.acl) {
      const grantee = item.slice(0, item.indexOf(":"));
      if (grantee !== owner && !["authenticated", "service_role"].includes(grantee)) fail(`created function ${row.name} grants ${item}`);
      if (grantee !== owner && item.endsWith(GRANT_OPTION)) fail(`created function ${row.name} grants ${item}, which can pass the privilege on`);
    }
  }

  // 4. Relations: no privilege or row-security change on an existing one; a new one carries only its owner's privileges.
  const oldRelations = new Map(before.relations.map(row => [row.oid, row]));
  const currentRelations = new Map(after.relations.map(row => [row.oid, row]));
  for (const old of before.relations) if (JSON.stringify(currentRelations.get(old.oid)) !== JSON.stringify(old)) fail(`existing relation ${old.name} changed its ACL, row security, options or column ACLs`);
  for (const row of after.relations) if (!oldRelations.has(row.oid)) {
    for (const item of row.acl) if (!item.startsWith(`${row.owner}:`)) fail(`new relation ${row.name} grants ${item}`);
    if (row.columnAcls !== null) fail(`new relation ${row.name} has column privileges ${JSON.stringify(row.columnAcls)}`);
  }

  // 5. Constraints: none dropped or rewritten; the purpose CHECK only widens, and only when the slot lists it.
  const constraintKey = (row: { rel: string; name: string }) => `${row.rel}.${row.name}`;
  const nowConstraints = new Map(after.constraints.map(row => [constraintKey(row), row.def]));
  for (const old of before.constraints) {
    const def = nowConstraints.get(constraintKey(old));
    if (constraintKey(old) === PURPOSE_CONSTRAINT && def !== undefined && def !== old.def) {
      const oldValues = quotedValues(old.def), newValues = quotedValues(def);
      const wanted = slot.purposeCheck ? [...new Set([...oldValues, ...slot.purposeCheck.values])].sort() : null;
      if (!wanted || JSON.stringify([...new Set(newValues)].sort()) !== JSON.stringify(wanted)) fail(`purpose CHECK changed beyond the slot's widening: ${def}`);
    } else if (def !== old.def) fail(`constraint ${constraintKey(old)} was dropped or rewritten`);
  }

  // 6. Cheap global guards: nothing outside the slot lists changes.
  const a = before.guards, b = after.guards;
  for (const key of ["schemas", "roles", "defaultAcls", "eventTriggers", "extensions", "casts"] as const) if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) fail(`${key} changed`);
  // A trigger, policy or rewrite rule attaches behaviour to an existing relation without touching its row.
  for (const key of ["triggers", "policies", "rules"] as const) {
    const onExisting = (rows: [number, ...unknown[]][]) => rows.filter(([rel]) => oldRelations.has(rel));
    if (JSON.stringify(onExisting(b[key])) !== JSON.stringify(onExisting(a[key]))) fail(`${key} on existing relations changed`);
  }
}

// Run a forward in a transaction on a real database and check it against the slot. It is rolled
// back, except that `keep` commits a forward that passed so the next slot sees the cumulative chain.
async function checkForward(pool: Pool, slot: CatalogSlot, forward: string, keep = false) {
  const db = await pool.connect();
  let passed = false;
  try {
    const before = await snapshot(db);
    await db.query("BEGIN");
    try {
      await db.query(forward);
      await assertSlotCatalog(db, slot, before, await snapshot(db));
      passed = true;
    } finally { await db.query(keep && passed ? "COMMIT" : "ROLLBACK"); }
  } finally { db.release(); }
}

// ---- Synthetic cases: the comparator itself, on real PostgreSQL ---------------------------------
const SYNTHETIC_BASE = `
CREATE TABLE public.cat_existing_table (id int PRIMARY KEY, owner_ref uuid NOT NULL);
CREATE TABLE public.communication_native_sync_state (purpose text NOT NULL CONSTRAINT communication_native_sync_state_purpose_check CHECK (purpose IN ('a','b')));
CREATE FUNCTION public.cat_replaced(p text, q boolean DEFAULT false) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT 'before' $$;
REVOKE ALL ON FUNCTION public.cat_replaced(text,boolean) FROM PUBLIC;
CREATE FUNCTION public.cat_grant_only(p text) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT 'x' $$;
REVOKE ALL ON FUNCTION public.cat_grant_only(text) FROM PUBLIC;
CREATE FUNCTION public.cat_trigger_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`;
// A default argument stores parser locations, which move when the replacement sits at another file offset.
const SYNTHETIC_SLOT: CatalogSlot = {
  replacedFunctions: [{ signature: "public.cat_replaced(text,boolean)", beforeSha256: null, searchPath: "pg_catalog, pg_temp" }],
  createdFunctions: [{ signature: "public.cat_created(text)", searchPath: "pg_catalog, pg_temp" }],
  grantOnlyFunctions: [{ signature: "public.cat_grant_only(text)", grantTo: ["service_role"], revokeFrom: ["anon", "authenticated"] }],
};
const PURPOSE_SLOT: CatalogSlot = { ...SYNTHETIC_SLOT, purposeCheck: { beforeSha256: "", values: ["c"] } };
// An invoker function pins no search_path, so the slot lists none and the catalog must show none.
const INVOKER_SLOT: CatalogSlot = { ...SYNTHETIC_SLOT, createdFunctions: [{ signature: "public.cat_created(text)", searchPath: null }] };
const invoker = (attributes: string) => `CREATE FUNCTION public.cat_created(p text) RETURNS text LANGUAGE sql${attributes} AS $$ SELECT p $$;\nREVOKE ALL ON FUNCTION public.cat_created(text) FROM PUBLIC;`;
const purposeCheck = (values: string) => `ALTER TABLE public.communication_native_sync_state DROP CONSTRAINT communication_native_sync_state_purpose_check;
ALTER TABLE public.communication_native_sync_state ADD CONSTRAINT communication_native_sync_state_purpose_check CHECK (purpose IN (${values}));`;
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
// The statement reported as FC-R1B-001, unchanged: a quoted default hides an `AS $q$` so a static
// header reader takes a fake search_path attribute list for the real one.
const HIDDEN_HEADER = "CREATE FUNCTION public.cat_created(p text DEFAULT ' SET search_path = pg_catalog, pg_temp AS $q$') RETURNS text LANGUAGE sql SECURITY DEFINER AS 'select p' SET application_name = x$q$;";
const UNLISTED = "CREATE FUNCTION public.cat_unlisted(p text) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT p $$;\nREVOKE ALL ON FUNCTION public.cat_unlisted(text) FROM PUBLIC;";
const REFUSALS: [string, string, RegExp, boolean, CatalogSlot][] = [
  ["the FC-R1B-001 header under a listed signature", forward(`${HIDDEN_HEADER}\n${REVOKE_CREATED}`), /pinned search_path/u, false, SYNTHETIC_SLOT],
  ["an unlisted function", forward(CREATED_OK, UNLISTED), /created functions differ/u, false, SYNTHETIC_SLOT],
  ["a definer without the pinned search_path", forward(`${CREATE_PINNED.replace(" SET search_path = pg_catalog, pg_temp", "")}\n${REVOKE_CREATED}`), /pinned search_path/u, false, SYNTHETIC_SLOT],
  ["retained PUBLIC execute", forward(CREATE_PINNED), /PUBLIC execute/u, false, SYNTHETIC_SLOT],
  ["a grant to PUBLIC on a created function", forward(CREATED_OK, "GRANT EXECUTE ON FUNCTION public.cat_created(text) TO PUBLIC;"), /PUBLIC execute/u, false, SYNTHETIC_SLOT],
  ["a grant on an existing table", forward(CREATED_OK, "GRANT SELECT ON public.cat_existing_table TO service_role;"), /existing relation/u, true, SYNTHETIC_SLOT],
  ["an invoker function that carries a SET its slot does not pin", forward(invoker(" SET application_name = x")), /slot pins none/u, false, INVOKER_SLOT],
  ["a grant option on a created function", forward(CREATED_OK, "GRANT EXECUTE ON FUNCTION public.cat_created(text) TO authenticated WITH GRANT OPTION;"), /pass the privilege on/u, false, SYNTHETIC_SLOT],
  ["a grant option on a grant-only function", forward(CREATED_OK, "GRANT EXECUTE ON FUNCTION public.cat_grant_only(text) TO service_role WITH GRANT OPTION;"), /outside its grant list/u, true, SYNTHETIC_SLOT],
  ["a grant on a new table", forward(CREATED_OK, "GRANT SELECT ON public.cat_created_table TO authenticated;"), /new relation .* grants/u, false, SYNTHETIC_SLOT],
  ["a column privilege on a new table", forward(CREATED_OK, "GRANT SELECT (id) ON public.cat_created_table TO authenticated;"), /column privileges/u, false, SYNTHETIC_SLOT],
  ["a trigger on an existing table", forward(CREATED_OK, "CREATE TRIGGER cat_trigger BEFORE INSERT ON public.cat_existing_table FOR EACH ROW EXECUTE FUNCTION public.cat_trigger_fn();"), /triggers on existing relations/u, false, SYNTHETIC_SLOT],
  ["a policy on an existing table", forward(CREATED_OK, "CREATE POLICY cat_policy ON public.cat_existing_table USING (true);"), /policies on existing relations/u, false, SYNTHETIC_SLOT],
  ["a rewrite rule on an existing table", forward(CREATED_OK, "CREATE RULE cat_rule AS ON INSERT TO public.cat_existing_table DO INSTEAD NOTHING;"), /rules on existing relations/u, false, SYNTHETIC_SLOT],
  ["a purpose CHECK that drops a value", forward(CREATED_OK, purposeCheck("'b','c'")), /purpose CHECK/u, false, PURPOSE_SLOT],
  ["a purpose CHECK widened beyond its slot", forward(CREATED_OK, purposeCheck("'a','b','c','z'")), /purpose CHECK/u, false, PURPOSE_SLOT],
  ["a purpose CHECK rewritten by a slot that lists none", forward(CREATED_OK, purposeCheck("'a','b','c'")), /purpose CHECK/u, false, SYNTHETIC_SLOT],
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
// The chain creates anon and authenticated itself; service_role comes from the host bootstrap, so it is
// the one role these two modes toggle for the whole run.
async function replayBound(connectionString: string) {
  const outcomes = new Map<string, Error | null>();
  const chainDb = new Pool({ connectionString });
  const applied = new Set<string>();
  try {
    for (const { pin, slot } of bound) {
      for (const unit of chain.filter(unit => unit.path < pin.path && !applied.has(unit.path))) { await chainDb.query(unit.sql); applied.add(unit.path); }
      const bytes = readFileSync(pin.path);
      if (sha(bytes) !== pin.sha256) throw new Error(`bound forward differs from its pin: ${pin.path}`);
      outcomes.set(pin.path, await checkForward(chainDb, slot, bytes.toString("utf8"), true).then(() => null, (error: Error) => error));
    }
  } finally { await chainDb.end(); }
  return outcomes;
}

describe.each([{ serviceRole: true }, { serviceRole: false }])("native store forward catalog, service_role present: $serviceRole", ({ serviceRole }) => {
  let container: PostgresContainer | undefined;
  let pool: Pool;
  let outcomes = new Map<string, Error | null>();
  beforeAll(async () => {
    if (!await dockerAvailable()) throw new Error("The native store catalog proof requires real PostgreSQL");
    container = await runPostgresContainer({ name: `native-catalog-${serviceRole ? "role" : "bare"}-${process.pid}`, password: "synthetic-conformance" });
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Native store catalog PostgreSQL unavailable");
    const admin = new Pool({ connectionString: container.connectionString });
    try {
      if (serviceRole) await admin.query("CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS");
      await admin.query("CREATE DATABASE native_chain");
      await admin.query("CREATE DATABASE synthetic");
      if (bound.length) outcomes = await replayBound(container.connectionStringFor("native_chain"));
      // The closed roles exist after the chain; the synthetic database needs them either way.
      for (const role of ["anon", "authenticated"]) await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END; $$`);
    } finally { await admin.end(); }
    const synthetic = new Pool({ connectionString: container.connectionStringFor("synthetic") });
    await synthetic.query(SYNTHETIC_BASE); await synthetic.end();
    pool = new Pool({ connectionString: container.connectionStringFor("synthetic") });
  }, postgresSetupTimeoutMs);
  afterAll(async () => { await closePostgres(container, pool); }, postgresTeardownTimeoutMs);

  it("admits a conforming forward", async () => { await checkForward(pool, SYNTHETIC_SLOT, CONFORMING); });
  it("admits a widened purpose CHECK that its slot lists", async () => { await checkForward(pool, PURPOSE_SLOT, forward(CREATED_OK, purposeCheck("'a','b','c'"))); });
  it("admits an invoker function that carries no SET", async () => { await checkForward(pool, INVOKER_SLOT, forward(invoker(""))); });
  it.each(REFUSALS.filter(([, , , needsServiceRole]) => serviceRole || !needsServiceRole))("refuses %s", async (_name, sql, message, _needsServiceRole, slot) => {
    await expect(checkForward(pool, slot, sql)).rejects.toThrow(message);
  });
  it.each(bound)("holds the catalog boundary of $pin.path", ({ pin }) => {
    expect(outcomes.get(pin.path), pin.path).toBeNull();
  });
});
