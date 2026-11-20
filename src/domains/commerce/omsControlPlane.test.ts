import { expect, it } from "vitest";
import * as facade from "./omsControlPlane.js";
import * as commerce from "@openlup/platform/commerce";

it("preserves package export identity", () => {
  expect(Object.keys(facade).sort()).toEqual([
    "OMS_CONTROL_PLANE_VERSION",
    "OMS_CONTROL_PLANE_VIEW",
    "omsControlPlaneActions",
    "omsControlPlaneDetailRequestSchema",
    "omsControlPlaneDetailResponseSchema",
    "omsControlPlaneHoldSchema",
    "omsControlPlaneListRequestSchema",
    "omsControlPlaneListResponseSchema",
    "omsControlPlaneOperationSchema",
    "omsControlPlaneOrderSchema",
  ]);
  for (const [name, value] of Object.entries(facade)) {
    expect(value).toBe(commerce[name as keyof typeof commerce]);
  }
});
