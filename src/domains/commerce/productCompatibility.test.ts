import { describe, expect, it } from "vitest";

import { buildProductCompatibility } from "./productCompatibility.js";
import type { RecommendationVariant } from "./recommendationEngine.js";

describe("buildProductCompatibility", () => {
  it("marks products selectable only when no composition allergen conflicts", () => {
    expect(buildProductCompatibility(variants, ["chicken"])).toEqual([
      expect.objectContaining({
        slug: "turkey",
        selectable: true,
        conflictAllergenSlugs: [],
      }),
      expect.objectContaining({
        slug: "salmon",
        selectable: false,
        conflictAllergenSlugs: ["chicken"],
      }),
    ]);
  });

  it("splits salmon allergy from salmon oil allergy", () => {
    const salmonResult = buildProductCompatibility(variants, ["salmon"]);
    expect(salmonResult.find((product) => product.slug === "turkey")).toMatchObject({
      selectable: true,
      conflictAllergenSlugs: [],
    });
    expect(salmonResult.find((product) => product.slug === "salmon")).toMatchObject({
      selectable: false,
      conflictAllergenSlugs: ["salmon"],
    });

    expect(buildProductCompatibility(variants, ["salmon_oil"])).toEqual([
      expect.objectContaining({
        slug: "turkey",
        selectable: false,
        conflictAllergenSlugs: ["salmon_oil"],
      }),
      expect.objectContaining({
        slug: "salmon",
        selectable: false,
        conflictAllergenSlugs: ["salmon_oil"],
      }),
    ]);
  });

  it("projects offer availability onto configurator visibility", () => {
    const result = buildProductCompatibility(variants, [], new Map([
      ["opaque:turkey-launch.v1", {
        sku: "opaque:turkey-launch.v1",
        productSlug: "turkey",
        variantId: "variant-turkey-400",
        status: "low_stock",
        visibleInConfigurator: true,
        sellableNow: 2,
        reasonCode: "low_stock",
        source: "test",
      }],
      ["opaque:salmon-launch.v1", {
        sku: "opaque:salmon-launch.v1",
        productSlug: "salmon",
        variantId: "variant-salmon-400",
        status: "out_of_stock",
        visibleInConfigurator: false,
        sellableNow: 0,
        reasonCode: "out_of_stock",
        source: "test",
      }],
    ]));

    expect(result.find((product) => product.slug === "turkey")).toMatchObject({
      purchaseAvailability: "low_stock",
      visibleInConfigurator: true,
    });
    expect(result.find((product) => product.slug === "salmon")).toMatchObject({
      purchaseAvailability: "out_of_stock",
      visibleInConfigurator: false,
    });
  });
});

const variants: RecommendationVariant[] = [
  {
    variantId: "variant-turkey-400",
    sku: "opaque:turkey-launch.v1",
    slug: "turkey",
    kcalPer100g: 123,
    netWeightG: 400,
    allergenSlugs: ["turkey", "salmon_oil", "yeast"],
  },
  {
    variantId: "variant-salmon-400",
    sku: "opaque:salmon-launch.v1",
    slug: "salmon",
    kcalPer100g: 123,
    netWeightG: 400,
    allergenSlugs: ["salmon", "salmon_oil", "chicken", "yeast"],
  },
];
