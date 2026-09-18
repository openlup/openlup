import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cachedForRun,
  DEFAULT_COMMAND_LABEL,
  ossReadinessRunToken,
  readinessWalkedFiles,
  runCacheEntryRef,
  runCacheKey,
  runCacheKeyInputs,
  runCacheStorePath,
  peekOssReadinessReportForRun,
  RUN_CACHE_ENABLED_ENV,
  WALK_ROOTS,
  WALK_SKIPPED_DIRECTORIES,
  withCommandLabel,
} from "../tests/setup/oss-readiness-run-cache.ts";

// Every assertion below runs against a throwaway fixture repository, never the real
// tree: the helper's contract is about keys, entries and the run token, and none of
// it needs the 5 s scan the helper exists to avoid.
const repoRoot = process.cwd();
const tokens: string[] = [];
let fixture = "";

const git = (...args: string[]) =>
  execFileSync("git", ["-C", fixture, "-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });

const write = (relativePath: string, content: string) => {
  const target = join(fixture, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
};

// The run store is a bare repository, so seeding an entry is git plumbing rather than a
// file write - which is also why neither this file nor the helper calls any fs read:
// `scripts/oss-publication-delta.ts:80` would classify one as an opaque source dependency
// edge and regenerate the pinned readiness catalog.
const store = (token: string, ...args: string[]) =>
  execFileSync("git", ["-C", runCacheStorePath(token), ...args], { encoding: "utf8" }).trim();
const seedBlob = (token: string, content: string) =>
  execFileSync("git", ["-C", runCacheStorePath(token), "hash-object", "-w", "--stdin"], { input: content, encoding: "utf8" }).trim();
const initStore = (token: string) =>
  execFileSync("git", ["init", "--bare", "--quiet", runCacheStorePath(token)], { stdio: "ignore" });

const probeToken = (suffix: string) => {
  const token = `run-cache-probe-${process.pid}-${suffix}`;
  tokens.push(token);
  return token;
};

beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), "readiness-run-cache-fixture-"));
  execFileSync("git", ["-C", fixture, "init", "-q", "-b", "main"]);
  write(".gitignore", "src/domains/generated/\n");
  write("src/domains/commerce/order.ts", "export const order = 1;\n");
  write("server/domains/commerce/port.ts", "export const port = 1;\n");
  write("docs/README.md", "# fixture\n");
  write("src/domains/generated/derived.ts", "export const derived = 1;\n");
  write("src/domains/node_modules/ignored-by-the-walk.ts", "export const skipped = 1;\n");
  git("add", ".gitignore", "src/domains/commerce/order.ts", "server/domains/commerce/port.ts", "docs/README.md");
  git("commit", "-q", "-m", "fixture tree");
});

