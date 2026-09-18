import { describe, expect, it } from "vitest";

import {
  COMMERCE_PRODUCT_COMPATIBILITY_CONTRACT_VERSION,
  commerceProductCompatibilityResponseSchema,
} from "./productCompatibilityContracts.js";

describe("commerceProductCompatibilityResponseSchema", () => {
  it("accepts selectable products with conflict allergens", () => {
    const result = commerceProductCompatibilityResponseSchema.safeParse({
      contractVersion: COMMERCE_PRODUCT_COMPATIBILITY_CONTRACT_VERSION,
      products: [{
        variantId: "variant-salmon-400",
        sku: "opaque:salmon-launch.v1",
        slug: "salmon",
        selectable: false,
        conflictAllergenSlugs: ["chicken"],
      }],
    });

    expect(result.success).toBe(true);
  });

  it("accepts explicit offer visibility fields", () => {
    const result = commerceProductCompatibilityResponseSchema.safeParse({
      contractVersion: COMMERCE_PRODUCT_COMPATIBILITY_CONTRACT_VERSION,
      products: [{
        variantId: "variant-salmon-400",
        sku: "opaque:salmon-launch.v1",
        slug: "salmon",
        selectable: true,
        purchaseAvailability: "out_of_stock",
        visibleInConfigurator: false,
        conflictAllergenSlugs: [],
      }],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.products[0].purchaseAvailability).toBe("out_of_stock");
      expect(result.data.products[0].visibleInConfigurator).toBe(false);
    }
  });

  it("accepts well-formed unknown allergen slugs (open value space)", () => {
    // Slugs validate by FORMAT, not a closed enum, so an admin/agent-added
    // allergen flows through without a code change. See slugFormat.ts.
    const result = commerceProductCompatibilityResponseSchema.safeParse({
      contractVersion: COMMERCE_PRODUCT_COMPATIBILITY_CONTRACT_VERSION,
      products: [{
        variantId: "variant-salmon-400",
        sku: "opaque:salmon-launch.v1",
        slug: "salmon",
        selectable: false,
        conflictAllergenSlugs: ["duck"],
      }],
    });

    expect(result.success).toBe(true);
  });

  it("rejects malformed allergen slugs", () => {
    const result = commerceProductCompatibilityResponseSchema.safeParse({
      contractVersion: COMMERCE_PRODUCT_COMPATIBILITY_CONTRACT_VERSION,
      products: [{
        variantId: "variant-salmon-400",
        sku: "opaque:salmon-launch.v1",
        slug: "salmon",
        selectable: false,
        conflictAllergenSlugs: ["Not A Slug!"],
      }],
    });

    expect(result.success).toBe(false);
  });
});
