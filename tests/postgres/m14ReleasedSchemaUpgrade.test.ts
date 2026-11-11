import { it } from "vitest";
import { runReleasedSchemaUpgradeProof } from "./m14ReleasedSchemaUpgrade.proof.js";

// About 4x the slowest hosted run (10,992 ms), rounded up to 5 s.
it("upgrades the released 0.23 legacy prefix through real backfill, killed transactions and exact replay",
  () => runReleasedSchemaUpgradeProof(), 45_000);
