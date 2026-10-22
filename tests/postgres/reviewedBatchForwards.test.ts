import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { reviewedBatchBytes, reviewedBatchPaths } from "../../scripts/reviewed-batch-rail.js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertBatchedForward, readReviewedForwardRegistry, sqlSha256, sqlStatements, type BatchedForwardBinding } from "../../scripts/reviewed-platform-forward.js";
import { dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";
import { readManagedMigrationChain } from "../../scripts/public-ci-pgtap.mjs";
import { assertBatchCatalog, assertSameSnapshot, batchSnapshot } from "./reviewedBatchCatalog.js";

const registry = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"));
const fixture = (pin: BatchedForwardBinding) => reviewedBatchBytes(process.cwd(), process.cwd(), pin);
const managedDigest = "sha256:b15d862126dd2dac02da524696ccfde2dcce2ceaee0a58973b2727befe492706";
// Rechecked 2026-10-22 with `docker buildx imagetools inspect` on Docker Hub :16;
// The ECR Docker Library fallback uses the same pinned OCI index.
const nativeDigest = "sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97";
const imageSources = {
  native: ["docker.io/library/postgres", "public.ecr.aws/docker/library/postgres"],
  managed: ["ghcr.io/supabase/postgres:17.11.0.004", "docker.io/supabase/postgres", "public.ecr.aws/supabase/postgres"],
};
const exec = promisify(execFile);
const imageIo = {
  pull: async (reference: string, timeout: number) => { await exec("docker", ["pull", reference], { timeout }); },
  repoDigests: async (reference: string): Promise<string[]> => {
    const { stdout } = await exec("docker", ["image", "inspect", reference, "--format", "{{json .RepoDigests}}"], { timeout: 5_000 });
    return JSON.parse(stdout);
  },
  sleep: async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)); },
  now: () => Date.now(),
};

async function pullPinnedImage(graph: keyof typeof imageSources, io = imageIo): Promise<string> {
  const digest = graph === "native" ? nativeDigest : managedDigest;
  const deadline = io.now() + 120_000;
  const failures: string[] = [];
  for (const source of imageSources[graph]) {
    const reference = `${source}@${digest}`;
    for (let attempt = 0; attempt < 3 && io.now() < deadline; attempt += 1) {
      try {
        await io.pull(reference, Math.min(30_000, deadline - io.now()));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Only transient pull failures may retry or fall through to another registry.
        if (!/toomanyrequests|too many requests|429|timed?\s*out|timeout|ETIMEDOUT|ECONN|ENOTFOUND|EAI_AGAIN|no such host|connection|network|TLS handshake|\bEOF\b/iu.test(message)
          && !(error instanceof Error && "killed" in error && error.killed === true)) throw error;
        failures.push(`${reference} attempt ${attempt + 1}: ${message}`);
        if (attempt < 2) {
          // Docker registries report seconds or Go-style subsecond durations.
          // The remaining global budget caps the wait; never pull again after expiry.
          const retryAfter = /retry-after:\s*(\d+(?:\.\d+)?)\s*(ns|[µμu]s|ms|s(?:ec(?:ond)?s?)?)?(?![\wµμ])/iu.exec(message);
          const unit = retryAfter?.[2]?.toLowerCase();
          const retryMs = retryAfter ? Number(retryAfter[1]) * (unit === "ns" ? 0.000001
            : unit && ["µs", "μs", "us"].includes(unit) ? 0.001 : unit === "ms" ? 1 : 1_000) : 0;
          await io.sleep(Math.min(Math.max(1_000 * (attempt + 1), retryMs), Math.max(0, deadline - io.now())));
        }
        continue;
      }
      // Inspect and all subsequent container/SQL errors are outside the retry scope.
      // Docker omits docker.io/library for official-image RepoDigest names.
      const canonical = (value: string) => value.replace(/^docker\.io\/(?:library\/)?/u, "").replace(/:[^/@]+@/u, "@");
      expect((await io.repoDigests(reference)).map(canonical), "pulled image must have the exact pinned RepoDigest").toContain(canonical(reference));
      return reference;
    }
  }
  throw new Error(`Reviewed batch gate could not pull pinned ${graph} image within 120s; no source succeeded:\n${failures.join("\n")}`);
}

