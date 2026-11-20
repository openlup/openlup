import { expect, it } from "vitest";
import * as facade from "./adminAlertsView.js";
import * as operations from "@openlup/platform/operations";

it("preserves package export identity", () => {
  expect(Object.keys(facade).sort()).toEqual([
    "ADMIN_ALERTS_LIST_LIMIT",
    "GENERIC_JOB_DEDUPE_PREFIXES",
    "WATCHDOG_STALE_AFTER_SECONDS",
    "buildAlertsOverview",
    "buildHeartbeat",
    "classifyLane",
    "deriveHealth",
    "isGenericJobAlert",
    "isPageable",
    "isSnoozed",
    "summarizeAlerts",
    "toAdminAlert",
    "worstSeverity",
  ]);
  for (const [name, value] of Object.entries(facade)) {
    expect(value).toBe(operations[name as keyof typeof operations]);
  }
});
