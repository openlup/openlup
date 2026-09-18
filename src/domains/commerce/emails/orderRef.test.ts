import { describe, expect, it } from "vitest";
import { formatCustomerOrderReference } from "./orderRef.js";

describe("formatCustomerOrderReference", () => {
  it("strips the order_ prefix + dashes and uppercases the first 8 UUID chars", () => {
    expect(formatCustomerOrderReference("order_0f8c5b1e-7a2d-4c3b-9e6f-1a2b3c4d5e6f")).toBe("OPENLUP-0F8C5B1E");
  });

  it("handles a bare order id (no order_ prefix)", () => {
    expect(formatCustomerOrderReference("0f8c5b1e7a2d4c3b9e6f1a2b3c4d5e6f")).toBe("OPENLUP-0F8C5B1E");
  });

  it("returns the whole thing when shorter than 8 chars", () => {
    expect(formatCustomerOrderReference("order_abc123")).toBe("OPENLUP-ABC123");
  });

  it("never contains the raw order_ prefix or dashes", () => {
    const ref = formatCustomerOrderReference("order_0f8c5b1e-7a2d-4c3b-9e6f-1a2b3c4d5e6f");
    expect(ref).not.toContain("order_");
    expect(ref.replace(/^OPENLUP-/, "")).not.toContain("-");
    expect(ref).toMatch(/^OPENLUP-[A-Z0-9]+$/);
  });
});
