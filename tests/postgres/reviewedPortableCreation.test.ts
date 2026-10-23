import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { assertPortableCreationStatements, readReviewedForwardRegistry } from "../../scripts/reviewed-platform-forward.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const manifest: PlatformMigrationManifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
const registry = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"));
const pinned = [...registry.portableCreationForwards!, ...registry.portableReplacementForwards!.filter(entry => entry.path.includes("invoicing"))].sort((a,b) => a.path.localeCompare(b.path));
const fixturePath = (path: string) => `scripts/fixtures/${path.split("/").at(-1)}`;
function selectPinnedBytes<T extends { path: string; sha256: string }>(root: string, entries: T[]) {
  return entries.map(entry => {
    const fixture = readFileSync(join(root, fixturePath(entry.path)));
    const source = existsSync(join(root, entry.path)) ? entry.path : fixturePath(entry.path);
    const bytes = readFileSync(join(root, source));
    if (!bytes.equals(fixture) || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
      throw new Error(`Reviewed forward PG bytes differ from pinned fixture: ${entry.path}`);
    }
    return { ...entry, source, bytes };
  });
}

// This is the selection used by the PG setup, before any target is applied.
function selectPgGateTargets(root: string) {
  return {
    native: selectPinnedBytes(root, pinned),
    managed: selectPinnedBytes(root, registry.managedInvoicingForwards!),
  };
}
let selected: ReturnType<typeof selectPgGateTargets>;
const nativeTargetPaths = new Set(pinned.map(entry => entry.path));
const managedTargetPaths = new Set(registry.managedInvoicingForwards!.map(entry => entry.path));
const expectedTriggers: Record<string, unknown[]> = { "db/platform/migrations/20261022080000_fulfillment_command_ledger.sql": [], "db/platform/migrations/20261022090000_fulfillment_delivery_alignment.sql": [
  { table_name: "public.commerce_order_holds", name: "trg_subscription_delivery_alignment_exception_case", function_name: "public.subscription_delivery_alignment_open_exception_case" },
  { table_name: "public.fulfillment_shipments", name: "trg_subscription_delivery_alignment_on_delivery", function_name: "public.subscription_delivery_alignment_on_delivery" },
  { table_name: "public.subscription_cycles", name: "trg_subscription_delivery_alignment_guard_cycle_insert", function_name: "public.subscription_delivery_alignment_guard_cycle_insert" },
] };

async function snapshot(pool: Pool) {
  const relations = (await pool.query(`SELECT c.oid, c.relacl::text, c.reloptions,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid) AS attributes
    FROM pg_class c ORDER BY c.oid`)).rows;
  const functions = (await pool.query(`SELECT p.oid, p.prosrc, p.proconfig, p.prosecdef, p.proacl::text, p.proowner, p.prorettype, pg_get_expr(p.proargdefaults,0) AS proargdefaults, p.provolatile,
    n.nspname || '.' || p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace ORDER BY p.oid`)).rows;
  const types = (await pool.query("SELECT oid, typacl::text FROM pg_type ORDER BY oid")).rows;
  // Constraint-generated internal FK triggers are dependencies of the new tables;
  // this inventory measures the explicit CREATE TRIGGER attachments in the files.
  const triggers = (await pool.query(`SELECT t.oid, t.tgrelid, t.tgfoid,
    n.nspname || '.' || c.relname AS table_name, t.tgname AS name,
    pn.nspname || '.' || p.proname AS function_name
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace
    WHERE NOT t.tgisinternal ORDER BY table_name, name`)).rows;
  return { relations, functions, types, triggers };
}

