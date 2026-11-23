import installationInventory from "./current-installation-inventory.json" with { type: "json" };
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import {
  closePostgres, dockerAvailable, postgresSetupTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer,
} from "../helpers/postgresContainer.js";

const exec = promisify(execFile);
// Frozen 92-unit issued-prefix measurements remain independent expectations.
// Complete current installations are measured independently through production projectors.
const shapes = [
  { name: "bootstrap-restore", currentSha256: installationInventory.current.profiles["bootstrap"].objectInventorySha256, separate: false, sha256: "c4f6bb9daa5882877149a78e13d07594b7e8653c3a3ba39f508477b072548f9b" },
  { name: "separate-restore", currentSha256: installationInventory.current.profiles["separate"].objectInventorySha256, separate: true, sha256: "624cc57789e3aaf36d0b61bdad420fc4eb0b63c2a7eb09358e5c18240ec13f82" },
] as const;
const profiles = [
  { name: "reference", roleMode: "installer-managed", prefix: "q2_reference" },
  { name: "target", roleMode: "operator-provisioned", prefix: "q2_target" },
] as const;

async function startReadyContainer(name: string, unavailableMessage: string): Promise<PostgresContainer> {
  const instance = await runPostgresContainer({ name, password: "synthetic-conformance" });
  try {
    if (!await waitForPostgresTcpReady(instance.connectionString)) throw new Error(unavailableMessage);
    return instance;
  } catch (error) {
    await closePostgres(instance);
    throw error;
  }
}

async function runQualifiedCompositionCase(
  profile: (typeof profiles)[number],
  shape: (typeof shapes)[number],
): Promise<void> {
  const discriminators = profile.name === "target" && shape.name === "separate-restore";
  let container: PostgresContainer | undefined;
  let freshContainer: PostgresContainer | undefined;
  try {
    if (discriminators) {
      const [primaryResult, freshResult] = await Promise.allSettled([
        startReadyContainer(`m14-q2-${profile.name}-${shape.name}-${process.pid}`, "Qualified composition PostgreSQL unavailable"),
        startReadyContainer(`m14-q2-checkout-fresh-${process.pid}`, "Fresh checkout fixture PostgreSQL unavailable"),
      ]);
      if (primaryResult.status === "fulfilled") container = primaryResult.value;
      if (freshResult.status === "fulfilled") freshContainer = freshResult.value;
      if (primaryResult.status === "rejected") throw primaryResult.reason;
      if (freshResult.status === "rejected") throw freshResult.reason;
    } else {
      container = await startReadyContainer(`m14-q2-${profile.name}-${shape.name}-${process.pid}`, "Qualified composition PostgreSQL unavailable");
    }
    const primaryContainer = container!;
    const bootstrapLogin = `${profile.prefix}_bootstrap`;
    const selection = {
      generation: "qualified-v2", roleMode: profile.roleMode, bootstrapLogin,
      migrationLogin: shape.separate ? `${profile.prefix}_migration` : bootstrapLogin,
      runtimeLogin: `${profile.prefix}_runtime`,
      restoreLogin: `${profile.prefix}_restore`,
    };
    // The production runner owns an internal default Pool but has no close port.
    // A bounded child owns that pool for its whole lifetime, then disconnects it
    // on exit. It uses real package exports, with no Vitest aliases or overrides.
    const { stdout } = await exec(process.execPath, [
      "--import", "tsx", fileURLToPath(new URL("./m14QualifiedComposition.proof.ts", import.meta.url)),
      JSON.stringify({ connectionString: primaryContainer.connectionString, freshConnectionString: freshContainer?.connectionString,
        selection, expectedInventory: shape.sha256, discriminators }),
    ], { timeout: 240_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout);
    const current = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")), "qualified-v2", {
      migrationIsBootstrap: !shape.separate, hasRestore: true,
    });
    const count = 1 + current.forward.length;
    expect(count).toBe(installationInventory.current.profiles[shape.separate ? "separate" : "bootstrap"].count);
    expect(current.objectInventorySha256).toBe(shape.currentSha256);
    expect(result).toMatchObject({
      inventorySha256: shape.currentSha256, issuedInventorySha256: shape.sha256, issuedLedgerRows: 92,
      ledgerRows: count, pendingBefore: count, appliedNow: count, pendingAfter: 0, replayApplied: 0, retainedRuntime: true,
      runtimeLockPrivilegesProved: true, runtimeCompletionProved: true, ownerPathResolutionProved: true,
      nativeObservationRuntimeProved: profile.name === "target" && shape.name === "separate-restore",
      connectionRecipeProved: profile.name === "target" && shape.name === "separate-restore",
      catalogueReadsProved: true, catalogueReadGuardProved: profile.name === "target" && shape.name === "separate-restore",
      discriminators: profile.name === "target" && shape.name === "separate-restore",
    });
    console.info(`qualified-production ${profile.name}/${shape.name} ${stdout.trim()}`);
  } finally {
    // Also runs after partial startup, a failed assertion or killed child.
    await closePostgres([container, freshContainer]);
  }
}

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Qualified production composition requires Docker PostgreSQL");
}, postgresSetupTimeoutMs);

// Exactly two production reference checks and two fresh other-mode targets.
// Bound disposable PostgreSQL containers to at most 2 simultaneously without
// spending per-test timeout waiting in an in-test queue: the two single-container
// reference shapes run concurrently, followed sequentially by the two target
// shapes (the separate target boots its primary + fresh cluster in parallel).
describe("reference shapes (max 2 containers)", () => {
  for (const shape of shapes) {
    it.concurrent(`qualifies production E2+F+completion ${profiles[0].name} ${shape.name} issued prefix and current suffix`, () =>
      runQualifiedCompositionCase(profiles[0], shape), 245_000);
  }
});

describe("target shapes (max 2 containers)", () => {
  for (const shape of shapes) {
    // About 4x the slowest hosted run (61,139 ms), rounded up to 5 s.
    it(`qualifies production E2+F+completion ${profiles[1].name} ${shape.name} issued prefix and current suffix`, () =>
      runQualifiedCompositionCase(profiles[1], shape), 245_000);
  }
});
