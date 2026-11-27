import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseQualificationCliArgs, qualificationReceipt, qualifyReleasedSet } from "../../scripts/packages/exact-set-qualification.mjs";
import { assertSubscriptionMonotonic, runReleasedSchemaUpgradeProof, type ReleasedSchemaPair } from "./m14ReleasedSchemaUpgrade.proof.js";

// About 4x the slowest hosted run (10,992 ms), rounded up to 5 s.
it("upgrades the released 0.23 legacy prefix through real backfill, killed transactions and exact replay",
  () => runReleasedSchemaUpgradeProof(), 45_000);

it.each([
  [{ nextCycleAt: "2026-08-01T00:00:00Z", cycles: 1, deliveries: 1 }, "cycle moved earlier"],
  [{ nextCycleAt: "2026-09-01T00:00:00Z", cycles: 2, deliveries: 1 }, "cycles stacked"],
  [{ nextCycleAt: "2026-09-01T00:00:00Z", cycles: 1, deliveries: 2 }, "deliveries stacked"],
])("names the subscription monotonic clamp violation: %j", (after, reason) => {
  expect(() => assertSubscriptionMonotonic({ nextCycleAt: "2026-08-29T00:00:00Z", cycles: 1, deliveries: 1 }, after))
    .toThrow("subscription_monotonic_clamp: " + reason);
});

it.each([
  ["missing applications", "released_pair_requires_both_applications_and_identities"],
  ["extraction", "released_pair_extraction_mismatch"], ["lock", "released_pair_lock_mismatch"],
  ["adjacent receipt", "adjacent-set qualification must pass first"],
  ["database setup", "qualification PostgreSQL connection required"],
])("refuses %s before executing application/database work: %s", async (kind, reason) => {
  const application = mkdtempSync(join(tmpdir(), "released-pair-refusal-")), path = join(application, "receipt.json");
  const tag = "openlup-core-v0.41.0", commit = "a".repeat(40);
  const extraction = { sourceRevision: commit, lockfileSha256: createHash("sha256").update("{}").digest("hex") };
  const identity = { setVersion: "0.40.0", tagCommit: commit, extraction, packages: [] };
  try {
    if (kind === "adjacent receipt" || kind === "database setup") {
      vi.stubEnv("OPENLUP_QUALIFICATION_DATABASE_URL", undefined);
      writeFileSync(path, JSON.stringify({ ...qualificationReceipt(tag, commit), result: "PASS",
        ...(kind === "database setup" ? { upgrade: { result: "PASS" } } : {}) }));
      await expect(async () => qualifyReleasedSet(tag, commit, path, false, true)).rejects.toThrow(reason);
      if (kind === "database setup") expect(JSON.parse(readFileSync(path, "utf8")))
        .toMatchObject({ result: "FAIL", schemaUpgrade: { result: "FAIL", endedAt: expect.any(String) } });
    } else {
      writeFileSync(join(application, ".starter-origin.json"), JSON.stringify(kind === "extraction" ? {} : extraction));
      writeFileSync(join(application, "package-lock.json"), "altered lock bytes");
      await expect(runReleasedSchemaUpgradeProof((kind === "missing applications" ? { mode: "released-pair" } :
        { mode: "released-pair", from: { application, identity }, to: { application, identity }, database: {} }) as ReleasedSchemaPair))
        .rejects.toThrow(reason);
    }
  } finally { vi.unstubAllEnvs(); rmSync(application, { recursive: true, force: true }); }
});

it("enables pre-publish --candidate with --schema-upgrade and still refuses --bom/--canary on candidates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "candidate-schema-upgrade-"));
  const receiptPath = join(dir, "candidate-upgrade.json");
  const manifestPath = join(dir, "packages-manifest.json");
  const otherManifestPath = join(dir, "other-manifest.json");
  const tag = "openlup-core-v1.5.0", commit = "b".repeat(40);
  try {
    expect(parseQualificationCliArgs([tag, commit, receiptPath, "--candidate", manifestPath])).toEqual({
      kind: "qualify", tag, commit, receipt: receiptPath, upgrade: true, schema: false, bom: false, canary: false, candidateManifest: manifestPath,
    });
    expect(parseQualificationCliArgs([tag, commit, receiptPath, "--candidate", manifestPath, "--schema-upgrade"])).toEqual({
      kind: "qualify", tag, commit, receipt: receiptPath, upgrade: true, schema: true, bom: false, canary: false, candidateManifest: manifestPath,
    });
    expect(parseQualificationCliArgs([tag, commit, receiptPath, "--schema-upgrade", "--candidate", manifestPath])).toEqual({
      kind: "qualify", tag, commit, receipt: receiptPath, upgrade: false, schema: true, bom: false, canary: false, candidateManifest: manifestPath,
    });

    // Candidate mode still refuses --bom and --canary.
    expect(() => qualifyReleasedSet(tag, commit, receiptPath, true, false, true, false, manifestPath))
      .toThrow("candidate supports adjacent upgrade and schema upgrade only");
    expect(() => qualifyReleasedSet(tag, commit, receiptPath, true, false, false, true, manifestPath))
      .toThrow("candidate supports adjacent upgrade and schema upgrade only");

    // Two-step candidate schema upgrade validates candidate mode & manifest match, then reaches DB connection check.
    writeFileSync(receiptPath, JSON.stringify({
      ...qualificationReceipt(tag, commit),
      mode: "candidate",
      verificationSource: "candidate, local digest-verified",
      candidateManifest: resolve(manifestPath),
      result: "PASS",
      upgrade: { result: "PASS" },
    }));
    expect(() => qualifyReleasedSet(tag, commit, receiptPath, false, true, false, false, otherManifestPath))
      .toThrow("candidate schema upgrade manifest mismatch");

    vi.stubEnv("OPENLUP_QUALIFICATION_DATABASE_URL", undefined);
    await expect(async () => qualifyReleasedSet(tag, commit, receiptPath, false, true, false, false, manifestPath))
      .rejects.toThrow("qualification PostgreSQL connection required");
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({
      mode: "candidate",
      result: "FAIL",
      schemaUpgrade: { result: "FAIL", endedAt: expect.any(String) },
    });
  } finally {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});
