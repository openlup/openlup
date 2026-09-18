import { describe, expect, it } from "vitest";
import * as app from "./pricingBreakdown.js";
import * as core from "@openlup/core/pricing";

describe("pricing breakdown app shim", () => {
  it("re-exports package-owned pricing behavior", () => {
    expect(app.PRICING_COMPONENT_TYPES).toBe(core.PRICING_COMPONENT_TYPES);
    expect(app.buildLineBreakdown).toBe(core.buildLineBreakdown);
    expect(app.buildOrderBreakdown).toBe(core.buildOrderBreakdown);
    expect(app.assertBreakdownInvariant).toBe(core.assertBreakdownInvariant);
  });
});
