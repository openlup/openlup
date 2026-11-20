import { expect, it } from "vitest";
import * as facade from "./platformWatchdogDeliveryPolicy.js";
import * as operations from "@openlup/platform/operations/server";

it("preserves package export identity", () => {
  expect(Object.keys(facade).sort()).toEqual([
    "isActionabilitySuppressed",
    "isDeliveryBackoff",
    "isPagingSuppressed",
    "isSeverityEscalation",
    "notificationSchedule",
    "shouldAttemptNotification",
  ]);
  for (const [name, value] of Object.entries(facade)) {
    expect(value).toBe(operations[name as keyof typeof operations]);
  }
});
