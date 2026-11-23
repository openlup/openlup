import installationInventory from "./current-installation-inventory.json" with { type: "json" };
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { readIssuedPlatformManifest } from "../helpers/issuedPlatformCatalog.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { runQualifiedAdminCompositionProof } from "./m14QualifiedAdminComposition.proof.js";

const exec = promisify(execFile);
const issued = readIssuedPlatformManifest();

it.each(["bootstrap", "separate"] as const)("installs the dark checkout ACL on fresh v2 %s", async shape => {
  const bootstrap = shape === "bootstrap";
  const expectedInventory = selectPlatformMigrationManifest(issued, "qualified-v2", { migrationIsBootstrap: bootstrap, hasRestore: true }).objectInventorySha256;
  const container = await runPostgresContainer({ name: `m14-q2-dark-${shape}-${process.pid}`, password: "synthetic-conformance" });
  try {
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Fresh qualified composition PostgreSQL unavailable");
    const { stdout } = await exec(process.execPath, [
      "--import", "tsx", fileURLToPath(new URL("./m14QualifiedComposition.proof.ts", import.meta.url)),
      JSON.stringify({ connectionString: container.connectionString, freshRuntimeCheckout: true, expectedInventory,
        selection: { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "q2_fresh_bootstrap",
          migrationLogin: bootstrap ? "q2_fresh_bootstrap" : "q2_fresh_migration", runtimeLogin: "q2_fresh_runtime",
          restoreLogin: "q2_fresh_restore" } }),
    ], { timeout: 240_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
    expect(JSON.parse(stdout)).toEqual({ freshRuntimeCheckout: true, ledgerRows: installationInventory.current.profiles[shape].count });
  } finally { await closePostgres(container); }
}, 245_000);

it.each([
  { roleMode: "installer-managed", profile: "admin-managed" },
  { roleMode: "operator-provisioned", profile: "admin-operator" },
] as const)("installs the dark checkout ACL on fresh qualified admin $roleMode", async ({ roleMode, profile }) => {
  const inventory = selectPlatformMigrationManifest(issued, "qualified-admin", { roleMode }).objectInventorySha256;
  expect(await runQualifiedAdminCompositionProof({ roleMode, inventory, freshRuntimeCheckout: true })).toEqual({
    freshRuntimeCheckout: true, ledgerRows: installationInventory.current.profiles[profile].count,
  });
}, 240_000);
