import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_QUARANTINE_PATH,
  loadCiQuarantine,
  splitQuarantinedFiles,
  validateQuarantineActive,
} from "./ci-quarantine.mjs";

const tempDirs: string[] = [];

function createFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ci-quarantine-test-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "config"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts/alpha.test.ts"), "// alpha\n", "utf8");
  writeFileSync(join(dir, "scripts/beta.test.ts"), "// beta\n", "utf8");
  return dir;
}

function writeManifest(dir: string, payload: unknown, relPath = DEFAULT_QUARANTINE_PATH): string {
  writeFileSync(join(dir, relPath), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return relPath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("ci-quarantine", () => {
  it("loads the repository config/ci-quarantine.json with valid schema and zero expired entries", () => {
    const manifest = loadCiQuarantine(DEFAULT_QUARANTINE_PATH);
    expect(manifest.version).toBe(1);
    expect(manifest.maxDurationDays).toBeLessThanOrEqual(7);
    expect(manifest.maxDurationDays).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(manifest.entries)).toBe(true);
    expect(validateQuarantineActive(manifest, new Date())).toEqual([]);
  });

  it("loads valid entries up to the exact maxDurationDays boundary", () => {
    const dir = createFixtureDir();
    const manifestPath = writeManifest(dir, {
      version: 1,
      maxDurationDays: 7,
      entries: [
        {
          testPath: "scripts/alpha.test.ts",
          owner: "platform-ci",
          reason: "Intermittent port contention under parallel workers",
          trackingRef: "https://github.com/openlup/openlup/issues/101",
          addedAt: "2026-11-20T00:00:00Z",
          expiresAt: "2026-11-27T00:00:00Z",
        },
        {
          testPath: "scripts/beta.test.ts",
          owner: "core-team",
          reason: "Date boundary flake",
          trackingRef: "#202",
          addedAt: "2026-11-20",
          expiresAt: "2026-11-25",
        },
      ],
    });

    const manifest = loadCiQuarantine(manifestPath, dir);
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entries[0]?.testPath).toBe("scripts/alpha.test.ts");
    expect(manifest.entries[1]?.testPath).toBe("scripts/beta.test.ts");
  });

  it("rejects invalid top-level manifest properties", () => {
    const dir = createFixtureDir();

    writeManifest(dir, { version: 2, maxDurationDays: 7, entries: [] });
    expect(() => loadCiQuarantine(DEFAULT_QUARANTINE_PATH, dir)).toThrow(/version must be 1/);

    writeManifest(dir, { version: 1, maxDurationDays: 8, entries: [] });
    expect(() => loadCiQuarantine(DEFAULT_QUARANTINE_PATH, dir)).toThrow(/maxDurationDays/);

    writeManifest(dir, { version: 1, maxDurationDays: 0, entries: [] });
    expect(() => loadCiQuarantine(DEFAULT_QUARANTINE_PATH, dir)).toThrow(/maxDurationDays/);

    writeManifest(dir, { version: 1, maxDurationDays: 3.5, entries: [] });
    expect(() => loadCiQuarantine(DEFAULT_QUARANTINE_PATH, dir)).toThrow(/maxDurationDays/);

    writeManifest(dir, { version: 1, maxDurationDays: 7, entries: {} });
    expect(() => loadCiQuarantine(DEFAULT_QUARANTINE_PATH, dir)).toThrow(/entries must be an array/);
  });

  it("rejects invalid paths, missing files, duplicates, and missing metadata fields", () => {
    const dir = createFixtureDir();
    const baseEntry = {
      testPath: "scripts/alpha.test.ts",
      owner: "ci-team",
      reason: "flake",
      trackingRef: "#123",
      addedAt: "2026-11-20T00:00:00Z",
      expiresAt: "2026-11-25T00:00:00Z",
    };

    writeManifest(dir, { version: 1, maxDurationDays: 7, entries: [{ ...baseEntry, testPath: "../outside.test.ts" }] });
    expect(() => loadCiQuarantine(DEFAULT_QUARANTINE_PATH, dir)).toThrow(/must not contain/);

    writeManifest(dir, { version: 1, maxDurationDays: 7, entries: [{ ...baseEntry, testPath: "/abs/path.test.ts" }] });
    expect(() => loadCiQuarantine(DEFAULT_QUARANTINE_PATH, dir)).toThrow(/must be relative/);

    writeManifest(dir, { version: 1, maxDurationDays: 7, entries: [{ ...baseEntry, testPath: "scripts/missing.test.ts" }] });
    expect(() => loadCiQuarantine(DEFAULT_QUARANTINE_PATH, dir)).toThrow(/does not exist on disk/);

    writeManifest(dir, { version: 1, maxDurationDays: 7, entries: [baseEntry, baseEntry] });
    expect(() => loadCiQuarantine(DEFAULT_QUARANTINE_PATH, dir)).toThrow(/duplicate testPath/);

    writeManifest(dir, { version: 1, maxDurationDays: 7, entries: [{ ...baseEntry, owner: "   " }] });
    expect(() => loadCiQuarantine(DEFAULT_QUARANTINE_PATH, dir)).toThrow(/owner must be a non-empty string/);

    writeManifest(dir, { version: 1, maxDurationDays: 7, entries: [{ ...baseEntry, reason: "" }] });
    expect(() => loadCiQuarantine(DEFAULT_QUARANTINE_PATH, dir)).toThrow(/reason must be a non-empty string/);

    writeManifest(dir, { version: 1, maxDurationDays: 7, entries: [{ ...baseEntry, trackingRef: "" }] });
    expect(() => loadCiQuarantine(DEFAULT_QUARANTINE_PATH, dir)).toThrow(/trackingRef must be a non-empty string/);
  });

  it("rejects invalid dates, non-positive durations, and durations exceeding maxDurationDays", () => {
    const dir = createFixtureDir();
    const baseEntry = {
      testPath: "scripts/alpha.test.ts",
      owner: "ci-team",
      reason: "flake",
      trackingRef: "#123",
      addedAt: "2026-11-20T00:00:00Z",
      expiresAt: "2026-11-25T00:00:00Z",
    };

    writeManifest(dir, { version: 1, maxDurationDays: 7, entries: [{ ...baseEntry, addedAt: "2026-02-30" }] });
    expect(() => loadCiQuarantine(DEFAULT_QUARANTINE_PATH, dir)).toThrow(/valid calendar date/);

    writeManifest(dir, { version: 1, maxDurationDays: 7, entries: [{ ...baseEntry, expiresAt: "not-a-date" }] });
    expect(() => loadCiQuarantine(DEFAULT_QUARANTINE_PATH, dir)).toThrow(/valid ISO-8601/);

    writeManifest(dir, {
      version: 1,
      maxDurationDays: 7,
      entries: [{ ...baseEntry, addedAt: "2026-11-25T00:00:00Z", expiresAt: "2026-11-25T00:00:00Z" }],
    });
    expect(() => loadCiQuarantine(DEFAULT_QUARANTINE_PATH, dir)).toThrow(/must be after addedAt/);

    writeManifest(dir, {
      version: 1,
      maxDurationDays: 7,
      entries: [{ ...baseEntry, addedAt: "2026-11-20T00:00:00Z", expiresAt: "2026-11-27T00:00:01Z" }],
    });
    expect(() => loadCiQuarantine(DEFAULT_QUARANTINE_PATH, dir)).toThrow(/exceeds maxDurationDays/);
  });

  it("detects expired quarantine entries and splits shard files deterministically", () => {
    const dir = createFixtureDir();
    const manifestPath = writeManifest(dir, {
      version: 1,
      maxDurationDays: 7,
      entries: [
        {
          testPath: "scripts/alpha.test.ts",
          owner: "ci-team",
          reason: "flake A",
          trackingRef: "#10",
          addedAt: "2026-11-18T00:00:00Z",
          expiresAt: "2026-11-23T12:00:00Z",
        },
        {
          testPath: "scripts/beta.test.ts",
          owner: "ci-team",
          reason: "flake B",
          trackingRef: "#11",
          addedAt: "2026-11-20T00:00:00Z",
          expiresAt: "2026-11-26T12:00:00Z",
        },
      ],
    });
    const manifest = loadCiQuarantine(manifestPath, dir);

    expect(validateQuarantineActive(manifest, "2026-11-23T11:59:59Z")).toEqual([]);
    expect(validateQuarantineActive(manifest, "2026-11-23T12:00:00Z").map((e) => e.testPath)).toEqual([
      "scripts/alpha.test.ts",
    ]);
    expect(validateQuarantineActive(manifest, new Date("2026-11-27T00:00:00Z")).map((e) => e.testPath)).toEqual([
      "scripts/alpha.test.ts",
      "scripts/beta.test.ts",
    ]);

    const split = splitQuarantinedFiles(
      ["scripts/a.test.ts", "scripts/beta.test.ts", "scripts/c.test.ts", "scripts/alpha.test.ts"],
      manifest,
    );
    expect(split.normalFiles).toEqual(["scripts/a.test.ts", "scripts/c.test.ts"]);
    expect(split.quarantinedEntries.map((entry) => entry.testPath)).toEqual([
      "scripts/beta.test.ts",
      "scripts/alpha.test.ts",
    ]);
  });
});
