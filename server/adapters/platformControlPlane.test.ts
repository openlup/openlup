import { expect, it } from "vitest";
import * as facade from "./platformControlPlane.js";
import * as operations from "@openlup/platform/operations/server";

it("preserves package export identity", () => {
  expect(Object.keys(facade).sort()).toEqual([
    "createPlatformControlPlanePort",
    "isPlatformControlOperatorActive",
    "platformControlPlaneSql",
  ]);
  for (const [name, value] of Object.entries(facade)) {
    expect(value).toBe(operations[name as keyof typeof operations]);
  }
});
