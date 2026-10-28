import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, expect, it } from "vitest";
import {
  closePostgres, dockerAvailable, postgresSetupTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer,
} from "../helpers/postgresContainer.js";

const exec = promisify(execFile);
// Frozen two-reference F measurements are independent expectations, never
// target-derived replacements. E2 retains its four 89-unit shapes on its branch.
const shapes = [
  { name: "bootstrap-restore", separate: false, sha256: "f10dd81aadf543e9b14b5fca30e377c6d0d8689dde379837ad0c145795c09d8f" },
  { name: "separate-restore", separate: true, sha256: "d68dd042c487c30b9082cd70103c63de81e2f6ee1754ff52e5961144f172d4b1" },
] as const;
const profiles = [
  { name: "reference", roleMode: "installer-managed", prefix: "q2_reference" },
  { name: "target", roleMode: "operator-provisioned", prefix: "q2_target" },
] as const;

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Qualified production composition requires Docker PostgreSQL");
}, postgresSetupTimeoutMs);

// Exactly two production reference checks and two fresh other-mode targets.
// Run in order: no parallel installations or additional role-mode cross product.
for (const profile of profiles) for (const shape of shapes) {
  it(`qualifies production E2+F ${profile.name} ${shape.name} against its frozen pin`, async () => {
    let container: PostgresContainer | undefined;
    try {
      container = await runPostgresContainer({
        name: `m14-q2-${profile.name}-${shape.name}-${process.pid}`, password: "synthetic-conformance",
      });
      if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Qualified composition PostgreSQL unavailable");
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
        JSON.stringify({ connectionString: container.connectionString, selection, expectedInventory: shape.sha256,
          discriminators: profile.name === "target" && shape.name === "separate-restore" }),
      ], { timeout: 240_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
      const result = JSON.parse(stdout);
      expect(result).toMatchObject({
        inventorySha256: shape.sha256, ledgerRows: 90, pendingBefore: 90,
        appliedNow: 90, pendingAfter: 0, replayApplied: 0, retainedRuntime: true,
        runtimeLockPrivilegesProved: true,
        discriminators: profile.name === "target" && shape.name === "separate-restore",
      });
      console.info(`qualified-production ${profile.name}/${shape.name} ${stdout.trim()}`);
    } finally {
      // Also runs after partial startup, a failed assertion or killed child.
      await closePostgres(container);
    }
  }, postgresSetupTimeoutMs);
}
