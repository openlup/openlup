import { describe, expect, it, vi } from "vitest";
import { CATALOG_CONTRACT_VERSION } from "./contracts";
import {
  getCatalogProduct,
  listCatalogAllergens,
  listCatalogProducts,
} from "./catalogClient";

const product = {
  id: "catalog_product_lamb",
  slug: "lamb",
  displayName: "Lamb + EntoPro™",
  lineName: "Health & Longevity Diet",
  species: "dog",
  publicationStatus: "published",
  route: { pl: "/psy/jagniecina", en: "/dogs/lamb" },
  primarySku: {
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
      externalRefs: { paymentProviderPriceId: null, inventoryProviderSku: null },
    },
  },
  variants: [
    {
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
        externalRefs: { paymentProviderPriceId: null, inventoryProviderSku: null },
      },
    },
  ],
  composition: {
    rawIngredients: "56,26% jagnięcina",
    rawIngredientsEn: "56.26% lamb",
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

describe("catalog BFF client", () => {
  it("fetches catalog products through the typed BFF client", async () => {
    const fetcher = createFetcher({
      contractVersion: CATALOG_CONTRACT_VERSION,
      products: [product],
    });

    await expect(listCatalogProducts({ fetcher })).resolves.toMatchObject({
      contractVersion: CATALOG_CONTRACT_VERSION,
      products: [{ slug: "lamb" }],
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/catalog/products",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("fetches a single catalog product by slug", async () => {
    const fetcher = createFetcher({
      contractVersion: CATALOG_CONTRACT_VERSION,
      product,
    });

    await expect(getCatalogProduct("lamb", { fetcher })).resolves.toMatchObject({
      product: { slug: "lamb" },
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/catalog/products/lamb",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("fetches catalog allergen links", async () => {
    const fetcher = createFetcher({
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

    await expect(listCatalogAllergens({ fetcher })).resolves.toMatchObject({
      allergens: [{ slug: "lamb" }],
    });
  });

  it("throws on BFF errors and malformed envelopes", async () => {
    const failed = createRawFetcher({
      ok: false,
      error: { code: "NOT_FOUND", message: "Catalog product not found" },
    });
    const malformed = createRawFetcher({ ok: true, data: { products: [] } });

    await expect(listCatalogProducts({ fetcher: failed })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(listCatalogProducts({ fetcher: malformed })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});

function createFetcher(data: unknown) {
  return createRawFetcher({ ok: true, data });
}

function createRawFetcher(envelope: unknown) {
  return vi.fn().mockResolvedValue({
    status: 200,
    json: () => Promise.resolve(envelope),
  });
}
