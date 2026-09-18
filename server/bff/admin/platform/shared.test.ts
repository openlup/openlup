import { describe, expect, it } from "vitest";
import { authorizePlatformAdmin } from "./shared.js";

describe("platform admin shared auth", () => {
  it("exposes the central role-aware admin authorizer", () => {
    expect(authorizePlatformAdmin).toBeTypeOf("function");
  });
});
