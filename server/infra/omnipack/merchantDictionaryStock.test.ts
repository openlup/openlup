import { describe, expect, it } from "vitest";
import { readOmnipackStockSkus } from "./merchantDictionaryStock.js";

describe("OmniPack merchant stock dictionary", () => {
  it("derives legacy stage products and known packaging materials", () => {
    expect(readOmnipackStockSkus(undefined, [{ sku: "OPENLUP-BEEF-2KG" }])).toEqual({
      stockSkus: [
        { sku: "OPENLUP-BEEF-2KG", inventoryClass: "sellable" },
        { sku: "INSERTopenlup", inventoryClass: "packaging" },
        { sku: "TASMAopenlup", inventoryClass: "packaging" },
      ],
      blockers: [],
    });
  });

  it("rejects empty SKUs and unsupported inventory classes", () => {
    expect(readOmnipackStockSkus([
      { sku: " ", inventoryClass: "sellable" },
      { sku: "UNKNOWN", inventoryClass: "other" },
    ], [])).toEqual({
      stockSkus: [],
      blockers: [
        { reason: "merchant_dictionary_invalid_value", target: "stockSkus.0.sku", severity: "BLOCKED" },
        { reason: "merchant_dictionary_invalid_value", target: "stockSkus.UNKNOWN.inventoryClass", severity: "BLOCKED" },
      ],
    });
  });
});
