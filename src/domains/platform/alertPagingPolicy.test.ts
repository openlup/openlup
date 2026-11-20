import { expect, it } from "vitest";
import * as facade from "./alertPagingPolicy.js";
import * as operations from "@openlup/platform/operations";

it("preserves package export identity", () => {
  expect(Object.keys(facade).sort()).toEqual([
    "DEFAULT_PAGING_MIN_SEVERITY",
    "parsePagingMinSeverity",
    "shouldPage",
  ]);
  for (const [name, value] of Object.entries(facade)) {
    expect(value).toBe(operations[name as keyof typeof operations]);
  }
});
