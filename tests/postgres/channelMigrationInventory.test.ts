import { expect,it } from "vitest";
import { channelInventoryModes,channelMigrationInventory } from "../helpers/channelMigrationInventory.js";
import { postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
// Reference hashes are recorded separately before this independent fresh-install proof.
for(const mode of channelInventoryModes)it(`installs and replays the full selected channel suffix with exact inventory and grants: ${mode}`,async()=>{
  const result=await channelMigrationInventory(mode);
  expect(result.sha256).toBe(result.expected);
  expect(result.measuredAfterExpectedMismatch).toBe(false);
},postgresSetupTimeoutMs);
