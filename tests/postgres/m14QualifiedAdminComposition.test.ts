import installationInventory from "./current-installation-inventory.json" with { type: "json" };
import { execFile } from "node:child_process";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import {
  closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer,
} from "../helpers/postgresContainer.js";

const exec = promisify(execFile);
const proofTimeoutMs = 240_000;

function startProof(args: string[], signal: AbortSignal) {
  const result = exec(process.execPath, args, { signal, timeout: proofTimeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
  const { child } = result;
  // Abort can reject execFile while the child is still closing its stdio.
  const closed = new Promise<void>(resolve => child.once("close", resolve));
  return { child, result: result.finally(() => closed) };
}

it("joins an aborted restricted composition proof child", async () => {
  const controller = new AbortController();
  const { child, result } = startProof(["--eval", "setTimeout(() => {}, 1000)"], controller.signal);
  let closed = false;
  child.once("close", () => { closed = true; });
  await once(child, "spawn");
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(closed).toBe(true);
});

const modes = [
  { roleMode: "installer-managed", currentInventory: installationInventory.current.profiles["admin-managed"].objectInventorySha256, inventory: "c94d71fd28d5571cda30307bce4c4b48ebe0a3685c76819d8fa3b3efa8fa9ae7" },
  { roleMode: "operator-provisioned", currentInventory: installationInventory.current.profiles["admin-operator"].objectInventorySha256, inventory: "807ea0c9b303c04c4ad3e9892ab16ee7e89acaea8b7641d1cedd4c79949fab7d" },
] as const;

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Restricted bootstrap qualification requires Docker PostgreSQL 16");
}, postgresSetupTimeoutMs);

// Each concurrent mode owns one disposable PostgreSQL container.
for (const mode of modes) {
  describe.concurrent(mode.roleMode, () => {
    let container: PostgresContainer;
    let proof: Promise<void> | undefined;

    beforeAll(async () => {
      const started = performance.now();
      container = await runPostgresContainer({
        name: `m14-qb-production-${mode.roleMode}-${process.pid}`,
        password: "synthetic-conformance",
      });
      if (!await waitForPostgresTcpReady(container.connectionString)) {
        throw new Error("Restricted bootstrap PostgreSQL unavailable");
      }
      console.info(`restricted-bootstrap ${mode.roleMode} readyMs=${Math.round(performance.now() - started)}`);
    }, postgresSetupTimeoutMs);

    afterAll(async () => {
      // The test signal cancels the proof on timeout. Join it before removing PostgreSQL.
      await proof?.catch(() => undefined);
      await closePostgres(container);
    }, postgresTeardownTimeoutMs);

    async function runProof(signal: AbortSignal) {
      const started = performance.now();
      try {
        const current = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")), "qualified-admin", { roleMode: mode.roleMode });
        const count = 1 + current.forward.length;
        expect(count).toBe(installationInventory.current.profiles[mode.roleMode === "installer-managed" ? "admin-managed" : "admin-operator"].count);
        expect(current.objectInventorySha256).toBe(mode.currentInventory);
        const { stdout } = await startProof([
          "--import", "tsx", fileURLToPath(new URL("./m14QualifiedAdminComposition.proof.ts", import.meta.url)),
          JSON.stringify([{ roleMode: mode.roleMode, inventory: mode.inventory }, container.connectionString]),
        ], signal).result;
        // The child prints cleanup diagnostics before its final JSON result.
        const result = JSON.parse(stdout.trimEnd().split("\n").at(-1)!);
        expect(result).toMatchObject({
          mode: mode.roleMode, inventory: mode.currentInventory, issuedInventory: mode.inventory, issuedLedgerRows: 91,
          pendingBefore: count, interruptedPrefix: 17, appliedAfterResume: count - 17, ledgerRows: count, replayApplied: 0, runtimeProved: true,
          restoreProved: true, connectionRecipeProved: true, shadowMatrixProved: true,
          refusalsProved: true,
        });
        console.info(`restricted-bootstrap ${mode.roleMode} ${JSON.stringify(result)}`);
      } finally {
        console.info(`restricted-bootstrap ${mode.roleMode} proofMs=${Math.round(performance.now() - started)}`);
      }
    }

    it(`qualifies the restricted issued prefix and current production suffix in ${mode.roleMode} mode`, ({ signal }) => {
      proof = runProof(signal);
      return proof;
    }, proofTimeoutMs);
  });
}
