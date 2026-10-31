import { beforeAll, expect, it } from "vitest";
import { dockerAvailable, postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { runQualifiedAdminCompositionProof } from "./m14QualifiedAdminComposition.proof.js";

const modes = [
  { roleMode: "installer-managed", inventory: "96d431befa603ec0d301af13fc580ccd68c25beedefb0bdc1410f5acb847875f" },
  { roleMode: "operator-provisioned", inventory: "1501b40ba66da68f261e8c564b322f27ad68f319d431f775e08998dc6b841283" },
] as const;

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Restricted bootstrap qualification requires Docker PostgreSQL 16");
}, postgresSetupTimeoutMs);

for (const mode of modes) {
  it(`qualifies the restricted 92-unit production installation in ${mode.roleMode} mode`, async () => {
    const result = await runQualifiedAdminCompositionProof(mode);
    expect(result).toMatchObject({
      mode: mode.roleMode, inventory: mode.inventory, pendingBefore: 92, interruptedPrefix: 17,
      appliedAfterResume: 75, ledgerRows: 92, replayApplied: 0, runtimeProved: true,
      restoreProved: true, connectionRecipeProved: true, shadowMatrixProved: true,
      refusalsProved: true,
    });
    console.info(`restricted-bootstrap ${mode.roleMode} ${JSON.stringify(result)}`);
  }, postgresSetupTimeoutMs);
}
