import { describe, expect, it } from "vitest";

import { shouldRenderBelowFold } from "./renderPolicy";

describe("render policy", () => {
  it("includes deferred SEO content in production SSG markup", () => {
    expect(shouldRenderBelowFold("ssg", "production")).toBe(true);
    expect(shouldRenderBelowFold("csr", "production")).toBe(false);
    expect(shouldRenderBelowFold("csr", "test")).toBe(true);
  });
});
