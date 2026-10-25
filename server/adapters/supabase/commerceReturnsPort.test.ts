import { expect, it } from "vitest";
import * as facade from "./commerceReturnsPort.js";
import * as commerce from "@openlup/platform/commerce/server";
it("preserves package export identity", () => {
  expect(Object.keys(facade).sort()).toEqual(["createSupabaseCommerceReturnsPort"]);
  for (const [name, value] of Object.entries(facade)) {
    expect(value).toBe(commerce[name as keyof typeof commerce]);
  }
});
