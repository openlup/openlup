import { describe, expect, it } from "vitest";
import { SHIPPING_MODE_AT_CART, SHIPPING_VAT_RATE_KINDS } from "./types.js";

describe("shipping domain primitives", () => {
  it("exposes the canonical mode_at_cart values matching the migration CHECK", () => {
    expect(SHIPPING_MODE_AT_CART).toEqual(["one_time", "subscription", "any"]);
  });

  it("exposes the canonical vat_rate_kind values", () => {
    expect(SHIPPING_VAT_RATE_KINDS).toEqual([
      "fixed",
      "inherit_main_goods",
      "highest_in_cart",
    ]);
  });
});
