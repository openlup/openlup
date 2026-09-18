import { adminClientsTesters } from "#acquisition-case-routes";
import { describe, expect, it } from "vitest";

import handler from "./admin-testers.js";

describe("admin acquisition-case list carrier", () => {
  it("exports the handler selected by the package seam", () => {
    expect(handler).toBe(adminClientsTesters);
  });
});
