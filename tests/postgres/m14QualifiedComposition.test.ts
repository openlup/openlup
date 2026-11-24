import installationInventory from "./current-installation-inventory.json" with { type: "json" };
import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer,
  resolvePostgresTmpfsSpec, waitForPostgresTcpReady, type PostgresContainer,
} from "../helpers/postgresContainer.js";

const exec = promisify(execFile);

function startProof(args: string[], signal: AbortSignal) {
  const result = exec(process.execPath, args, { signal, timeout: 240_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
  const { child } = result;
  // execFile can reject on abort before the process and its stdio have closed.
  const closed = new Promise<void>(resolve => child.once("close", resolve));
  return { child, result: result.finally(() => closed) };
}

it("joins an aborted proof child before returning ownership to the fixture", async () => {
  const controller = new AbortController();
  // Exit naturally in the baseline so a missing cancellation cannot leak the child.
  const { child, result } = startProof(["--eval", "setTimeout(() => {}, 1000)"], controller.signal);
  let closed = false;
  child.once("close", () => { closed = true; });
  await once(child, "spawn");
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(closed).toBe(true);
});

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

async function runQualifiedCompositionCase(
  profile: (typeof profiles)[number],
  shape: (typeof shapes)[number],
  [primaryContainer, freshContainer]: [PostgresContainer, PostgresContainer | undefined],
  signal: AbortSignal,
): Promise<void> {
  const discriminators = Boolean(freshContainer);
  const started = performance.now();
  try {
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
    const { stdout } = await startProof([
      "--import", "tsx", fileURLToPath(new URL("./m14QualifiedComposition.proof.ts", import.meta.url)),
      JSON.stringify({ connectionString: primaryContainer.connectionString, freshConnectionString: freshContainer?.connectionString,
        selection, expectedInventory: shape.sha256, discriminators }),
    ], signal).result;
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
    console.info(`qualified-production ${profile.name}/${shape.name} proofMs=${Math.round(performance.now() - started)}`);
  }
}

let occupiedSlots = 0;
let liveContainers = 0;
let peakContainers = 0;

function listNamedContainers(name: string) {
  return exec("docker", [
    "ps", "--all", "--filter", `name=^/${name}$`, "--format", "{{.Names}}",
  ], { timeout: 5_000, killSignal: "SIGKILL" });
}

async function startupLeftNoContainer(name: string, list = listNamedContainers): Promise<boolean> {
  try {
    const { stdout } = await list(name);
    return stdout.trim() === "";
  } catch {
    // Retain the slot if Docker cannot confirm that its container is absent.
    return false;
  }
}

function registerCase(profile: (typeof profiles)[number], shape: (typeof shapes)[number]) {
  const label = `${profile.name}/${shape.name}`;
  const discriminators = profile.name === "target" && shape.name === "separate-restore";
  const containers: PostgresContainer[] = [];
  let ready: [PostgresContainer, PostgresContainer | undefined];
  let proof: Promise<void> | undefined;

  async function startReady(name: string, unavailableMessage: string, tmpfsSizeMb?: number, list?: typeof listNamedContainers) {
    // Reserve capacity before Docker starts so a failed cleanup cannot admit extra containers.
    expect(occupiedSlots).toBeLessThan(2);
    occupiedSlots++;
    const spec = { name, password: "synthetic-conformance", tmpfsSizeMb };
    try {
      resolvePostgresTmpfsSpec(spec);
    } catch (error) {
      // The shared validator rejects before the startup helper can call Docker.
      occupiedSlots--;
      throw error;
    }
    const instance = await runPostgresContainer(spec).catch(async error => {
      if (await startupLeftNoContainer(name, list)) occupiedSlots--;
      throw error;
    });
    containers.push({ ...instance, async remove() {
      await instance.remove();
      liveContainers--;
      occupiedSlots--;
    } });
    peakContainers = Math.max(peakContainers, ++liveContainers);
    if (!await waitForPostgresTcpReady(instance.connectionString)) throw new Error(unavailableMessage);
    return instance;
  }

  beforeAll(async () => {
    const started = performance.now();
    const listingTimeout = vi.fn<typeof listNamedContainers>().mockRejectedValue(new Error("Docker listing timed out"));
    if (discriminators) {
      // Refuse before Docker creates anything, then require both real target slots.
      await expect(startReady(`m14-q2-invalid-${process.pid}`, "Unexpected ready fixture", 0, listingTimeout))
        .rejects.toThrow("PostgreSQL tmpfsSizeMb");
    }
    const [primary, fresh] = await Promise.allSettled([
      startReady(`m14-q2-${profile.name}-${shape.name}-${process.pid}`, "Qualified composition PostgreSQL unavailable"),
      discriminators ? startReady(`m14-q2-checkout-fresh-${process.pid}`, "Fresh checkout fixture PostgreSQL unavailable") : undefined,
    ]);
    if (primary.status === "rejected") throw primary.reason;
    if (fresh.status === "rejected") throw fresh.reason;
    if (discriminators) expect(listingTimeout).not.toHaveBeenCalled();
    ready = [primary.value, fresh.value];
    console.info(`qualified-production ${label} bootMs=${Math.round(performance.now() - started)} peakContainers=${peakContainers}`);
  }, postgresSetupTimeoutMs);

  afterAll(async () => {
    const started = performance.now();
    // A timed-out case is already marked failed. Join its child before removing either database.
    await proof?.catch(() => undefined);
    await closePostgres(containers);
    console.info(`qualified-production ${label} teardownMs=${Math.round(performance.now() - started)} liveContainers=${liveContainers}`);
  }, postgresTeardownTimeoutMs);

  // About 4x the slowest hosted run (61,139 ms), rounded up to 5 s.
  it(`qualifies production E2+F+completion ${profile.name} ${shape.name} issued prefix and current suffix`, ({ signal }) => {
    proof = runQualifiedCompositionCase(profile, shape, ready, signal);
    return proof;
  }, 245_000);
}

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Qualified production composition requires Docker PostgreSQL");
}, postgresSetupTimeoutMs);

// Exactly two production reference checks and two fresh other-mode targets.
// Bound disposable PostgreSQL containers to at most 2 simultaneously without
// spending per-test timeout waiting in an in-test queue: the two single-container
// reference shapes run concurrently, followed sequentially by the two target
// shapes (the separate target boots its primary + fresh cluster in parallel).
describe.sequential("reference shapes (max 2 containers)", () => {
  for (const shape of shapes) describe.concurrent(shape.name, () => registerCase(profiles[0], shape));
});

describe.sequential("target shapes (max 2 containers)", () => {
  for (const shape of shapes) describe(shape.name, () => registerCase(profiles[1], shape));
});
