import { describe, expect, it } from "vitest";

import { catalogProductSchema } from "./contracts.js";
import {
  catalogProductIdSchema,
  skuSchema,
  slugSchema,
  variantIdSchema,
} from "./slugFormat.js";

describe("catalog slug/identifier format primitives (open value space)", () => {
  it("accepts launch slugs AND never-seen slugs", () => {
    for (const s of ["lamb", "venison", "salmon_oil", "duck", "rabbit-stew", "insect-protein-7"]) {
      expect(slugSchema.safeParse(s).success).toBe(true);
    }
  });

  it("rejects malformed slugs", () => {
    for (const s of ["", "Duck", "has space", "weird!", "-leading", "_leading", "a".repeat(65)]) {
      expect(slugSchema.safeParse(s).success).toBe(false);
    }
  });

  it("accepts the legacy SKU format AND other well-formed SKUs", () => {
    for (const s of ["OPENLUP-DOG-LAMB-CAN-400G", "DUCK-800", "sku_123.v2"]) {
      expect(skuSchema.safeParse(s).success).toBe(true);
    }
    expect(skuSchema.safeParse("bad sku").success).toBe(false);
  });

  it("accepts DB uuids AND legacy ids for product/variant ids", () => {
    const uuid = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    for (const id of [uuid, "catalog_product_lamb"]) {
      expect(catalogProductIdSchema.safeParse(id).success).toBe(true);
    }
    for (const id of [uuid, "variant_lamb_400g_can"]) {
      expect(variantIdSchema.safeParse(id).success).toBe(true);
    }
  });
});

describe("catalogProductSchema with a novel product (admin/agent-added)", () => {
  const novelSku = {
    sku: "DUCK-001",
    productSlug: "duck",
    variantId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    publicationStatus: "published",
    unit: "can",
    netWeightGrams: 400,
    pricing: {
      status: "not_configured",
      listPrice: null,
      taxCategory: "pet_food",
      externalRefs: { paymentProviderPriceId: null, inventoryProviderSku: null },
    },
  };

  it("parses a never-seen slug + uuid id (would have failed the old enum/regex)", () => {
    const result = catalogProductSchema.safeParse({
      id: "a1b2c3d4-0000-4000-8000-000000000001",
      slug: "duck",
      displayName: "Duck recipe",
      lineName: "Health & Longevity Diet",
      species: "dog",
      publicationStatus: "published",
      route: { pl: "/psy/kaczka", en: "/dogs/duck" },
      primarySku: novelSku,
      variants: [novelSku],
      composition: {
        rawIngredients: "70% duck",
        rawIngredientsEn: "70% duck",
        items: [
          {
            name: "Duck",
            pctText: "70%",
            percentage: 70,
            role: "protein",
            body: "",
            allergenSlugs: ["duck"],
          },
        ],
        allergenSlugs: ["duck"],
        kcalPer100g: 120,
      },
      metadata: { format: "Complete wet pet food", kcalPer100g: 120, legacyStatus: null },
    });

    expect(result.success).toBe(true);
  });
});
