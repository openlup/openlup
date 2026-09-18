import { describe, expect, it } from "vitest";
import { catalogProductSchema } from "./contracts.js";
import {
  mapStaticAllergensToCatalogAllergens,
  mapStaticProductToCatalogProduct,
  mapStaticProductsToCatalogProducts,
} from "./staticProductAdapter.js";

const routes = {
  pl: {
    lamb: "jagniecina",
    beef: "wolowina",
  },
  en: {
    lamb: "lamb",
    beef: "beef",
  },
};
const config = { skuPrefix: "CORE" };

const lamb = {
  slug: "lamb",
  name: "Lamb + EntoPro™ Recipe",
  lineName: "Health & Longevity Diet",
  species: "Dog",
  format: "Complete wet pet food for adult dogs",
  weight: "400 g",
  ingredients:
    "56,26% jagnięcina, 30% EntoPro™ pulp, 10% bulion z jagnięciny, olej z łososia 0,60%",
  ingredientsEn:
    "56.26% lamb, 30% EntoPro™ pulp, 10% lamb broth, salmon oil 0.60%",
  ingredientCards: [
    {
      name: "Jagnięcina",
      pct: "56,26%",
      role: "Główne źródło białka",
      body: "",
      allergenSlugs: ["lamb" as const],
    },
    {
      name: "Olej z łososia",
      pct: "0,60%",
      role: "Omega-3",
      body: "",
      allergenSlugs: ["salmon_oil" as const],
    },
  ],
  kcalPer100g: 123,
  allergenSlugs: ["lamb" as const, "salmon_oil" as const],
};

describe("static product catalog adapter", () => {
  it("maps a published legacy product into a catalog product", () => {
    const product = mapStaticProductToCatalogProduct(lamb, routes, config);

    expect(catalogProductSchema.parse(product)).toEqual(product);
    expect(product).toMatchObject({
      id: "catalog_product_lamb",
      slug: "lamb",
      displayName: "Lamb + EntoPro™",
      species: "dog",
      publicationStatus: "published",
      route: {
        pl: "/psy/jagniecina",
        en: "/dogs/lamb",
      },
      primarySku: {
        sku: "CORE-DOG-LAMB-CAN-400G",
        variantId: "variant_lamb_400g_can",
        netWeightGrams: 400,
        pricing: {
          status: "not_configured",
          listPrice: null,
        },
      },
      composition: {
        rawIngredients:
          "56,26% jagnięcina, 30% EntoPro™ pulp, 10% bulion z jagnięciny, olej z łososia 0,60%",
        rawIngredientsEn:
          "56.26% lamb, 30% EntoPro™ pulp, 10% lamb broth, salmon oil 0.60%",
        allergenSlugs: ["lamb", "salmon_oil"],
        kcalPer100g: 123,
      },
    });
    expect(product.composition.items[0]).toMatchObject({
      name: "Jagnięcina",
      pctText: "56,26%",
      percentage: 56.26,
      allergenSlugs: ["lamb"],
    });
  });

  it("keeps coming soon products visible but not price-configured", () => {
    const product = mapStaticProductToCatalogProduct(
      {
        ...lamb,
        slug: "beef",
        name: "Beef + EntoPro™ Recipe",
        status: "coming_soon",
      },
      routes,
      config,
    );

    expect(product.publicationStatus).toBe("coming_soon");
    expect(product.primarySku.publicationStatus).toBe("coming_soon");
    expect(product.primarySku.pricing.status).toBe("not_configured");
    expect(product.primarySku.pricing.externalRefs.paymentProviderPriceId).toBeNull();
  });

  it("maps the product record without changing source order", () => {
    const products = mapStaticProductsToCatalogProducts(
      {
        lamb,
        beef: {
          ...lamb,
          slug: "beef",
          name: "Beef + EntoPro™ Recipe",
          status: "coming_soon",
        },
      },
      routes,
      config,
    );

    expect(products.map((product) => product.slug)).toEqual(["lamb", "beef"]);
  });

  it("maps allergen taxonomy to product and SKU ingredient links", () => {
    const products = mapStaticProductsToCatalogProducts({ lamb }, routes, config);
    const allergens = mapStaticAllergensToCatalogAllergens(
      [
        { slug: "lamb", name: "Jagnięcina", nameEn: "Lamb", category: "animal_protein" },
        { slug: "salmon_oil", name: "Olej z łososia", nameEn: "Salmon oil", category: "fish" },
      ],
      products,
    );

    expect(allergens).toEqual([
      {
        slug: "lamb",
        name: "Jagnięcina",
        nameEn: "Lamb",
        category: "animal_protein",
        products: [
          {
            productSlug: "lamb",
            sku: "CORE-DOG-LAMB-CAN-400G",
            ingredientNames: ["Jagnięcina"],
          },
        ],
      },
      {
        slug: "salmon_oil",
        name: "Olej z łososia",
        nameEn: "Salmon oil",
        category: "fish",
        products: [
          {
            productSlug: "lamb",
            sku: "CORE-DOG-LAMB-CAN-400G",
            ingredientNames: ["Olej z łososia"],
          },
        ],
      },
    ]);
  });

  it("fails fast on unsupported static product assumptions", () => {
    expect(() =>
      mapStaticProductToCatalogProduct(
        {
          ...lamb,
          weight: "14 oz",
        },
        routes,
        config,
      ),
    ).toThrow("Unsupported catalog weight");
  });

  it("fails fast on unsupported SKU prefix assumptions", () => {
    expect(() => mapStaticProductToCatalogProduct(lamb, routes, { skuPrefix: "bad-prefix" })).toThrow(
      "Unsupported catalog SKU prefix",
    );
  });
});
