import { describe, expect, it } from "vitest";
import handler from "./permissions.js";

describe("communications permissions admin BFF route", () => {
  it("loads through the observed admin route wrapper", () => {
    expect(handler).toBeTypeOf("function");
  });
});
