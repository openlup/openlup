import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, expect, it } from "vitest";
import {
  closePostgres, dockerAvailable, postgresSetupTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer,
} from "../helpers/postgresContainer.js";

const exec = promisify(execFile);
// Prior E-only pins are independent expectations, never target-derived replacements.
const shapes = [
  { name: "bootstrap-runtime", separate: false, restore: false, sha256: "aa06600136c82c959af7eab403851bd2d567d6bcddb5ced74f9029f55ee2ecce" },
  { name: "bootstrap-restore", separate: false, restore: true, sha256: "8bd6ef003e48c40bcc8c3bb221a4d6688118001a6a714ffd4103b682728264c7" },
  { name: "separate-runtime", separate: true, restore: false, sha256: "e5b3b368c911f0edfbc7114786498dab8730a6ee6c0995f7e00bf11cc9ae038a" },
  { name: "separate-restore", separate: true, restore: true, sha256: "516bce3141ab233975c161ed41f3a4f5cea1f4d445c420ce2f624cee64571065" },
] as const;
const profiles = [
  { name: "reference", roleMode: "installer-managed", prefix: "q2_reference" },
  { name: "target", roleMode: "operator-provisioned", prefix: "q2_target" },
] as const;

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Qualified production composition requires Docker PostgreSQL");
}, postgresSetupTimeoutMs);

// Exactly four production reference checks and four fresh other-mode targets.
// Run in order: no parallel installations or additional role-mode cross product.
for (const profile of profiles) for (const shape of shapes) {
  it(`qualifies production ${profile.name} ${shape.name} against its fixed E-only pin`, async () => {
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
        ...(shape.restore ? { restoreLogin: `${profile.prefix}_restore` } : {}),
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
        inventorySha256: shape.sha256, ledgerRows: 89, pendingBefore: 89,
        appliedNow: 89, pendingAfter: 0, replayApplied: 0,
        discriminators: profile.name === "target" && shape.name === "separate-restore",
      });
      console.info(`qualified-production ${profile.name}/${shape.name} ${stdout.trim()}`);
    } finally {
      // Also runs after partial startup, a failed assertion or killed child.
      await closePostgres(container);
    }
  }, postgresSetupTimeoutMs);
}
