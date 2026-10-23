import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { reviewedBatchBytes, reviewedBatchPaths } from "../../scripts/reviewed-batch-rail.js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertBatchedForward, readReviewedForwardRegistry, sqlSha256, sqlStatements, type BatchedForwardBinding } from "../../scripts/reviewed-platform-forward.js";
import { dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";
import { imageIo, imageReference, pullWithRetry, readCiImage } from "../../scripts/ci-image-pull.mjs";
import { readManagedMigrationChain } from "../../scripts/public-ci-pgtap.mjs";
import { assertBatchCatalog, assertSameSnapshot, batchSnapshot } from "./reviewedBatchCatalog.js";

const registry = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"));
const fixture = (pin: BatchedForwardBinding) => reviewedBatchBytes(process.cwd(), process.cwd(), pin);
const managedImage = readCiImage("managed-batch-postgres"), nativeImage = readCiImage("test-postgres");
async function pullPinnedImage(graph: "native" | "managed", io = imageIo): Promise<string> {
  return pullWithRetry(graph === "native" ? nativeImage : managedImage, io);
}

describe("pinned image selection (Docker-free)", () => {
  it.each(["native", "managed"] as const)("reuses the exact local gate pin for %s without pulling", async graph => {
    const image = graph === "native" ? nativeImage : managedImage;
    const reference = imageReference(image, image.sources.at(-1));
    const pulls: string[] = [];
    const io = {
      exec: async (args: string[]) => {
        if (args[0] === "pull") pulls.push(args[1]);
        if (args[2] !== reference) throw new Error("No such image");
        return JSON.stringify([reference]);
      },
      sleep: async () => { throw new Error("warm gate must not wait"); },
      now: () => 0,
    };
    expect(await pullPinnedImage(graph, io)).toBe(reference);
    expect(pulls).toEqual([]);
  });
});

// Always part of the required test aggregate. Neither absent Docker nor absent
// PostgreSQL/pgTAP can turn a control proof into a skipped test or lexical PASS.
describe.each(["native", "managed"] as const)("exact batch catalog gate: %s", graph => {
  const portable = graph === "native";
  const directory = portable ? "db/platform/migrations" : "supabase/migrations";
  const pins = registry.batchedForwards!.filter(pin => pin.path.startsWith(directory));
  let container: PostgresContainer | undefined;
  let db: Pool;
  const preceding: Buffer[] = [];
  let replayRoot: string;
  let paths: string[];
  let interleaved: string;
  const applyCommittedBefore = async (limit: string) => {
    for (const path of paths.filter(path => path < limit && !pins.some(pin => pin.path === path))) {
      const bytes = readFileSync(join(replayRoot, path));
      if (portable && path !== interleaved) {
        const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
        expect([manifest.baseline, ...manifest.forward].find(unit => unit.file === path).sha256).toBe(sqlSha256(bytes));
      }
      preceding.push(bytes);
      await db.query(bytes.toString().replace(/^\\(?:un)?restrict [A-Za-z0-9]+\r?$/gmu, ""));
    }
    paths = paths.filter(path => path >= limit);
  };
  beforeAll(async () => {
    // Refuse holes before any fixture can fill a missing predecessor.
    reviewedBatchPaths(process.cwd(), directory, pins);
    for (const pin of pins) fixture(pin);
    replayRoot = mkdtempSync(join(tmpdir(), "openlup-batch-pg-"));
    cpSync(directory, join(replayRoot, directory), { recursive: true });
    // Stay between the 18:00 pin and the next pin on either rail without replacing committed bytes.
    const free = Array.from({ length: 60 }, (_, second) => `${directory}/202610221805${String(second).padStart(2, "0")}_unpinned_gate_probe.sql`)
      .find(path => !existsSync(join(replayRoot, path)));
    if (!free) throw new Error("Reviewed batch gate has no free interleaved probe filename");
    interleaved = free;
    writeFileSync(join(replayRoot, interleaved), "SELECT set_config('openlup.batch_interleaved', 'applied', false);", { flag: "wx" });
    paths = reviewedBatchPaths(replayRoot, directory, pins);
    if (!await dockerAvailable()) throw new Error("Reviewed batch gate requires real PostgreSQL and pgTAP");
    const image = await pullPinnedImage(graph);
    container = await runPostgresContainer({ name: `reviewed-batch-${graph}-${process.pid}`, password: "synthetic-conformance", image });
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
    await applyCommittedBefore(pins[0]!.path);
    // Reset dump session settings. Validate bodies of every new forward in PG.
    await db.query("SET check_function_bodies=on; SET search_path=public,extensions");
  }, 600_000); // Includes a first managed PG17 image pull and the complete prefix.
  afterAll(async () => { await db?.end(); await container?.remove(); if (replayRoot) rmSync(replayRoot, { recursive: true, force: true }); });

  it.each(pins)("proves exact objects, ACLs and rows after the integrated prefix: $path", async pin => {
    await applyCommittedBefore(pin.path);
    if (pin.path > interleaved) expect((await db.query("SELECT current_setting('openlup.batch_interleaved') AS value")).rows).toEqual([{ value: "applied" }]);
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
    const attacks = portable && pin.path.includes("20261022184000")
      ? [`REVOKE EXECUTE ON FUNCTION ${pin.functions[0]!.signature} FROM PUBLIC;`]
      : !portable && pin.path.includes("20261022175000")
        ? ["CREATE INDEX unpinned_existing_table_index ON public.subscriptions(id);"] : [];
    for (const attack of attacks) {
      const sql = bytes.toString() + "\n" + attack;
      const repinned = { ...pin, sha256: sqlSha256(sql), statements: sqlStatements(sql).map(statement => ({ sha256: sqlSha256(statement), ...(!/^CREATE(?: OR REPLACE)? FUNCTION /u.test(statement) ? { sql: statement } : {}) })) };
      if (!portable) expect(() => assertBatchedForward(repinned, Buffer.from(sql), preceding)).not.toThrow();
      await db.query("BEGIN");
      try {
        await db.query(sql);
        await expect(assertBatchCatalog(db, repinned, Buffer.from(sql), before, await batchSnapshot(db)), attack).rejects.toThrow();
      } finally { await db.query("ROLLBACK"); }
      assertSameSnapshot(before, await batchSnapshot(db));
    }
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
  it("ignores vacuum freeze bookkeeping in catalog snapshots", async () => {
    await db.query("RESET ROLE");
    try {
      const before = await batchSnapshot(db);
      await db.query("VACUUM (FREEZE) pg_catalog.pg_class, pg_catalog.pg_proc");
      assertSameSnapshot(before, await batchSnapshot(db));
    } finally { if (!portable) await db.query("SET ROLE postgres"); }
  }, 120_000);
});

it.each([
  ["db/platform/migrations", "20261022184000", "20261022183000"],
  ["supabase/migrations", "20261022184000", "20261022175000"],
  ["supabase/migrations", "20261022185000", "20261022175000"],
])("refuses a landed later pin over an absent predecessor: %s %s", (directory, later, missing) => {
  const root = mkdtempSync(join(tmpdir(), "openlup-batch-pg-hole-"));
  const pins = registry.batchedForwards!.filter(pin => pin.path.startsWith(directory));
  try {
    for (const pin of pins.filter(pin => later.includes("185000") ? pin.path.includes(later) || pin.path < `${directory}/20261022170000` : pin.path <= pins.find(pin => pin.path.includes(later))!.path && !pin.path.includes(missing))) {
      mkdirSync(dirname(join(root, pin.path)), { recursive: true });
      writeFileSync(join(root, pin.path), fixture(pin));
    }
    expect(pins.some(pin => pin.path.includes(missing))).toBe(true);
    expect(() => reviewedBatchPaths(root, directory, pins)).toThrow("reviewed batch requires every earlier same-rail pin landed first");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
