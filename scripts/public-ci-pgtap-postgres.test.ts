import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import pins from "../config/ci-postgres-packages.json" with { type: "json" };
import ciImages from "../config/ci-images.json" with { type: "json" };
import { ensurePackages, INITDB_ARGS, parseArguments, pgProveArgs, replaySql, selectPackageFiles, SERVER_FLAGS } from "./public-ci-pgtap-postgres.mjs";

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
  it("uses the Supabase CLI 2.122.0 pg_prove argv (debug form) and the managed server settings", () => {
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
