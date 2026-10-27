import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluatePlatformMigrationManifest,
  evaluatePlatformMigrationManifestHistory,
  evaluateSelectedPlatformMigrationManifest,
  isQualifiedPlatformMigrationPath,
  QUALIFIED_ACQUISITION_FILE,
  QUALIFIED_ACTOR_FILE,
  QUALIFIED_BASELINE_FILE,
  QUALIFIED_IMPORT_FILE,
  QUALIFIED_RUNTIME_FILE,
  readPlatformMigrations,
  selectPlatformMigrationManifest,
  sha256,
  type PlatformMigrationManifest,
  type PlatformMigrationPlan,
} from "./platform-migration-manifest.js";

const raw = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as PlatformMigrationManifest;
const legacy: PlatformMigrationPlan = { schemaVersion: 1, baseline: raw.baseline, forward: raw.forward, objectInventorySha256: raw.objectInventorySha256 };
const legacyMigrations = readPlatformMigrations(process.cwd()).migrations.filter(({ file }) => !isQualifiedPlatformMigrationPath(file));
const inventory = "fixed qualified inventory fixture";

function fixture() {
  const qualifiedFiles = [QUALIFIED_BASELINE_FILE, QUALIFIED_ACTOR_FILE, QUALIFIED_ACQUISITION_FILE, QUALIFIED_RUNTIME_FILE];
  const fresh = qualifiedFiles.map((file, index) => ({ file, content: `-- synthetic canonical source fixture ${index}\nSELECT 1;\n` }));
  const freshEntries = new Map(fresh.map(({ file, content }) => [file, { file, sha256: sha256(content) }]));
  const replacement = new Map([
    ["db/platform/migrations/20260810180001_self_host_actor_auth.sql", QUALIFIED_ACTOR_FILE],
    ["db/platform/migrations/20260816140000_acquisition_case_foundation.sql", QUALIFIED_ACQUISITION_FILE],
  ]);
  const manifest = {
    ...structuredClone(legacy), schemaVersion: 2 as const,
    qualified: {
      baseline: freshEntries.get(QUALIFIED_BASELINE_FILE)!,
      forward: [...legacy.forward.map(entry => replacement.has(entry.file) ? freshEntries.get(replacement.get(entry.file)!)! : { ...entry }), freshEntries.get(QUALIFIED_RUNTIME_FILE)!],
      objectInventorySha256: {
        bootstrapMigrator: { runtimeOnly: sha256(inventory), withRestore: sha256("bootstrap with restore") },
        separateMigrator: { runtimeOnly: sha256("separate without restore"), withRestore: sha256("separate with restore") },
      },
    },
  };
  return { manifest, migrations: [...legacyMigrations, ...fresh], qualifiedFiles };
}

