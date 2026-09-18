import { describe, expect, it } from "vitest";
import { authorizePartnersAdmin } from "./shared.js";

describe("partners admin shared auth", () => {
  it("exposes the central role-aware admin authorizer", () => {
    expect(authorizePartnersAdmin).toBeTypeOf("function");
  });
});
