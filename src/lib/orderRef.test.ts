import { describe, expect, it } from "vitest";

import { formatCustomerOrderReference } from "./orderRef";

describe("formatCustomerOrderReference", () => {
  it("derives OPENLUP-<8hex> from the order_<uuid> form", () => {
    expect(formatCustomerOrderReference("order_08025508-73d5-477a-bb19-c41df85e8444")).toBe(
      "OPENLUP-08025508",
    );
  });

  it("derives OPENLUP-<8hex> from a bare uuid", () => {
    expect(formatCustomerOrderReference("08025508-73d5-477a-bb19-c41df85e8444")).toBe(
      "OPENLUP-08025508",
    );
  });

  it("is idempotent for an already-formatted OPENLUP- ref (CJ01-AD)", () => {
    expect(formatCustomerOrderReference("OPENLUP-08025508")).toBe("OPENLUP-08025508");
    expect(formatCustomerOrderReference("OPENLUP-2431")).toBe("OPENLUP-2431");
  });

  it("uppercases a lowercase OPENLUP- ref without re-deriving it", () => {
    expect(formatCustomerOrderReference("openlup-08025508")).toBe("OPENLUP-08025508");
  });

  it("supports a selected presentation prefix without changing the default", () => {
    const defaultReference = formatCustomerOrderReference("order_08025508-73d5");
    expect(formatCustomerOrderReference("order_08025508-73d5", "ORDER")).toBe("ORDER-08025508");
    expect(formatCustomerOrderReference(defaultReference, "ORDER")).toBe("ORDER-08025508");
    expect(defaultReference).toBe(formatCustomerOrderReference("08025508-73d5"));
  });

  it("never surfaces the raw order_ prefix or dashes", () => {
    const ref = formatCustomerOrderReference("order_08025508-73d5-477a-bb19-c41df85e8444");
    expect(ref).not.toContain("order_");
    expect(ref.replace(/^OPENLUP-/, "")).not.toContain("-");
  });
});
