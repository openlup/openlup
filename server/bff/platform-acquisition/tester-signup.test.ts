import { clientsTesterSignup } from "#acquisition-case-routes";
import { describe, expect, it } from "vitest";

import handler from "./tester-signup.js";

describe("public acquisition-case signup carrier", () => {
  it("exports the handler selected by the package seam", () => {
    expect(handler).toBe(clientsTesterSignup);
  });
});
