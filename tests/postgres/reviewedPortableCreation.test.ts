import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { beforeAll, expect, it } from "vitest";
import type { PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { assertPortableCreationStatements, readReviewedForwardRegistry } from "../../scripts/reviewed-platform-forward.js";
import { dockerAvailable, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";

const manifest: PlatformMigrationManifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
const pinned = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json")).portableCreationForwards!;
const fixtures = pinned.map(entry => ({ ...entry, bytes: readFileSync(`scripts/fixtures/${entry.path.split("/").at(-1)}`) }));
const expectedTriggers = [[], [
  { table_name: "public.commerce_order_holds", name: "trg_subscription_delivery_alignment_exception_case", function_name: "public.subscription_delivery_alignment_open_exception_case" },
  { table_name: "public.fulfillment_shipments", name: "trg_subscription_delivery_alignment_on_delivery", function_name: "public.subscription_delivery_alignment_on_delivery" },
  { table_name: "public.subscription_cycles", name: "trg_subscription_delivery_alignment_guard_cycle_insert", function_name: "public.subscription_delivery_alignment_guard_cycle_insert" },
]];

async function snapshot(pool: Pool) {
  const relations = (await pool.query(`SELECT c.oid, c.relacl::text, c.reloptions,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid) AS attributes
    FROM pg_class c ORDER BY c.oid`)).rows;
  const functions = (await pool.query(`SELECT p.oid, p.prosrc, p.proconfig, p.prosecdef, p.proacl::text,
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

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Reviewed portable creation catalog proof requires real PostgreSQL");
});

it.each(fixtures.map((fixture, index) => ({ ...fixture, index })))("preserves the catalog boundary of $path", async ({ path, sha256, bytes, index }) => {
  const container = await runPostgresContainer({ name: `reviewed-creation-${process.pid}-${index}`, password: "synthetic-conformance" });
  let pool: Pool | undefined;
  try {
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Reviewed portable creation PostgreSQL unavailable");
    pool = new Pool({ connectionString: container.connectionString });
    expect((await pool.query("SHOW standard_conforming_strings")).rows).toEqual([{ standard_conforming_strings: "on" }]);
    // Apply the canonical portable prefix, then any earlier pinned fixture. Never
    // install the proposed files into the real manifest or read another worktree.
    for (const unit of [manifest.baseline, ...manifest.forward].filter(unit => unit.file < path)) {
      const source = readFileSync(unit.file);
      expect(createHash("sha256").update(source).digest("hex")).toBe(unit.sha256);
      await pool.query(source.toString("utf8"));
    }
    for (const earlier of fixtures.slice(0, index)) {
      expect(createHash("sha256").update(earlier.bytes).digest("hex")).toBe(earlier.sha256);
      await pool.query(earlier.bytes.toString("utf8"));
    }
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
    const before = await snapshot(pool);
    await pool.query(bytes.toString("utf8"));
    const after = await snapshot(pool);
    for (const kind of ["relations", "functions"] as const) {
      const current = new Map(after[kind].map(row => [row.oid, row]));
      for (const row of before[kind]) expect(current.get(row.oid), `${path}: pre-existing ${kind} ${row.oid}`).toEqual(row);
    }
    const oldFunctions = new Set(before.functions.map(row => row.oid));
    const newFunctions = after.functions.filter(row => !oldFunctions.has(row.oid));
    expect(newFunctions.length).toBeGreaterThan(0);
    expect(newFunctions.filter(row => row.prosecdef)).toEqual([]);
    // Inspect actual ACL entries, including column ACLs and generated row types;
    // PUBLIC is grantee OID zero rather than a role in pg_roles.
    const forbidden = (await pool.query(`WITH new_acl AS (
      SELECT c.oid, 'relation' AS kind, c.relacl AS acl FROM pg_class c WHERE NOT (c.oid=ANY($1::oid[]))
      UNION ALL SELECT a.attrelid, 'column', a.attacl FROM pg_attribute a WHERE NOT (a.attrelid=ANY($1::oid[]))
      UNION ALL SELECT p.oid, 'function', p.proacl FROM pg_proc p WHERE NOT (p.oid=ANY($2::oid[]))
      UNION ALL SELECT t.oid, 'type', t.typacl FROM pg_type t WHERE NOT (t.oid=ANY($3::oid[]))
    ) SELECT n.oid, n.kind, x.privilege_type, x.grantee FROM new_acl n CROSS JOIN LATERAL aclexplode(n.acl) x
      WHERE x.grantee=0 OR x.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon','authenticated'))`,
    [before.relations.map(row => row.oid), before.functions.map(row => row.oid), before.types.map(row => row.oid)])).rows;
    expect(forbidden).toEqual([]);
    const oldRelations = new Set(before.relations.map(row => row.oid));
    const oldTriggers = new Set(before.triggers.map(row => row.oid));
    const attached = after.triggers.filter(row => oldRelations.has(row.tgrelid) && !oldTriggers.has(row.oid));
    expect(attached.map(({ table_name, name, function_name }) => ({ table_name, name, function_name }))).toEqual(expectedTriggers[index]);
    const createdFunctions = new Set(newFunctions.map(row => row.oid));
    for (const trigger of attached) expect(createdFunctions.has(trigger.tgfoid)).toBe(true);
    if (index === 0) {
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
  } finally {
    await pool?.end();
    await container.remove();
  }
}, 120_000);
