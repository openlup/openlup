import { it } from "vitest";
import { runReleasedSchemaUpgradeProof } from "./m14ReleasedSchemaUpgrade.proof.js";

// Hosted maximum 7.870 s: fourfold 31.480 s rounds to the existing 40 s qualified bound.
// Five-row tail estimate leaves 28.577 s of case headroom.
it("upgrades the released 0.23 legacy prefix through real backfill, killed transactions and exact replay",
  () => runReleasedSchemaUpgradeProof(), 45_000);
