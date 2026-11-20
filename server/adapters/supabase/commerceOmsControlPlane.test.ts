import { expect, it } from "vitest";
import * as facade from "./commerceOmsControlPlane.js";
import * as commerce from "@openlup/platform/commerce/server";

it("preserves package export identity", () => {
  expect(Object.keys(facade).sort()).toEqual(["createSupabaseCommerceOmsControlPlanePort"]);
  expect(facade.createSupabaseCommerceOmsControlPlanePort).toBe(commerce.createManagedCommerceOmsControlPlanePort);
});
