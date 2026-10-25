import { expect, it } from "vitest";
import * as facade from "./commerceReturnsPort.js";
import * as commerce from "@openlup/platform/commerce";
it("preserves package export identity", () => {
  expect(Object.keys(facade).sort()).toEqual(["returnApproveSchema", "returnRejectSchema", "returnRequestCreateSchema", "returnRequestLineSchema"]);
  for (const [name, value] of Object.entries(facade)) {
    if (name !== "returnRequestCreateSchema") expect(value).toBe(commerce[name as keyof typeof commerce]);
  }
  expect(facade.returnRequestCreateSchema.shape.lines.element).toBe(commerce.returnRequestLineSchema);
});
