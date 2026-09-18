import { testerProgramActiveCount } from "#acquisition-case-routes";
import { describe, expect, it } from "vitest";

import handler from "./active-count.js";

describe("public acquisition-case active-count carrier", () => {
  it("exports the handler selected by the package seam", () => {
    expect(handler).toBe(testerProgramActiveCount);
  });
});
