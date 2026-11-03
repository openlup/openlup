import { beforeAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { dockerAvailable, postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { runQualifiedAdminCompositionProof } from "./m14QualifiedAdminComposition.proof.js";

const modes = [
  { roleMode: "installer-managed", currentInventory: "594c0c08fbf172081b03c0363418346c7c69221f7ede6dafb47d924828b93142", inventory: "c94d71fd28d5571cda30307bce4c4b48ebe0a3685c76819d8fa3b3efa8fa9ae7" },
  { roleMode: "operator-provisioned", currentInventory: "703a038f974166f878bf9e62026fd198080eda92d72800119a8d0c3ce5d09dad", inventory: "807ea0c9b303c04c4ad3e9892ab16ee7e89acaea8b7641d1cedd4c79949fab7d" },
] as const;

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Restricted bootstrap qualification requires Docker PostgreSQL 16");
}, postgresSetupTimeoutMs);

for (const mode of modes) {
  it(`qualifies the restricted issued prefix and current production suffix in ${mode.roleMode} mode`, async () => {
    const current = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")), "qualified-admin", { roleMode: mode.roleMode });
    const count = 1 + current.forward.length;
    expect(count).toBe(97);
    expect(current.objectInventorySha256).toBe(mode.currentInventory);
    const result = await runQualifiedAdminCompositionProof(mode);
    expect(result).toMatchObject({
      mode: mode.roleMode, inventory: mode.currentInventory, issuedInventory: mode.inventory, issuedLedgerRows: 91,
      pendingBefore: count, interruptedPrefix: 17, appliedAfterResume: count - 17, ledgerRows: count, replayApplied: 0, runtimeProved: true,
      restoreProved: true, connectionRecipeProved: true, shadowMatrixProved: true,
      refusalsProved: true,
    });
    console.info(`restricted-bootstrap ${mode.roleMode} ${JSON.stringify(result)}`);
  }, postgresSetupTimeoutMs);
}
