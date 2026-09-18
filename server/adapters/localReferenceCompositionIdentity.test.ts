import { describe, expect, it } from "vitest";
import * as identities from "./localReferenceCompositionIdentity.js";

describe("local reference composition identities", () => {
  it("exports two distinct string identities", () => {
    const values = Object.values(identities);
    expect(values).toHaveLength(2);
    expect(values.every((value) => typeof value === "string")).toBe(true);
    expect(new Set(values).size).toBe(2);
  });
});