let container: PostgresContainer | undefined;
let pool: Pool;
const applied = new Set<string>();
type CatalogSnapshot = Awaited<ReturnType<typeof snapshot>>;
const catalogEvidence = new Map<string, { before: CatalogSnapshot; after: CatalogSnapshot; forbidden: unknown[] }>();
beforeAll(async () => {
  selected = selectPgGateTargets(".");
  if (!await dockerAvailable()) throw new Error("Reviewed forward catalog proof requires real PostgreSQL");
  container = await runPostgresContainer({ name: `reviewed-creation-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Reviewed forward PostgreSQL unavailable");
  pool = new Pool({ connectionString: container.connectionString });
  // Apply and snapshot each boundary once before cases run, so shuffled cases
  // still inspect their own real catalog proof rather than a sibling's state.
  for (const { path, sha256, bytes } of selected.native) {
    // Targets run only at their own snapshot boundary, even after landing in
    // the manifest. Sorted earlier targets have already run from selected bytes.
    for (const unit of [manifest.baseline, ...manifest.forward].filter(unit => unit.file < path && !nativeTargetPaths.has(unit.file))) {
      if (applied.has(unit.file)) continue;
      const source = readFileSync(unit.file);
      expect(createHash("sha256").update(source).digest("hex")).toBe(unit.sha256);
      await pool.query(source.toString("utf8"));
      applied.add(unit.file);
    }
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
    const before = await snapshot(pool);
    await pool.query(bytes.toString("utf8"));
    applied.add(path);
    const after = await snapshot(pool);
    const forbidden = (await pool.query(`WITH new_acl AS (
      SELECT c.oid, 'relation' AS kind, c.relacl AS acl FROM pg_class c WHERE NOT (c.oid=ANY($1::oid[]))
      UNION ALL SELECT a.attrelid, 'column', a.attacl FROM pg_attribute a WHERE NOT (a.attrelid=ANY($1::oid[]))
      UNION ALL SELECT p.oid, 'function', p.proacl FROM pg_proc p WHERE NOT (p.oid=ANY($2::oid[]))
      UNION ALL SELECT t.oid, 'type', t.typacl FROM pg_type t WHERE NOT (t.oid=ANY($3::oid[]))
    ) SELECT n.oid, n.kind, x.privilege_type, x.grantee FROM new_acl n CROSS JOIN LATERAL aclexplode(n.acl) x
      WHERE x.grantee=0 OR x.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon','authenticated'))`,
    [before.relations.map(row => row.oid), before.functions.map(row => row.oid), before.types.map(row => row.oid)])).rows;
    catalogEvidence.set(path, { before, after, forbidden });
  }
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(container, pool); }, postgresTeardownTimeoutMs);

