import { it } from "vitest";
import { runReleasedSchemaUpgradeProof } from "./m14ReleasedSchemaUpgrade.proof.js";

// Solo without coverage: 3.71 s; retain the required minimum 30 s for database work.
it("upgrades the released 0.23 legacy prefix through real backfill, killed transactions and exact replay",
  () => runReleasedSchemaUpgradeProof(), 30_000);
