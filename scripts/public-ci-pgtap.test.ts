import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import pins from "../config/ci-postgres-packages.json" with { type: "json" };
import ciImages from "../config/ci-images.json" with { type: "json" };
import { ensurePackages, INITDB_ARGS, parseArguments, pgProveArgs, replaySql, selectPackageFiles, SERVER_FLAGS } from "./public-ci-pgtap.mjs";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const temporary = () => { const directory = mkdtempSync(join(tmpdir(), "pgtap-debs-")); directories.push(directory); return directory; };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("pinned extension packages", () => {
  it("pins the managed extension versions for the install-proof PostgreSQL 17 image on both CI and local architectures", () => {
    expect(ciImages.images.some(image => image.name === pins.image && image.tag === "17")).toBe(true);
    expect(pins.packages.map(pin => pin.provides)).toEqual(["pg_cron 1.6.4", "pgtap 1.3.3", "pg_prove 3.36"]);
    for (const architecture of ["amd64", "arm64"]) {
      const files = selectPackageFiles(pins, architecture);
      for (const file of files) expect(file.url).toMatch(/^https:\/\/apt-archive\.postgresql\.org\/pub\/repos\/apt\/pool\/main\/[a-z]+\/[a-z0-9-]+\/[a-z0-9.-]+_[0-9.]+-\d\.pgdg130%2B\d_(?:all|amd64|arm64)\.deb$/u);
      expect(files.every(file => file.name.endsWith(`_${architecture}.deb`) || file.name.endsWith("_all.deb"))).toBe(true);
    }
  });

  it("refuses an unpinned architecture, a mutable base or a path that does not match its version", () => {
    expect(() => selectPackageFiles(pins, "ppc64el")).toThrow(/no pinned postgresql-17-cron package for ppc64el/u);
    expect(() => selectPackageFiles({ ...pins, baseUrl: "http://apt.postgresql.org/pub/" }, "amd64")).toThrow(/invalid package base URL/u);
    const drifted = structuredClone(pins);
    drifted.packages[1].version = "1.3.4-1.pgdg13+1";
    expect(() => selectPackageFiles(drifted, "amd64")).toThrow(/does not match postgresql-17-pgtap/u);
    const malformed = structuredClone(pins);
    malformed.packages[2].files.all.sha256 = "0".repeat(63);
    expect(() => selectPackageFiles(malformed, "amd64")).toThrow(/malformed package pin/u);
  });
});

describe("verified package cache", () => {
  const file = { name: "pkg_1_all.deb", url: "https://apt-archive.postgresql.org/pub/repos/apt/pool/main/p/pkg_1_all.deb", sha256: sha("good") };

  it("downloads once, verifies before writing, and reuses only matching cached bytes", async () => {
    const cache = temporary();
    const calls: string[] = [];
    const fetcher = async (url: string) => { calls.push(url); return new Response("good"); };
    expect(await ensurePackages([file], cache, fetcher)).toEqual([file.name]);
    expect(await ensurePackages([file], cache, fetcher)).toEqual([file.name]);
    expect(calls).toEqual([file.url]);
    writeFileSync(join(cache, file.name), "tampered");
    await ensurePackages([file], cache, fetcher);
    expect(calls).toHaveLength(2);
    expect(readFileSync(join(cache, file.name), "utf8")).toBe("good");
  });

  it("refuses mismatching bytes without writing them and retries a transient failure once", async () => {
    const cache = temporary();
    await expect(ensurePackages([file], cache, async () => new Response("evil"))).rejects.toThrow(/checksum mismatch for pkg_1_all.deb/u);
    expect(() => readFileSync(join(cache, file.name))).toThrow();
    let attempts = 0;
    await expect(ensurePackages([file], cache, async () => { attempts += 1; return attempts === 1 ? new Response("", { status: 503 }) : new Response("good"); })).resolves.toEqual([file.name]);
    await expect(ensurePackages([{ ...file, name: "other_1_all.deb" }], cache, async () => new Response("", { status: 404 }))).rejects.toThrow(/cannot download .*HTTP 404/u);
  });
});

describe("runner contract", () => {
  it("keeps the retired CLI lane's pg_prove argv (debug form) and the managed server settings", () => {
    expect(pgProveArgs("/work/tests")).toEqual(["pg_prove", "--ext", ".pg", "--ext", ".sql", "-r", "/work/tests", "--verbose"]);
    expect(SERVER_FLAGS).toEqual(["-c", "shared_preload_libraries=pg_cron", "-c", "cron.database_name=postgres", "-c", "timezone=UTC", "-c", "extra_float_digits=0"]);
    expect(INITDB_ARGS).toContain("--auth-host=scram-sha-256");
    expect(INITDB_ARGS).toContain("--icu-locale=en-US");
  });

  it("replays adapter, prerequisites, revocation and the chain as postgres, then the test extensions and grants", () => {
    const sql = replaySql({ adapter: "-- adapter", prereqs: "-- prereqs", migrations: [{ name: "a.sql", contents: "-- first" }, { name: "b.sql", contents: "-- second" }] });
    const order = ["-- adapter", "SET ROLE supabase_admin;", "-- prereqs", "ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE ALL ON TABLES", "SET ROLE postgres;", "-- first", "-- second", "CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions", "GRANT EXECUTE ON FUNCTION %s TO PUBLIC"];
    const positions = order.map(fragment => sql.indexOf(fragment));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(sql.match(/ALTER DEFAULT PRIVILEGES FOR ROLE/gu)).toHaveLength(12);
  });

  it("accepts only the planned sabotage switches", () => {
    expect(parseArguments([])).toEqual({ sabotage: undefined });
    expect(parseArguments(["--sabotage", "no-pg-cron"])).toEqual({ sabotage: "no-pg-cron" });
    expect(() => parseArguments(["--sabotage", "nope"])).toThrow(/unknown sabotage/u);
    expect(() => parseArguments(["--fast"])).toThrow(/usage/u);
  });
});

