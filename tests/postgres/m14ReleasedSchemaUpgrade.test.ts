import { it } from "vitest";
import { runReleasedSchemaUpgradeProof } from "./m14ReleasedSchemaUpgrade.proof.js";
import { postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";

it("upgrades the released 0.23 legacy prefix through real backfill, killed transactions and exact replay",
  () => runReleasedSchemaUpgradeProof(), postgresSetupTimeoutMs);
