import { beforeAll, expect, it } from "vitest";
import { dockerAvailable, postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { runQualifiedAdminCompositionProof } from "./m14QualifiedAdminComposition.proof.js";

const modes = [
  { roleMode: "installer-managed", inventory: "c94d71fd28d5571cda30307bce4c4b48ebe0a3685c76819d8fa3b3efa8fa9ae7" },
  { roleMode: "operator-provisioned", inventory: "807ea0c9b303c04c4ad3e9892ab16ee7e89acaea8b7641d1cedd4c79949fab7d" },
] as const;

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Restricted bootstrap qualification requires Docker PostgreSQL 16");
}, postgresSetupTimeoutMs);

for (const mode of modes) {
  it(`qualifies the restricted 91-unit production installation in ${mode.roleMode} mode`, async () => {
    const result = await runQualifiedAdminCompositionProof(mode);
    expect(result).toMatchObject({
      mode: mode.roleMode, inventory: mode.inventory, pendingBefore: 91, interruptedPrefix: 17,
      appliedAfterResume: 74, ledgerRows: 91, replayApplied: 0, runtimeProved: true,
      restoreProved: true, connectionRecipeProved: true, shadowMatrixProved: true,
      refusalsProved: true,
    });
    console.info(`restricted-bootstrap ${mode.roleMode} ${JSON.stringify(result)}`);
  }, postgresSetupTimeoutMs);
}