it.each(pinned)("preserves the catalog boundary of $path", async ({ path, sha256 }) => {
    const { bytes } = selected.native.find(entry => entry.path === path)!;
    expect((await pool.query("SHOW standard_conforming_strings")).rows).toEqual([{ standard_conforming_strings: "on" }]);
    const { before, after, forbidden } = catalogEvidence.get(path)!;
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
    for (const kind of ["relations", "functions"] as const) {
      const current = new Map(after[kind].map(row => [row.oid, row]));
      for (const row of before[kind]) {
        if (kind === "functions" && path.includes("payment_decoupling") && "name" in row && row.name === "public.payment_truth_apply_terminal") {
          const changed = current.get(row.oid)!;
          expect({ ...changed, prosrc: "omitted" }).toEqual({ ...row, prosrc: "omitted" });
          expect(changed).not.toEqual(row);
        } else expect(current.get(row.oid), `${path}: pre-existing ${kind} ${row.oid}`).toEqual(row);
      }
    }
    const oldFunctions = new Set(before.functions.map(row => row.oid));
    const newFunctions = after.functions.filter(row => !oldFunctions.has(row.oid));
    if (path.includes("payment_decoupling")) expect(newFunctions).toEqual([]);
    else expect(newFunctions.length).toBeGreaterThan(0);
    expect(newFunctions.filter(row => row.prosecdef)).toEqual([]);
    if (path.includes("invoicing") && !path.includes("payment_decoupling")) {
      // Inspect every function PostgreSQL actually created, including readback
      // and optional order filters, without reusing the replacement-only parser.
      for (const routine of newFunctions) {
        expect((await pool.query(`SELECT p.prosecdef,p.proconfig,
          has_function_privilege('anon',p.oid,'EXECUTE') anon,
          has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
          EXISTS(SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee=0) public
          FROM pg_proc p WHERE p.oid=$1::oid`,[routine.oid])).rows)
          .toEqual([{prosecdef:false,proconfig:["search_path=pg_catalog"],anon:false,authenticated:false,public:false}]);
      }
    }
    if(path.includes("durable_duties")) {
      expect((await pool.query("SELECT attname FROM pg_attribute WHERE attrelid='public.invoicing_cutover'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum")).rows)
        .toEqual([{attname:"source_kind"},{attname:"source_id"}]);
      expect((await pool.query("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='public.invoicing_cutover'::regclass AND contype='p'")).rows)
        .toEqual([{definition:"PRIMARY KEY (source_kind, source_id)"}]);
      expect((await pool.query("SELECT reloptions FROM pg_class WHERE oid='public.invoicing_due_sources'::regclass")).rows)
        .toEqual([{reloptions:["security_invoker=true"]}]);
      expect((await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN ('invoicing_capture_faults_source','invoicing_capture_faults_order','invoicing_duties_available') ORDER BY indexname")).rows)
        .toEqual([{indexname:"invoicing_capture_faults_order"},{indexname:"invoicing_capture_faults_source"},{indexname:"invoicing_duties_available"}]);
    }
    const keptSignatures = path.includes("durable_duties") ? [
      ["public.invoicing_duty_readback(uuid)",0], ["public.invoicing_claim_duties(integer,integer,text,uuid)",1],
    ] : path.includes("document_effects") ? [["public.invoicing_claim_deliveries(integer,integer,boolean,uuid)",1]]
      : path.includes("seller_revision") ? [["public.invoicing_claim_with_seller(integer,integer,text,jsonb,text,uuid)",1]] : [];
    for (const [signature,defaults] of keptSignatures) {
      expect((await pool.query("SELECT pronargdefaults FROM pg_proc WHERE oid=$1::regprocedure",[signature])).rows).toEqual([{pronargdefaults:defaults}]);
    }
    // Inspect actual ACL entries, including column ACLs and generated row types;
    // PUBLIC is grantee OID zero rather than a role in pg_roles.
    expect(forbidden).toEqual([]);
    const oldRelations = new Set(before.relations.map(row => row.oid));
    const oldTriggers = new Set(before.triggers.map(row => row.oid));
    const attached = after.triggers.filter(row => oldRelations.has(row.tgrelid) && !oldTriggers.has(row.oid));
    expect(attached.map(({ table_name, name, function_name }) => ({ table_name, name, function_name }))).toEqual(expectedTriggers[path] ?? []);
    const createdFunctions = new Set(newFunctions.map(row => row.oid));
    for (const trigger of attached) expect(createdFunctions.has(trigger.tgfoid)).toBe(true);
    if (path.endsWith("fulfillment_command_ledger.sql")) {
      // PostgreSQL and admission must agree on statement boundaries even when
      // delimiters appear in literals/comments, prefixed strings or operators.
      const lexicalSql = `-- misleading ' " $$ ; é
CREATE VIEW public.zz_lexical AS SELECT
  'it''s;--/*$$é'::text AS "double""quote", N'n;$$' AS national,
  B'10' AS bits, X'ff' AS hex, 'one'
  'two' AS continued, 1_000 + 0x1 +/* ; ' " $$ é */2 AS number;
CREATE FUNCTION public.zz_lexical_body() RETURNS text LANGUAGE sql SET search_path=pg_catalog AS $$ SELECT 'é;--/*$named$'; $$;
-- trailing ' " $$ ; é`;
      expect(() => assertPortableCreationStatements(Buffer.from(lexicalSql), [])).not.toThrow();
      const results = await pool.query(lexicalSql);
      expect(Array.isArray(results) && results.map(result => result.command)).toEqual(["CREATE", "CREATE"]);
      expect((await pool.query('SELECT "double""quote", national, bits::text, hex::text, continued, number, public.zz_lexical_body() AS body FROM public.zz_lexical')).rows).toEqual([
        { 'double"quote': "it's;--/*$$é", national: "n;$$", bits: "10", hex: "11111111", continued: "onetwo", number: 1003, body: "é;--/*$named$" },
      ]);
    }
}, 120_000);

it("applies all managed fixtures with exactly donor attributes, service-only ACLs and bounded catalog changes", async () => {
  await pool.query("CREATE ROLE service_role NOLOGIN");
  await pool.query("CREATE DATABASE reviewed_managed");
  const managed = new Pool({ connectionString: container!.connectionStringFor("reviewed_managed") });
  try {
    // Minimal public managed prerequisites on stock PostgreSQL. The complete
    // shipped baseline and preceding managed forwards execute without rewriting SQL.
    await managed.query(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT null::uuid $$;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT null::text $$;`);
    await managed.query(readFileSync("scripts/public-reference/subscription-prereqs.sql", "utf8"));
    const paths = (await import("node:fs")).readdirSync("supabase/migrations").filter(name => name < "20261022193000" && !managedTargetPaths.has(`supabase/migrations/${name}`)).sort();
    for (const name of paths) await managed.query(readFileSync(`supabase/migrations/${name}`, "utf8").replace(/^\\(?:un)?restrict .*$/gmu, ""));
    for (const entry of selected.managed) {
      const { bytes } = entry;
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
      const before = await snapshot(managed);
      await managed.query(bytes.toString("utf8"));
      const after = await snapshot(managed);
      const changedNames = new Set(entry.functions.filter(binding => binding.beforeSha256 !== null).map(binding => binding.signature.split("(")[0]));
      for (const kind of ["relations", "functions"] as const) {
        const current = new Map(after[kind].map(row => [row.oid, row]));
        for (const row of before[kind]) {
          if (kind === "functions" && "name" in row && changedNames.has(String(row.name))) {
            const next = current.get(row.oid)!;
            // Compatibility replaces the body/language intentionally; ownership,
            // return/defaults and actual ACL remain at the managed boundary.
            expect({ ...next, prosrc: "omitted" }).toEqual({ ...row, prosrc: "omitted" });
          } else expect(current.get(row.oid)).toEqual(row);
        }
      }
      expect(after.triggers).toEqual(before.triggers);
      for (const binding of entry.functions) {
        const result = (await managed.query(`SELECT p.prosecdef,p.proconfig,
          has_function_privilege('service_role',p.oid,'EXECUTE') AS service,
          has_function_privilege('anon',p.oid,'EXECUTE') AS anon,
          has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
          EXISTS(SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee=0) AS public
          FROM pg_proc p WHERE p.oid=$1::regprocedure`, [binding.signature])).rows;
        expect(result).toEqual([{ prosecdef: true, proconfig: ["search_path=public, pg_catalog"], service: true, anon: false, authenticated: false, public: false }]);
      }
      if (entry.path.includes("seller_revision")) expect((await managed.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.invoicing_managed_seller_revisions'::regclass")).rows).toEqual([{relrowsecurity:true}]);
      const oldRelations = new Set(before.relations.map(row => row.oid));
      for (const relation of after.relations.filter(row => !oldRelations.has(row.oid))) {
        expect((await managed.query(`SELECT x.grantee FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
          WHERE c.oid=$1 AND (x.grantee=0 OR x.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon','authenticated')))`, [relation.oid])).rows).toEqual([]);
      }
    }
  } finally { await managed.end(); }
}, 120_000);

const allTargets = [...pinned, ...registry.managedInvoicingForwards!];
function withTargetRoot(landed: Set<string>, check: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "reviewed-forward-bytes-"));
  try {
    for (const entry of allTargets) {
      const bytes = readFileSync(fixturePath(entry.path));
      for (const path of [fixturePath(entry.path), ...(landed.has(entry.path) ? [entry.path] : [])]) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), bytes);
      }
    }
    check(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

it.each(["full", "subset"])("selects landed bytes where present in a %s landing", mode => {
  const landed = new Set(allTargets.filter((_, index) => mode === "full" || index % 2 === 0).map(entry => entry.path));
  withTargetRoot(landed, root => {
    const result = selectPgGateTargets(root);
    expect([...result.native, ...result.managed].map(({ path, source, bytes }) => ({ path, source, bytes })))
      .toEqual(allTargets.map(({ path }) => ({
        path, source: landed.has(path) ? path : fixturePath(path), bytes: readFileSync(fixturePath(path)),
      })));
  });
});

it.each(allTargets)("refuses one-byte landed drift at $path", entry => {
  withTargetRoot(new Set([entry.path]), root => {
    writeFileSync(join(root, entry.path), Buffer.concat([readFileSync(join(root, entry.path)), Buffer.from(" ")]));
    expect(() => selectPinnedBytes(root, [entry])).toThrow(entry.path);
  });
});

it.each([
  "db/platform/migrations/20261022190000_invoicing_durable_duties.sql",
  "supabase/migrations/20261022193000_invoicing_correction_claims.sql",
])("plants one-byte drift in the PG setup selection at %s", path => {
  withTargetRoot(new Set([path]), root => {
    writeFileSync(join(root, path), Buffer.concat([readFileSync(join(root, path)), Buffer.from(" ")]));
    expect(() => selectPgGateTargets(root)).toThrow(path);
  });
});
