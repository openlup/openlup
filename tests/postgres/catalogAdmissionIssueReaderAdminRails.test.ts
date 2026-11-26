import { it } from "vitest";
import { postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { verifyAdmissionIssueRail } from "./catalogAdmissionIssueReader.fixture.js";

const profiles = ["admin-managed", "admin-operator"] as const;

it.each(profiles)("upgrades and serves admission issues on the installed %s rail", async profile => {
  await verifyAdmissionIssueRail(profile);
}, postgresSetupTimeoutMs);
