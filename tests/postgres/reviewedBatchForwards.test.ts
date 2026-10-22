import { readFileSync } from "node:fs";
import { reviewedBatchBytes, reviewedBatchPrefix } from "../../scripts/reviewed-batch-rail.js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertBatchedForward, readReviewedForwardRegistry, sqlSha256, type BatchedForwardBinding } from "../../scripts/reviewed-platform-forward.js";
import { dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";
import { readManagedMigrationChain } from "../../scripts/public-ci-pgtap.mjs";
import { assertBatchCatalog, assertSameSnapshot, batchSnapshot } from "./reviewedBatchCatalog.js";

const registry = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"));
const fixture = (pin: BatchedForwardBinding) => reviewedBatchBytes(process.cwd(), process.cwd(), pin);
const image = "public.ecr.aws/supabase/postgres:17.11.0.004";

// Always part of the required test aggregate. Neither absent Docker nor absent
// PostgreSQL/pgTAP can turn a control proof into a skipped test or lexical PASS.
describe.each(["native", "managed"] as const)("exact batch catalog gate: %s", graph => {
  const portable = graph === "native";
  const directory = portable ? "db/platform/migrations" : "supabase/migrations";
  const pins = registry.batchedForwards!.filter(pin => pin.path.startsWith(directory));
  let container: PostgresContainer | undefined;
  let db: Pool;
  const preceding: Buffer[] = [];
  beforeAll(async () => {
    if (!await dockerAvailable()) throw new Error("Reviewed batch gate requires real PostgreSQL and pgTAP");
    container = await runPostgresContainer({ name: `reviewed-batch-${graph}-${process.pid}`, password: "synthetic-conformance", image: portable ? "postgres:16" : image });
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Reviewed batch PostgreSQL unavailable");
    db = new Pool({ connectionString: portable ? container.connectionString : container.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:"), max: 1 });
    expect((await db.query("SHOW standard_conforming_strings")).rows).toEqual([{ standard_conforming_strings: "on" }]);
    if (!portable) {
      // Same prerequisites and default-ACL discipline as public-ci-pgtap.
      await db.query(readFileSync("scripts/public-reference/subscription-prereqs.sql", "utf8"));
      for (const role of ["postgres", "supabase_admin"]) for (const scope of ["", " IN SCHEMA public"]) for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
        await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${role}${scope} REVOKE ALL ON ${kind} FROM PUBLIC, anon, authenticated, service_role`);
      }
      await db.query(`CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
        DO $$ DECLARE fn regprocedure; BEGIN
          FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p
            JOIN pg_depend d ON d.objid=p.oid AND d.classid='pg_proc'::regclass
            JOIN pg_extension e ON e.oid=d.refobjid WHERE e.extname='pgtap' AND d.deptype='e'
          LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO postgres',fn); END LOOP;
        END $$;
        SET ROLE postgres; SET search_path=public,extensions; SELECT extensions.no_plan()`);
    }
    if (!portable) {
      readManagedMigrationChain(process.cwd()); // Verifies the committed complete managed prefix.
      expect(sqlSha256(readFileSync(`${directory}/00000000000000_platform_schema_baseline.sql`))).toBe(registry.baselineSha256);
    }
    for (const path of reviewedBatchPrefix(process.cwd(), directory, pins)) {
      const bytes = readFileSync(path);
      if (portable) {
        const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
        expect([manifest.baseline, ...manifest.forward].find(unit => unit.file === path).sha256).toBe(sqlSha256(bytes));
      }
      preceding.push(bytes);
      await db.query(bytes.toString().replace(/^\\(?:un)?restrict [A-Za-z0-9]+\r?$/gmu, ""));
    }
    // Reset dump session settings. Validate bodies of every new forward in PG.
    await db.query("SET check_function_bodies=on; SET search_path=public,extensions");
  }, 600_000); // Includes a first managed PG17 image pull and the complete prefix.
  afterAll(async () => { await db?.end(); await container?.remove(); });

  it.each(pins)("proves exact objects, ACLs and rows after the integrated prefix: $path", async pin => {
    const bytes = fixture(pin);
    assertBatchedForward(pin, bytes, preceding);
    const before = await batchSnapshot(db);
    await db.query("BEGIN");
    try {
      await db.query(bytes.toString());
      await assertBatchCatalog(db, pin, bytes, before, await batchSnapshot(db));
      if (!portable && pin.path.endsWith("20261022185000_provider_refund_evidence.sql")) {
        await db.query(`GRANT EXECUTE ON FUNCTION ${pin.functions[0]!.signature} TO authenticated`);
        await expect(assertBatchCatalog(db, pin, bytes, before, await batchSnapshot(db))).rejects.toThrow();
      }
    } finally { await db.query("ROLLBACK"); }
    assertSameSnapshot(before, await batchSnapshot(db));
    await db.query(bytes.toString());
    preceding.push(bytes);
    if (!portable) {
    const tap = (await db.query(`SELECT extensions.is(
      (SELECT count(*) FROM pg_proc WHERE oid=ANY(ARRAY(SELECT to_regprocedure(name) FROM unnest($1::text[]) name))),
      $2::bigint,$3::text) AS result`, [pin.functions.map(fn => fn.signature), pin.functions.length, `${pin.path}: exact pinned function identities exist`])).rows[0].result;
    expect(tap).toMatch(/^ok [0-9]+ - /u);
    }
  }, 120_000);

  if (!portable) it("keeps the exact notification seeds idempotent and preserves disabled local controls", async () => {
    const pin = pins.find(pin => pin.path.endsWith("20261022182000_subscription_lifecycle_message_scan.sql"))!;
    const seed = pin.statements.find(statement => statement.sql?.startsWith("INSERT INTO public.comms_notification_controls"))!.sql!;
    await db.query("BEGIN");
    try {
      await db.query("UPDATE public.comms_notification_controls SET enabled=false WHERE slug='subscription-stock-wait-started'");
      const before = await batchSnapshot(db);
      await db.query(seed); await db.query(seed);
      assertSameSnapshot(before,await batchSnapshot(db));
      const result = (await db.query(`SELECT extensions.is((SELECT enabled FROM public.comms_notification_controls
        WHERE slug='subscription-stock-wait-started'),false,'seed replay preserves disabled local control') AS result`)).rows[0].result;
      expect(result).toMatch(/^ok [0-9]+ - /u);
    } finally { await db.query("ROLLBACK"); }
  },120_000);

  it("proves the catalog observer rejects planted effects and pgTAP finishes cleanly", async () => {
    const pin = pins.at(-1)!;
    const bytes = fixture(pin);
    // Start from a proved chain; use an empty expected delta to falsify the
    // observer itself. The mutations are test-authored, not reviewer-authored.
    const empty = { ...pin, functions: [] };
    for (const attack of [
      "CREATE FUNCTION private.unpinned_control_probe() RETURNS text LANGUAGE sql AS $$ SELECT 'attack'; $$",
      "CREATE TABLE public.unpinned_control_probe(id integer)",
      "GRANT DELETE ON public.subscriptions TO anon",
      "ALTER TABLE public.subscriptions ADD COLUMN unpinned_control_probe integer",
      "INSERT INTO public.clients(id,email) VALUES ('d9000000-0000-4000-8000-000000000099','control-plant@example.invalid')",
    ]) {
      if (portable && attack.includes("private.")) continue; // Covered by the managed graph; native has no private schema.
      const before = await batchSnapshot(db);
      await db.query("BEGIN");
      try {
        await db.query(attack);
        await expect(assertBatchCatalog(db, empty, Buffer.alloc(0), before, await batchSnapshot(db)), attack).rejects.toThrow();
      } finally { await db.query("ROLLBACK"); }
      assertSameSnapshot(before, await batchSnapshot(db));
    }
    if (!portable) {
      const rows = (await db.query("SELECT * FROM extensions.finish() AS result")).rows;
      expect(rows.map(row => row.result)).toEqual([`1..${pins.length}`]);
    }
  }, 120_000);
});