describe("owned pgTAP command lifecycle", () => {
  type Call = { stage: string; args: string[]; input: string };
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const baseline = "00000000000000_platform_schema_baseline.sql", forward = "20260927090000_forward.sql";
  const migrations: Record<string, string> = { [baseline]: "SELECT 'baseline replay';\n", [forward]: "SELECT 'ordered forward';\n" };
  // Execute the shipped runner with git and docker replaced on PATH. The subprocess
  // cannot reach the host's Docker daemon, a registry or the package archive.
  const standIn = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const environment = Reflect.get(process, "env");
const scenario = environment.PGTAP_STAND_IN_SCENARIO;
const input = args.includes("-i") ? fs.readFileSync(0, "utf8") : "";
const stage = command === "git" ? "inventory" : args[0] === "info" ? "info" : args[0] === "image" ? "image" : args[0] === "run" ? "run"
  : args[0] === "rm" ? "rm" : args[0] === "inspect" ? "running" : args[0] === "logs" ? "logs" : args.includes("pg_isready") ? "ready"
  : args.includes("pg_prove") ? "prove" : args.includes("-1") ? "replay" : args.includes("-Atq") ? "capture" : "other";
fs.appendFileSync(environment.PGTAP_STAND_IN_LOG, JSON.stringify({ stage, args, input }) + "\\n");
const fail = (code, message) => { process.stderr.write(message); process.exit(code); };
if (stage === "inventory") process.stdout.write(JSON.parse(environment.PGTAP_STAND_IN_INVENTORY));
else if (stage === "info") process.stdout.write("x86_64\\n");
else if (stage === "image") process.stdout.write(JSON.stringify([args[2]]));
else if (stage === "run") scenario === "run" ? fail(125, "stand-in run failure") : process.stdout.write("container-id\\n");
else if (stage === "ready" && scenario === "not-ready") fail(2, "no response");
else if (stage === "running") process.stdout.write("false\\n");
else if (stage === "replay" && scenario === "replay") fail(3, "ERROR: stand-in replay failure");
else if (stage === "capture") process.stdout.write("section\\titem\\u001e");
else if (stage === "prove") { process.stdout.write("first_test.sql .. ok\\nAll tests successful.\\n"); if (scenario === "prove") fail(1, "stand-in assertion failure"); }
else if (stage === "rm" && scenario === "cleanup") fail(1, "stand-in cleanup failure");
`;
  function observe(scenario: string, check: (status: number | null, stderr: string, calls: Call[], directory: string) => void) {
    const scratch = join(ROOT, ".context/scratch");
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "pgtap-lifecycle-test-"));
    try {
      // The extensionless CommonJS stand-ins must not inherit the root ESM package type.
      writeFileSync(join(directory, "package.json"), '{"type":"commonjs"}\n');
      for (const folder of ["scripts/public-reference", "config", "supabase/migrations", "supabase/tests", "tests/postgres/managed-compat", "bin", "debs"]) mkdirSync(join(directory, folder), { recursive: true });
      for (const file of ["public-ci-pgtap.mjs", "ci-image-pull.mjs", "ci-image-mirror.mjs", "disposable-docker.mjs", "pgtap-parity.mjs"]) writeFileSync(join(directory, "scripts", file), readFileSync(join(ROOT, "scripts", file)));
      writeFileSync(join(directory, "config/ci-images.json"), readFileSync(join(ROOT, "config/ci-images.json")));
      // Synthetic packages whose committed-form checksums match the cached bytes, so no download happens.
      const packages = structuredClone(pins);
      for (const pin of packages.packages) for (const file of Object.values(pin.files) as Array<{ path: string; sha256: string }>) {
        const bytes = `synthetic ${file.path}`;
        file.sha256 = sha(bytes);
        writeFileSync(join(directory, "debs", file.path.split("/").at(-1)!), bytes);
      }
      writeFileSync(join(directory, "config/ci-postgres-packages.json"), JSON.stringify(packages));
      writeFileSync(join(directory, "tests/postgres/managed-compat/supabase.sql"), "SELECT 'adapter';\n");
      writeFileSync(join(directory, "scripts/public-reference/subscription-prereqs.sql"), "SELECT 'prerequisites';\n");
      for (const [name, bytes] of Object.entries(migrations)) writeFileSync(join(directory, "supabase/migrations", name), bytes);
      if (scenario === "inventory") writeFileSync(join(directory, "supabase/migrations", forward), "SELECT 'uncommitted';\n");
      writeFileSync(join(directory, "supabase/tests/first_test.sql"), "BEGIN; SELECT 'first assertion'; ROLLBACK;\n");
      for (const command of ["git", "docker"]) {
        writeFileSync(join(directory, "bin", command), standIn);
        chmodSync(join(directory, "bin", command), 0o755);
      }
      const inventory = Object.entries(migrations).map(([name, bytes]) => `100644 blob ${createHash("sha1").update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest("hex")}\tsupabase/migrations/${name}\0`).join("");
      const log = join(directory, "calls.jsonl");
      writeFileSync(log, "");
      const result = spawnSync(process.execPath, [join(directory, "scripts/public-ci-pgtap.mjs")], {
        cwd: directory, encoding: "utf8", timeout: 25_000,
        env: { PATH: join(directory, "bin"), OPENLUP_PGTAP_DEB_CACHE: join(directory, "debs"), PGTAP_STAND_IN_SCENARIO: scenario, PGTAP_STAND_IN_LOG: log, PGTAP_STAND_IN_INVENTORY: JSON.stringify(inventory) },
      });
      expect(result.error).toBeUndefined();
      const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Call);
      check(result.status, result.stderr, calls, directory);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  const container = (calls: Call[]) => calls.find(({ stage }) => stage === "run")!.args[calls.find(({ stage }) => stage === "run")!.args.indexOf("--name") + 1];
  const removedRunDirectories = (directory: string) => expect(readdirSync(join(directory, ".context/scratch/pgtap")).filter(name => name.startsWith("run-"))).toEqual([]);

  it("replays the committed chain in one transaction, runs every test file and removes its own container", () => {
    observe("pass", (status, stderr, calls, directory) => {
      expect(status, stderr).toBe(0);
      expect(calls.map(({ stage }) => stage)).toEqual(["inventory", "info", "image", "run", "ready", "replay", "capture", "capture", "prove", "rm"]);
      const run = calls.find(({ stage }) => stage === "run")!.args;
      expect(container(calls)).toMatch(/^openlup-pgtap-[a-f0-9]{12}$/u);
      expect(run).toEqual(expect.arrayContaining(["--pull=never", "--tmpfs", "/var/lib/postgresql/data", "POSTGRES_USER=ci_bootstrap", "dev.disposable=1", ...SERVER_FLAGS]));
      expect(run.some(arg => arg.startsWith("ghcr.io/openlup/library/postgres:17@sha256:"))).toBe(true);
      const replay = calls.find(({ stage }) => stage === "replay")!;
      expect(replay.args).toEqual(expect.arrayContaining(["-1", "ON_ERROR_STOP=1", "ci_bootstrap"]));
      const order = ["SELECT 'adapter';", "SELECT 'prerequisites';", "SELECT 'baseline replay';", "SELECT 'ordered forward';", "CREATE EXTENSION IF NOT EXISTS pgtap"];
      expect(order.map(fragment => replay.input.indexOf(fragment)).every((position, index, all) => position >= 0 && (index === 0 || position > all[index - 1]!))).toBe(true);
      expect(calls.find(({ stage }) => stage === "prove")!.args.slice(-8)).toEqual(pgProveArgs("/work/tests"));
      expect(calls.at(-1)!.args).toEqual(["rm", "-f", "-v", container(calls)]);
      expect(readFileSync(join(directory, ".context/scratch/pgtap/latest.log"), "utf8")).toContain("All tests successful.");
      removedRunDirectories(directory);
    });
  });

  it("refuses uncommitted migration bytes before any Docker operation", () => {
    observe("inventory", (status, stderr, calls) => {
      expect(status).toBe(1);
      expect(stderr).toContain("managed migration bytes differ from committed candidate");
      expect(calls.map(({ stage }) => stage)).toEqual(["inventory"]);
    });
  });

  it.each([
    ["replay", 1, ["inventory", "info", "image", "run", "ready", "replay", "rm"]],
    ["prove", 1, ["inventory", "info", "image", "run", "ready", "replay", "capture", "capture", "prove", "rm"]],
    ["not-ready", 1, ["inventory", "info", "image", "run", "ready", "running", "logs", "rm"]],
    ["cleanup", 1, ["inventory", "info", "image", "run", "ready", "replay", "capture", "capture", "prove", "rm"]],
  ])("fails %s with exit %i and still removes only its own container", (scenario, code, stages) => {
    observe(scenario, (status, stderr, calls, directory) => {
      expect(status, stderr).toBe(code);
      expect(calls.map(({ stage }) => stage)).toEqual(stages);
      expect(calls.at(-1)!.args).toEqual(["rm", "-f", "-v", container(calls)]);
      if (scenario === "cleanup") expect(stderr).toContain("Owned container cleanup failed");
      removedRunDirectories(directory);
      expect(existsSync(join(directory, ".context/scratch/pgtap"))).toBe(true);
    });
  });
});
