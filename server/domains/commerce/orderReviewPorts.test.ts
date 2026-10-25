import { expect, it } from "vitest";
import * as facade from "./orderReviewPorts.js";
import * as commerce from "@openlup/platform/commerce";
it("preserves package export identity", () => {
  expect(Object.keys(facade).sort()).toEqual([]);
  for (const [name, value] of Object.entries(facade)) {
    expect(value).toBe(commerce[name as keyof typeof commerce]);
  }
});