afterAll(() => {
  for (const token of tokens) rmSync(join(tmpdir(), "oss-readiness-run-cache", token), { recursive: true, force: true });
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

describe("the readiness run cache replicates the scan's own inputs", () => {
  // The replica-versus-scanner pins (skipped directories, walked roots) live in
  // scripts/oss-readiness.test.ts, the scanner's own withheld suite: a retained test may
  // not import or read the withheld scanner, and that suite already may.
  it("walks gitignored files and skips the scanner's skipped directories", () => {
    const walked = readinessWalkedFiles(fixture);
    expect(walked).toContain("src/domains/generated/derived.ts");
    expect(walked).toContain("src/domains/commerce/order.ts");
    expect(walked).toContain("server/domains/commerce/port.ts");
    expect(walked.some((file) => file.includes("node_modules"))).toBe(false);
  });

  it("moves the key when a gitignored walked file changes, which no git status reports", () => {
    const token = probeToken("ignored");
    const before = runCacheKeyInputs(fixture, "probe", token);
    write("src/domains/generated/derived.ts", "export const derived = 2;\n");
    const after = runCacheKeyInputs(fixture, "probe", token);
    expect(after.porcelainDigest).toBe(before.porcelainDigest);
    expect(after.trackedIndexDigest).toBe(before.trackedIndexDigest);
    expect(after.walkedContentDigest).not.toBe(before.walkedContentDigest);
    expect(runCacheKey(fixture, "probe", token)).not.toBe(runCacheKey(fixture, "probe", token + "-other"));
  });

  it("moves the key when the porcelain status changes outside the walked set", () => {
    const token = probeToken("porcelain");
    const before = runCacheKeyInputs(fixture, "probe", token);
    const beforeKey = runCacheKey(fixture, "probe", token);
    write("docs/untracked-note.md", "noted\n");
    const after = runCacheKeyInputs(fixture, "probe", token);
    expect(after.walkedContentDigest).toBe(before.walkedContentDigest);
    expect(after.porcelainDigest).not.toBe(before.porcelainDigest);
    expect(runCacheKey(fixture, "probe", token)).not.toBe(beforeKey);
    rmSync(join(fixture, "docs/untracked-note.md"));
  });

  it("carries the run token, the root and the argument signature in the key inputs", () => {
    const token = probeToken("inputs");
    const inputs = runCacheKeyInputs(fixture, "probe", token);
    expect(inputs.runToken).toBe(token);
    expect(inputs.root).toBe(fixture);
    expect(inputs.slot).toBe("probe");
    expect(inputs.argumentSignature).toContain("boundaryOptions");
    expect(inputs.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(inputs.baseSha).toBe("<no base ref>");
    expect(runCacheKey(fixture, "probe", token)).not.toBe(runCacheKey(fixture, "other-slot", token));
  });

  it("derives a stable run token from the main process identity", () => {
    const token = ossReadinessRunToken();
    expect(token).not.toBeNull();
    expect(token).toMatch(/^\d+-[0-9a-f]{16}$/);
    expect(ossReadinessRunToken()).toBe(token);
  });
});

describe("the readiness run cache serves only its own run's entry", () => {
  it("computes once, serves the second caller, and refuses an entry with a foreign digest", () => {
    const token = probeToken("entry");
    let computed = 0;
    const compute = () => {
      computed += 1;
      return { generation: computed };
    };

    expect(cachedForRun(fixture, "probe", compute, token)).toEqual({ generation: 1 });
    expect(computed).toBe(1);
    expect(cachedForRun(fixture, "probe", compute, token)).toEqual({ generation: 1 });
    expect(computed).toBe(1);

    const key = runCacheKey(fixture, "probe", token);
    store(token, "update-ref", runCacheEntryRef(key), seedBlob(token, JSON.stringify({ key: "a-foreign-digest", value: { generation: 99 } })));
    expect(cachedForRun(fixture, "probe", compute, token)).toEqual({ generation: 2 });
    expect(computed).toBe(2);
    const published = store(token, "show", store(token, "rev-parse", runCacheEntryRef(key)));
    expect((JSON.parse(published) as { key: string }).key).toBe(key);
  });

  it("keeps one entry per key, so two keys in one run do not evict each other", () => {
    const token = probeToken("twokeys");
    let computed = 0;
    const compute = () => {
      computed += 1;
      return computed;
    };
    expect(cachedForRun(fixture, "probe", compute, token)).toBe(1);
    expect(cachedForRun(fixture, "other-slot", compute, token)).toBe(2);
    expect(cachedForRun(fixture, "probe", compute, token)).toBe(1);
    expect(cachedForRun(fixture, "other-slot", compute, token)).toBe(2);
    expect(computed).toBe(2);
  });

  it("lets two callers computing the same key at once both finish and keep the entry", () => {
    const token = probeToken("concurrent");
    initStore(token);
    const key = runCacheKey(fixture, "probe", token);
    // A second caller that publishes the same key while this one is still computing.
    // Nobody waits for anybody, so both finish; the later `update-ref` writes over the
    // earlier one with a value under the same key. The child is a shell and git alone:
    // the published tree refuses a source that spells a node entrypoint.
    const publisher = 'sleep 0.5; blob=$(printf %s "$3" | git -C "$1" hash-object -w --stdin); git -C "$1" update-ref "$2" "$blob"';
    spawn("sh", ["-c", publisher, "sh", runCacheStorePath(token), runCacheEntryRef(key), JSON.stringify({ key, value: { from: "the other caller" } })], { detached: true, stdio: "ignore" }).unref();
    let computed = 0;
    const started = Date.now();
    const mine = cachedForRun(fixture, "probe", () => {
      computed += 1;
      execFileSync("sleep", ["0.6"]);
      return { from: "this caller" };
    }, token);
    expect(mine).toEqual({ from: "this caller" });
    expect(computed).toBe(1);
    expect(Date.now() - started).toBeLessThan(10_000);

    const served = cachedForRun(fixture, "probe", () => {
      throw new Error("a published entry must not be recomputed");
    }, token);
    expect([{ from: "this caller" }, { from: "the other caller" }]).toContainEqual(served);
  });

  it("peeks without computing and reads the entry once a caller published one", () => {
    const token = ossReadinessRunToken();
    expect(token).not.toBeNull();
    const label = "a peeking caller";
    expect(peekOssReadinessReportForRun(fixture, label)).toBeNull();

    let computed = 0;
    const seeded = {
      errors: [],
      provenance: { status: "available", command: DEFAULT_COMMAND_LABEL },
      surfaceFamilies: [{ id: "core-package", command: DEFAULT_COMMAND_LABEL, selectedPaths: ["package.json"] }],
      closedNonProductionPaths: [{ file: "tests/x.ts", reason: "tests/" }],
    };
    // Published under this run's own token, because that is the only entry a peek reads;
    // the peek above published nothing, or this compute would not run.
    cachedForRun(fixture, "report", () => {
      computed += 1;
      return seeded;
    }, token);
    expect(computed).toBe(1);

    const peeked = peekOssReadinessReportForRun(fixture, label);
    expect(peeked?.provenance.command).toBe(label);
    expect(peeked?.surfaceFamilies.map((family) => family.id)).toEqual(["core-package"]);
    expect(peeked?.surfaceFamilies.map((family) => family.command)).toEqual([label]);
    expect(peeked?.closedNonProductionPaths).toEqual([{ file: "tests/x.ts", reason: "tests/" }]);
    store(token ?? "", "update-ref", "-d", runCacheEntryRef(runCacheKey(fixture, "report", token ?? "")));
  });

  it("computes without a cache when no run token can be established or the switch is off", () => {
    let computed = 0;
    const compute = () => {
      computed += 1;
      return computed;
    };
    expect(cachedForRun(fixture, "probe", compute, null)).toBe(1);
    expect(cachedForRun(fixture, "probe", compute, null)).toBe(2);
    const token = probeToken("switch");
    process.env[RUN_CACHE_ENABLED_ENV] = "off";
    try {
      expect(cachedForRun(fixture, "probe", compute, token)).toBe(3);
      expect(cachedForRun(fixture, "probe", compute, token)).toBe(4);
    } finally {
      delete process.env[RUN_CACHE_ENABLED_ENV];
    }
    expect(cachedForRun(fixture, "probe", compute, token)).toBe(5);
    expect(cachedForRun(fixture, "probe", compute, token)).toBe(5);
  });
});

describe("the command label the shared entry ignores", () => {
  // The default label and the "label reaches only provenance and the family rows" claim
  // are pinned end to end where the shared report is asserted with its label:
  // scripts/oss-readiness.test.ts checks `family.command` and `provenance.command` on
  // the report the helper re-labelled, so a drift in DEFAULT_COMMAND_LABEL or a label
  // that reached a computation would fail there against the real scan.
  it("re-applies a label without moving anything else in the report", () => {
    const seeded = {
      errors: ["one error"],
      notes: [],
      provenance: { status: "available", command: "first label", headSha: "abc" },
      surfaceFamilies: [
        { id: "core-package", command: "first label", selectedPaths: ["package.json"] },
        { id: "bff-api", command: "first label", selectedPaths: [] },
      ],
      closedNonProductionPaths: [{ file: "tests/x.ts", reason: "tests/" }],
    };

    const relabelled = withCommandLabel(seeded, "second label");
    expect(relabelled.provenance.command).toBe("second label");
    expect(relabelled.surfaceFamilies.map((family) => family.command)).toEqual(["second label", "second label"]);
    expect(withCommandLabel(relabelled, "first label")).toEqual(seeded);
  });
});
