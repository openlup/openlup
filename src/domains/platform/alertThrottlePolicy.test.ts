import { expect, it } from "vitest";
import * as facade from "./alertThrottlePolicy.js";
import * as operations from "@openlup/platform/operations";

it("preserves package export identity", () => {
  expect(Object.keys(facade).sort()).toEqual([
    "DEFAULT_THROTTLE_SECONDS",
    "throttleSecondsForSeverity",
  ]);
  for (const [name, value] of Object.entries(facade)) {
    expect(value).toBe(operations[name as keyof typeof operations]);
  }
});
