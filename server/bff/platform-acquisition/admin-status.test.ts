import { adminTesterProgramStatus } from "#acquisition-case-routes";
import { describe, expect, it } from "vitest";

import handler from "./admin-status.js";

describe("admin acquisition-case status carrier", () => {
  it("exports the handler selected by the package seam", () => {
    expect(handler).toBe(adminTesterProgramStatus);
  });
});
