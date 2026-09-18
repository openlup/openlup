import { describe, expect, it } from "vitest";
import {
  CATALOG_CONTRACT_VERSION,
  catalogAllergenListResponseSchema,
  catalogPricingMetadataSchema,
  catalogProductListResponseSchema,
  catalogProductSchema,
} from "./contracts.js";

const sku = {
  sku: "OPENLUP-DOG-LAMB-CAN-400G",
  productSlug: "lamb",
  variantId: "variant_lamb_400g_can",
  publicationStatus: "published",
  unit: "can",
  netWeightGrams: 400,
  pricing: {
    status: "not_configured",
    listPrice: null,
    taxCategory: "pet_food",
    externalRefs: {
      paymentProviderPriceId: null,
      inventoryProviderSku: null,
    },
  },
};

const product = {
  id: "catalog_product_lamb",
  slug: "lamb",
  displayName: "Lamb + EntoPro™",
  lineName: "Health & Longevity Diet",
  species: "dog",
  publicationStatus: "published",
  route: {
    pl: "/psy/jagniecina",
    en: "/dogs/lamb",
  },
  primarySku: sku,
  variants: [sku],
  composition: {
    rawIngredients:
      "56,26% jagnięcina, 30% EntoPro™ pulp, 10% bulion z jagnięciny",
    rawIngredientsEn:
      "56.26% lamb, 30% EntoPro™ pulp, 10% lamb broth",
    items: [
      {
        name: "Jagnięcina",
        pctText: "56,26%",
        percentage: 56.26,
        role: "Główne źródło białka",
        body: "",
        allergenSlugs: ["lamb"],
      },
    ],
    allergenSlugs: ["lamb"],
    kcalPer100g: 123,
  },
  metadata: {
    format: "Complete wet pet food for adult dogs",
    kcalPer100g: 123,
    legacyStatus: null,
  },
};

describe("catalog contracts", () => {
  it("accepts the catalog product response shape", () => {
    expect(
      catalogProductListResponseSchema.parse({
        contractVersion: CATALOG_CONTRACT_VERSION,
        products: [product],
      }),
    ).toEqual({
      contractVersion: CATALOG_CONTRACT_VERSION,
      products: [product],
    });
  });

  it("accepts allergen links grounded in catalog products", () => {
    const response = catalogAllergenListResponseSchema.parse({
      contractVersion: CATALOG_CONTRACT_VERSION,
      allergens: [
        {
          slug: "lamb",
          name: "Jagnięcina",
          nameEn: "Lamb",
          category: "animal_protein",
          products: [
            {
              productSlug: "lamb",
              sku: "OPENLUP-DOG-LAMB-CAN-400G",
              ingredientNames: ["Jagnięcina"],
            },
          ],
        },
      ],
    });

    expect(response.allergens[0]?.products[0]?.productSlug).toBe("lamb");
  });

  it("rejects a primary SKU that is not present in variants", () => {
    const invalid = {
      ...product,
      variants: [
        {
          ...sku,
          sku: "OPENLUP-DOG-BEEF-CAN-400G",
          productSlug: "beef",
        },
      ],
    };

    expect(catalogProductSchema.safeParse(invalid).success).toBe(false);
  });

  it("requires configured prices to include an amount", () => {
    const invalid = {
      status: "configured",
      listPrice: null,
      taxCategory: "pet_food",
      externalRefs: {
        paymentProviderPriceId: "price_123",
        inventoryProviderSku: null,
      },
    };

    expect(catalogPricingMetadataSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects malformed SKU strings", () => {
    const invalid = {
      ...product,
      primarySku: {
        ...sku,
        sku: "lamb-400",
      },
    };

    expect(catalogProductSchema.safeParse(invalid).success).toBe(false);
  });
});