describe("pinned image selection (Docker-free)", () => {
  const witness = () => {
    const pulls: string[] = [];
    const waits: number[] = [];
    let elapsed = 0;
    const io = {
      pull: async (reference: string, _timeout: number) => { pulls.push(reference); },
      repoDigests: async (reference: string) => [reference],
      sleep: async (ms: number) => { waits.push(ms); elapsed += ms; },
      now: () => elapsed,
    };
    return { io, pulls, waits };
  };
  it("keeps the approved source order and pins", () => {
    expect(imageSources).toEqual({
      native: ["docker.io/library/postgres", "public.ecr.aws/docker/library/postgres"],
      managed: ["ghcr.io/supabase/postgres:17.11.0.004", "docker.io/supabase/postgres", "public.ecr.aws/supabase/postgres"],
    });
    expect(nativeDigest).toBe("sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97");
    expect(managedDigest).toBe("sha256:b15d862126dd2dac02da524696ccfde2dcce2ceaee0a58973b2727befe492706");
  });
  it.each(["native", "managed"] as const)("uses the first pinned source for %s", async graph => {
    const { io, pulls, waits } = witness();
    const reference = await pullPinnedImage(graph, io);
    expect(reference).toBe(`${imageSources[graph][0]}@${graph === "native" ? nativeDigest : managedDigest}`);
    expect(pulls).toEqual([reference]);
    expect(waits).toEqual([]);
  });
  it.each(["native", "managed"] as const)("bounds retries and preserves source order on %s rate limits", async graph => {
    const { io, pulls, waits } = witness();
    io.pull = async reference => { pulls.push(reference); throw new Error("toomanyrequests: 429"); };
    await expect(pullPinnedImage(graph, io)).rejects.toThrow("no source succeeded");
    expect(pulls).toEqual(imageSources[graph].flatMap(source => Array<string>(3).fill(`${source}@${graph === "native" ? nativeDigest : managedDigest}`)));
    expect(waits).toEqual(imageSources[graph].flatMap(() => [1_000, 2_000]));
  });
  it.each([
    ["736.176µs", 1_000], ["736.176μs", 1_000], ["1500ms", 1_500],
    ["4", 4_000], ["4.5s", 4_500], ["5 seconds", 5_000],
  ] as const)("honours retry-after %s with a fake clock", async (value, delay) => {
    const { io, pulls, waits } = witness();
    io.pull = async reference => {
      pulls.push(reference);
      if (pulls.length === 1) throw new Error(`toomanyrequests: 429; retry-after: ${value}`);
    };
    await pullPinnedImage("managed", io);
    expect(waits).toEqual([delay]);
    expect(io.now()).toBe(delay);
    expect(pulls).toHaveLength(2);
  });
  it("caps Retry-After at the total budget and makes no later pull", async () => {
    const { io, pulls, waits } = witness();
    io.pull = async reference => { pulls.push(reference); throw new Error("429; retry-after: 300"); };
    await expect(pullPinnedImage("managed", io)).rejects.toThrow("no source succeeded");
    expect(waits).toEqual([120_000]);
    expect(io.now()).toBe(120_000);
    expect(pulls).toHaveLength(1);
  });
  it("uses a successful fallback after exhausting a rate-limited source", async () => {
    const { io, pulls } = witness();
    io.pull = async reference => { pulls.push(reference); if (reference.startsWith("ghcr.io/")) throw new Error("toomanyrequests"); };
    expect(await pullPinnedImage("managed", io)).toBe(`${imageSources.managed[1]}@${managedDigest}`);
    expect(pulls).toHaveLength(4);
  });
  it("bounds the whole pull phase even when every pull times out", async () => {
    const { io, pulls } = witness();
    io.pull = async (reference, timeout) => { pulls.push(reference); await io.sleep(timeout); throw new Error("connection timed out"); };
    await expect(pullPinnedImage("managed", io)).rejects.toThrow("within 120s");
    expect(io.now()).toBe(120_000);
    expect(pulls.length).toBeLessThanOrEqual(9);
  });
  it("refuses a digest mismatch without retry or fallback", async () => {
    const { io, pulls } = witness();
    io.repoDigests = async () => [`${imageSources.managed[0]}@${nativeDigest}`];
    await expect(pullPinnedImage("managed", io)).rejects.toThrow("exact pinned RepoDigest");
    expect(pulls).toHaveLength(1);
  });
  it("accepts a tagged pull's untagged RepoDigest spelling", async () => {
    const { io } = witness();
    io.repoDigests = async () => [`ghcr.io/supabase/postgres@${managedDigest}`];
    expect(await pullPinnedImage("managed", io)).toBe(`${imageSources.managed[0]}@${managedDigest}`);
  });
  it("accepts Docker's canonical official-image RepoDigest spelling", async () => {
    const { io } = witness();
    io.repoDigests = async () => [`postgres@${nativeDigest}`];
    expect(await pullPinnedImage("native", io)).toBe(`${imageSources.native[0]}@${nativeDigest}`);
  });
  it("does not retry inspection failures", async () => {
    const { io, pulls } = witness();
    io.repoDigests = async () => { throw new Error("connection reset during inspect"); };
    await expect(pullPinnedImage("managed", io)).rejects.toThrow("connection reset during inspect");
    expect(pulls).toHaveLength(1);
  });
  it("does not retry a non-transient pull failure", async () => {
    const { io, pulls, waits } = witness();
    io.pull = async reference => { pulls.push(reference); throw new Error("manifest unknown"); };
    await expect(pullPinnedImage("native", io)).rejects.toThrow("manifest unknown");
    expect(pulls).toHaveLength(1);
    expect(waits).toEqual([]);
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