describe("canonical qualified migration selection", () => {
  it("validates the complete union and normalizes either generation without changing shared SQL identities", () => {
    const { manifest, migrations } = fixture();
    expect(evaluatePlatformMigrationManifest({ manifest, migrations })).toEqual([]);
    expect(selectPlatformMigrationManifest(manifest, "legacy")).toEqual(legacy);
    const selected = selectPlatformMigrationManifest(manifest, "qualified-v2", { migrationIsBootstrap: true, hasRestore: false });
    const paths = new Set([selected.baseline.file, ...selected.forward.map(({ file }) => file)]);
    expect(evaluateSelectedPlatformMigrationManifest({ manifest: selected, migrations: migrations.filter(({ file }) => paths.has(file)), objectInventoryPayload: inventory }, "qualified-v2")).toEqual([]);
    expect(selected.baseline.file).toBe(QUALIFIED_BASELINE_FILE);
    for (const migrationIsBootstrap of [true, false]) for (const hasRestore of [true, false]) {
      expect(selectPlatformMigrationManifest(manifest, "qualified-v2", { migrationIsBootstrap, hasRestore }).objectInventorySha256)
        .toBe(manifest.qualified.objectInventorySha256[migrationIsBootstrap ? "bootstrapMigrator" : "separateMigrator"][hasRestore ? "withRestore" : "runtimeOnly"]);
    }
    expect(selected.forward.filter(({ file }) => !isQualifiedPlatformMigrationPath(file))).toEqual(legacy.forward.filter(({ file }) => !file.includes("20260810180001_") && !file.includes("20260816140000_")));
  });

  it("rejects qualified selection from v1 and unrecognized generation data", () => {
    expect(() => selectPlatformMigrationManifest(legacy, "qualified-v2")).toThrow("explicit canonical v2");
    const { manifest, migrations } = fixture();
    expect(() => selectPlatformMigrationManifest(manifest, "qualified-v2")).toThrow("exact declared binding shape");
    expect(evaluatePlatformMigrationManifest({ manifest: { ...manifest, fallback: "legacy" }, migrations })).toEqual([expect.stringContaining("expected exactly")]);
    expect(evaluatePlatformMigrationManifest({ manifest: { ...manifest, qualified: { ...manifest.qualified, roleMode: "automatic" } }, migrations })).toEqual([expect.stringContaining("expected exactly")]);
  });

  it("admits only the two restore-bound shapes when the retained-import unit is present", () => {
    const { manifest, migrations } = fixture();
    const imported = { file: QUALIFIED_IMPORT_FILE, content: "-- synthetic qualified retained-import source\nSELECT 1;\n" };
    const withImport = { ...manifest, qualified: { ...manifest.qualified,
      forward: [...manifest.qualified.forward, { file: imported.file, sha256: sha256(imported.content) }],
      objectInventorySha256: {
        bootstrapMigrator: { withRestore: sha256("bootstrap imported with restore") },
        separateMigrator: { withRestore: sha256("separate imported with restore") },
      },
    } };
    expect(evaluatePlatformMigrationManifest({ manifest: withImport, migrations: [...migrations, imported] })).toEqual([]);
    expect(evaluatePlatformMigrationManifestHistory(manifest, withImport, [QUALIFIED_IMPORT_FILE])).toEqual([]);
    for (const migrationIsBootstrap of [true, false]) {
      expect(selectPlatformMigrationManifest(withImport, "qualified-v2", { migrationIsBootstrap, hasRestore: true }).objectInventorySha256)
        .toBe(withImport.qualified.objectInventorySha256[migrationIsBootstrap ? "bootstrapMigrator" : "separateMigrator"].withRestore);
      expect(() => selectPlatformMigrationManifest(withImport, "qualified-v2", { migrationIsBootstrap, hasRestore: false })).toThrow("explicit restore login binding");
    }
    const unsupported = { ...withImport, qualified: { ...withImport.qualified, objectInventorySha256: {
      ...withImport.qualified.objectInventorySha256,
      bootstrapMigrator: { ...withImport.qualified.objectInventorySha256.bootstrapMigrator, runtimeOnly: sha256(inventory) },
    } } };
    expect(evaluatePlatformMigrationManifest({ manifest: unsupported, migrations: [...migrations, imported] })).toEqual([expect.stringContaining("exact supported binding-shape")]);
  });

  it("refuses corrupt and unmanifested unselected SQL before either generation can be loaded", () => {
    const { manifest, migrations } = fixture();
    const corrupt = migrations.map(entry => entry.file === QUALIFIED_ACTOR_FILE ? { ...entry, content: `${entry.content}SELECT 2;` } : entry);
    expect(evaluatePlatformMigrationManifest({ manifest, migrations: corrupt })).toContain(`platform migration manifest: SHA-256 mismatch for ${QUALIFIED_ACTOR_FILE}`);
    expect(evaluatePlatformMigrationManifest({ manifest, migrations: [...migrations, { file: "db/platform/migrations/q2_unapproved.sql", content: "SELECT 1;" }] })).toContain("platform migration manifest: unmanifested catalog file db/platform/migrations/q2_unapproved.sql");
  });

  it("rejects omitted/reordered shared units, unqualified bootstrap reuse and early sealing", () => {
    const { manifest, migrations } = fixture();
    for (const change of [
      (value: typeof manifest) => { value.qualified.forward.splice(1, 1); },
      (value: typeof manifest) => { [value.qualified.forward[0], value.qualified.forward[1]] = [value.qualified.forward[1]!, value.qualified.forward[0]!]; },
      (value: typeof manifest) => { const index = value.qualified.forward.findIndex(({ file }) => file === QUALIFIED_ACTOR_FILE); value.qualified.forward[index] = legacy.forward.find(({ file }) => file.includes("20260810180001_"))!; },
      (value: typeof manifest) => { value.qualified.forward.unshift(value.qualified.forward.pop()!); },
    ]) {
      const changed = structuredClone(manifest);
      change(changed);
      expect(evaluatePlatformMigrationManifest({ manifest: changed, migrations }).length).toBeGreaterThan(0);
    }
  });

  it("preserves the complete legacy history and binds precisely the new generation files", () => {
    const { manifest, qualifiedFiles } = fixture();
    expect(evaluatePlatformMigrationManifestHistory(legacy, manifest, qualifiedFiles)).toEqual([]);
    const changed = structuredClone(manifest);
    changed.objectInventorySha256 = "a".repeat(64);
    expect(evaluatePlatformMigrationManifestHistory(legacy, changed, qualifiedFiles)).toContain("legacy object inventory cannot change without an appended legacy forward");
    expect(evaluatePlatformMigrationManifestHistory(legacy, manifest, qualifiedFiles.slice(1))).toContain("platform migration manifest must bind exactly the appended portable forwards and qualified units");
  });

  it("refuses qualified prefix edits and inventory-only repinning", () => {
    const { manifest } = fixture();
    const changed = structuredClone(manifest);
    changed.qualified.forward[0]!.sha256 = "a".repeat(64);
    expect(evaluatePlatformMigrationManifestHistory(manifest, changed, [])).toContain("qualified migration manifest must preserve the previous prefix");
    const repinned = structuredClone(manifest);
    repinned.qualified.objectInventorySha256.bootstrapMigrator.runtimeOnly = "a".repeat(64);
    expect(evaluatePlatformMigrationManifestHistory(manifest, repinned, [])).toContain("platform migration manifest cannot change without an added migration");
  });
});
