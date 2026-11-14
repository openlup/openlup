import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import { qualificationReceipt, qualifyReleasedSet } from "../../scripts/packages/exact-set-qualification.mjs";
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

it("requires both released application roots and identities before database work", async () => {
  await expect(runReleasedSchemaUpgradeProof({ mode: "released-pair" } as ReleasedSchemaPair))
    .rejects.toThrow("released_pair_requires_both_applications_and_identities");
});

it("refuses schema qualification without a passing adjacent-set receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "released-pair-receipt-")), path = join(root, "receipt.json");
  const tag = "openlup-core-v0.41.0", commit = "a".repeat(40), receipt = qualificationReceipt(tag, commit);
  receipt.result = "PASS";
  try {
    writeFileSync(path, JSON.stringify(receipt));
    expect(() => qualifyReleasedSet(tag, commit, path, false, true)).toThrow("adjacent-set qualification must pass first");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("persists FAIL when schema setup refuses after the adjacent-set proof passed", async () => {
  const root = mkdtempSync(join(tmpdir(), "released-pair-setup-")), path = join(root, "receipt.json");
  const tag = "openlup-core-v0.41.0", commit = "a".repeat(40), previous = env.OPENLUP_QUALIFICATION_DATABASE_URL;
  const receipt = Object.assign(qualificationReceipt(tag, commit), { result: "PASS", upgrade: { result: "PASS" } });
  try {
    delete env.OPENLUP_QUALIFICATION_DATABASE_URL;
    writeFileSync(path, JSON.stringify(receipt));
    await expect(qualifyReleasedSet(tag, commit, path, false, true)).rejects.toThrow("qualification PostgreSQL connection required");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ result: "FAIL", schemaUpgrade: { result: "FAIL", endedAt: expect.any(String) } });
  } finally {
    if (previous !== undefined) env.OPENLUP_QUALIFICATION_DATABASE_URL = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(["extraction", "lock"])("refuses altered released %s identity before importing application code", async kind => {
  const application = mkdtempSync(join(tmpdir(), "released-pair-tamper-"));
  const extraction = { sourceRevision: "a".repeat(40), lockfileSha256: createHash("sha256").update("{}").digest("hex") };
  const identity = { setVersion: "0.40.0", tagCommit: extraction.sourceRevision, extraction, packages: [] };
  try {
    writeFileSync(join(application, ".starter-origin.json"), JSON.stringify(kind === "extraction" ? {} : extraction));
    writeFileSync(join(application, "package-lock.json"), "altered lock bytes");
    await expect(runReleasedSchemaUpgradeProof({ mode: "released-pair", from: { application, identity }, to: { application, identity }, database: {} }))
      .rejects.toThrow(kind === "extraction" ? "released_pair_extraction_mismatch" : "released_pair_lock_mismatch");
  } finally { rmSync(application, { recursive: true, force: true }); }
});
