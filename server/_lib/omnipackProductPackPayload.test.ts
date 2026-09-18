import { describe, expect, it } from "vitest";
import {
  OmnipackProductPackPayloadError,
  buildOmnipackProductPackPayload,
  omnipackPackKindForQuantity,
} from "./omnipackProductPackPayload.js";

describe("buildOmnipackProductPackPayload", () => {
  it("builds a unit pack payload (quantity 1)", () => {
    expect(buildOmnipackProductPackPayload({ ean: "5908121193005", quantity: 1 })).toEqual({
      ean: "5908121193005",
      quantity: 1,
    });
  });

  it("builds a collective carton payload (quantity > 1)", () => {
    expect(buildOmnipackProductPackPayload({ ean: "5908121193999", quantity: 12 })).toEqual({
      ean: "5908121193999",
      quantity: 12,
    });
  });

  it("trims and requires a non-empty EAN", () => {
    expect(buildOmnipackProductPackPayload({ ean: "  5908121193005  ", quantity: 1 }).ean).toBe("5908121193005");
    expect(() => buildOmnipackProductPackPayload({ ean: " ", quantity: 1 })).toThrow(OmnipackProductPackPayloadError);
    expect(() => buildOmnipackProductPackPayload({ ean: " ", quantity: 1 })).toThrow(/missing_ean/);
  });

  it("rejects a non-positive or non-integer quantity", () => {
    expect(() => buildOmnipackProductPackPayload({ ean: "5908121193005", quantity: 0 })).toThrow(/invalid_quantity/);
    expect(() => buildOmnipackProductPackPayload({ ean: "5908121193005", quantity: -1 })).toThrow(/invalid_quantity/);
    expect(() => buildOmnipackProductPackPayload({ ean: "5908121193005", quantity: 1.5 })).toThrow(/invalid_quantity/);
  });
});

describe("omnipackPackKindForQuantity", () => {
  it("classifies quantity 1 as a unit and quantity > 1 as a collective carton", () => {
    expect(omnipackPackKindForQuantity(1)).toBe("unit");
    expect(omnipackPackKindForQuantity(2)).toBe("collective");
    expect(omnipackPackKindForQuantity(24)).toBe("collective");
  });
});
