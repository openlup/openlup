import { beforeAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { selectPlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { dockerAvailable, postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { runQualifiedAdminCompositionProof } from "./m14QualifiedAdminComposition.proof.js";

const modes = [
  { roleMode: "installer-managed", currentInventory: "d26cae58097e7effc23b3533d8569bff1f12cdef9742e48e4dee064625959723", inventory: "c94d71fd28d5571cda30307bce4c4b48ebe0a3685c76819d8fa3b3efa8fa9ae7" },
  { roleMode: "operator-provisioned", currentInventory: "8a8c577f695272d35b8e6b0a32c0f68d472a6c4662ffb34c7d98c324d674bfe6", inventory: "807ea0c9b303c04c4ad3e9892ab16ee7e89acaea8b7641d1cedd4c79949fab7d" },
] as const;

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Restricted bootstrap qualification requires Docker PostgreSQL 16");
}, postgresSetupTimeoutMs);

for (const mode of modes) {
  it(`qualifies the restricted issued prefix and current production suffix in ${mode.roleMode} mode`, async () => {
    const current = selectPlatformMigrationManifest(JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")), "qualified-admin", { roleMode: mode.roleMode });
    const count = 1 + current.forward.length;
    expect(count).toBe(115);
    expect(current.objectInventorySha256).toBe(mode.currentInventory);
    const result = await runQualifiedAdminCompositionProof(mode);
    expect(result).toMatchObject({
      mode: mode.roleMode, inventory: mode.currentInventory, issuedInventory: mode.inventory, issuedLedgerRows: 91,
      pendingBefore: count, interruptedPrefix: 17, appliedAfterResume: count - 17, ledgerRows: count, replayApplied: 0, runtimeProved: true,
      restoreProved: true, connectionRecipeProved: true, shadowMatrixProved: true,
      refusalsProved: true,
    });
    console.info(`restricted-bootstrap ${mode.roleMode} ${JSON.stringify(result)}`);
  // Hosted maximum 46.174 s: fourfold 184.696 s rounds to the existing 240 s qualified bound.
  // Five-row tail estimates leave at least 185.091 s across both role modes.
  }, 240_000);
}
