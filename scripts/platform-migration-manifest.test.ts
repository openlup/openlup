import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ADMIN_ACQUISITION_FILE,
  ADMIN_ACTOR_FILE,
  ADMIN_BASELINE_FILE,
  ADMIN_IMPORT_FILE,
  ADMIN_RUNTIME_FILE,
  evaluatePlatformMigrationManifest,
  evaluatePlatformMigrationManifestHistory,
  evaluateSelectedPlatformMigrationManifest,
  isQualifiedPlatformMigrationPath,
  QUALIFIED_ACQUISITION_FILE,
  QUALIFIED_ACTOR_FILE,
  QUALIFIED_BASELINE_FILE,
  QUALIFIED_IMPORT_FILE,
  QUALIFIED_RUNTIME_FILE,
  QUALIFIED_RUNTIME_COMPLETION_FILE,
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
  it("admits a separate 91-unit restricted generation with fixed role-mode inventories", () => {
    if (raw.schemaVersion !== 2) throw new Error("current qualified source must be schema 2");
    const files = [ADMIN_BASELINE_FILE, ADMIN_ACTOR_FILE, ADMIN_ACQUISITION_FILE, ADMIN_RUNTIME_FILE, ADMIN_IMPORT_FILE];
    const source = files.map((file, index) => ({ file, content: `-- synthetic restricted unit ${index}\nSELECT 1;\n` }));
    const entries = new Map(source.map(({ file, content }) => [file, { file, sha256: sha256(content) }]));
    const replacement = new Map([
      [QUALIFIED_ACTOR_FILE, ADMIN_ACTOR_FILE], [QUALIFIED_ACQUISITION_FILE, ADMIN_ACQUISITION_FILE],
      [QUALIFIED_RUNTIME_FILE, ADMIN_RUNTIME_FILE], [QUALIFIED_IMPORT_FILE, ADMIN_IMPORT_FILE],
    ]);
    const admin = {
      baseline: entries.get(ADMIN_BASELINE_FILE)!,
      forward: raw.qualified.forward.map(entry => replacement.has(entry.file) ? entries.get(replacement.get(entry.file)!)! : entry),
      objectInventorySha256: { installerManaged: sha256("fixed managed inventory"), operatorProvisioned: sha256("fixed provisioned inventory") },
    };
    const manifest = { ...raw, schemaVersion: 3 as const, qualifiedAdmin: admin };
    const migrations = [...readPlatformMigrations(process.cwd()).migrations, ...source];
    expect(evaluatePlatformMigrationManifest({ manifest, migrations })).toEqual([]);
    expect(evaluatePlatformMigrationManifestHistory(raw, manifest, files)).toEqual([]);
    for (const roleMode of ["installer-managed", "operator-provisioned"] as const) {
      const selected = selectPlatformMigrationManifest(manifest, "qualified-admin", { roleMode });
      expect([selected.baseline, ...selected.forward]).toHaveLength(91);
      expect(selected.forward.at(-1)?.file).toBe(QUALIFIED_RUNTIME_COMPLETION_FILE);
      expect(selected.objectInventorySha256).toBe(admin.objectInventorySha256[roleMode === "installer-managed" ? "installerManaged" : "operatorProvisioned"]);
    }
    expect(() => selectPlatformMigrationManifest(raw, "qualified-admin", { roleMode: "installer-managed" })).toThrow("exact canonical plan");
    expect(() => selectPlatformMigrationManifest(manifest, "qualified-admin", { roleMode: "installer-managed", hasRestore: true } as never)).toThrow("role-mode binding");
    const missingTail = structuredClone(manifest);
    missingTail.qualifiedAdmin.forward.pop();
    expect(evaluatePlatformMigrationManifest({ manifest: missingTail, migrations })).toEqual(expect.arrayContaining([expect.stringContaining("qualified plan is missing")]));
    const alteredIssued = structuredClone(manifest);
    alteredIssued.qualified.forward[0]!.sha256 = "a".repeat(64);
    expect(evaluatePlatformMigrationManifestHistory(raw, alteredIssued, files)).toEqual(expect.arrayContaining([expect.stringContaining("previous prefix")]));
    const wrongInventory = structuredClone(manifest);
    wrongInventory.qualifiedAdmin.objectInventorySha256.operatorProvisioned = "invalid";
    expect(evaluatePlatformMigrationManifest({ manifest: wrongInventory, migrations })).toEqual(expect.arrayContaining([expect.stringContaining("two exact role-mode")]));
  });
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

  it("admits only the exact completion tail after the unchanged restore-bound prefix", () => {
    if (raw.schemaVersion !== 2) throw new Error("canonical fixture requires schema 2");
    const previous = structuredClone(raw);
    // Isolate the structural pre-completion fixture after the real tail is introduced.
    previous.qualified.forward = previous.qualified.forward.filter(({ file }) => file !== QUALIFIED_RUNTIME_COMPLETION_FILE);
    const content = readFileSync(`scripts/fixtures/reviewed-m14-qualified/${QUALIFIED_RUNTIME_COMPLETION_FILE}`, "utf8");
    const completion = { file: QUALIFIED_RUNTIME_COMPLETION_FILE, sha256: sha256(content) };
    const completed = structuredClone(previous);
    completed.qualified.forward.push(completion);
    const migrations = [...readPlatformMigrations(process.cwd()).migrations.filter(({ file }) => file !== completion.file),
      { file: completion.file, content }];
    // Structural inputs retain historical hashes; they are not future live inventory evidence.
    expect(evaluatePlatformMigrationManifest({ manifest: completed, migrations })).toEqual([]);
    expect(evaluatePlatformMigrationManifestHistory(previous, completed, [completion.file])).toEqual([]);
    expect(completed.qualified.forward.slice(0, -1)).toEqual(previous.qualified.forward);
    expect(selectPlatformMigrationManifest(completed, "legacy")).toEqual(legacy);
    for (const migrationIsBootstrap of [true, false]) {
      const selected = selectPlatformMigrationManifest(completed, "qualified-v2", { migrationIsBootstrap, hasRestore: true });
      expect(selected.forward.at(-1)).toEqual(completion);
      expect(selected.forward.slice(0, -1)).toEqual(previous.qualified.forward);
      expect(() => selectPlatformMigrationManifest(completed, "qualified-v2", { migrationIsBootstrap, hasRestore: false })).toThrow("explicit restore login binding");
    }
    for (const change of [
      (value: typeof completed) => { value.qualified.forward.splice(value.qualified.forward.length - 2, 0, value.qualified.forward.pop()!); },
      (value: typeof completed) => { value.qualified.forward = value.qualified.forward.filter(({ file }) => file !== QUALIFIED_IMPORT_FILE); },
      (value: typeof completed) => { value.forward.push(completion); },
      (value: typeof completed) => { value.qualified.forward.at(-1)!.file = "db/platform/migrations/q2_20261028100000_other_runtime.sql"; },
    ]) {
      const changed = structuredClone(completed);
      change(changed);
      expect(evaluatePlatformMigrationManifest({ manifest: changed, migrations }).length).toBeGreaterThan(0);
    }
    const reordered = structuredClone(completed);
    [reordered.qualified.forward[0], reordered.qualified.forward[1]] = [reordered.qualified.forward[1]!, reordered.qualified.forward[0]!];
    expect(evaluatePlatformMigrationManifestHistory(previous, reordered, [completion.file])).toContain("qualified migration manifest must preserve the previous prefix");
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
