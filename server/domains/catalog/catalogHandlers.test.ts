import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { CATALOG_CONTRACT_VERSION } from "../../../src/domains/catalog/contracts.js";
import type { CatalogReadPort } from "../../../src/domains/catalog/ports.js";
import {
  joinCatalogListPricing,
  type CatalogExactOneTimeBasePriceReadPort,
} from "./catalogPricingJoin.js";
import type { CatalogProduct } from "../../../src/domains/catalog/types.js";
import {
  createCatalogAllergensListHandler,
  createCatalogProductReadHandler,
  createCatalogProductsListHandler,
} from "./catalogHandlers.js";

const product: CatalogProduct = {
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

describe("catalog BFF handlers", () => {
  it("returns products through the shared envelope", async () => {
    const res = createResponse();

    await createCatalogProductsListHandler({ readPort: createPort() })(
      request("GET"),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "public, max-age=0, s-maxage=5, must-revalidate");
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: {
        contractVersion: CATALOG_CONTRACT_VERSION,
        products: [product],
      },
      meta: { contractVersion: CATALOG_CONTRACT_VERSION },
    });
  });

  it("answers 200 with the SKU unpriced when the batch reader degrades it", async () => {
    // ⛔ REGRESSION PIN, handler half. Before this wave a single SKU the strict
    // price authority could not anchor threw out of the batch reader, this
    // handler's bare catch turned it into UPSTREAM_UNAVAILABLE, and the ENTIRE
    // listing answered 503. This pins the half that lives here: an unpriced SKU
    // reaching the handler is a 200, never a 503. The other half - that the batch
    // readers no longer throw at all - is pinned in each adapter's own test,
    // which is where it can be asserted without a domain->adapter import.
    // Composed over the real join so the absence path is not mocked away.
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const res = createResponse();
    const degradingReader: CatalogExactOneTimeBasePriceReadPort = {
      // Empty map = every variant refused per-SKU, exactly as both adapters now do.
      async listExactOneTimeBasePrices() { return new Map(); },
    };
    const readPort: CatalogReadPort = {
      listProducts: async () => joinCatalogListPricing(
        [structuredClone(product)], degradingReader, undefined, "2026-08-12T00:00:00.000Z",
      ),
      getProductBySlug: async () => null,
      listAllergens: async () => [],
    };

    try {
      await createCatalogProductsListHandler({ readPort })(request("GET"), res);
    } finally {
      info.mockRestore();
    }

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.status).not.toHaveBeenCalledWith(503);
    const body = vi.mocked(res.json).mock.calls[0]?.[0] as {
      ok: boolean; data: { products: CatalogProduct[] };
    };
    expect(body.ok).toBe(true);
    expect(body.data.products[0]!.variants.every(
      (variant) => variant.pricing.status === "not_configured" && variant.pricing.listPrice === null,
    )).toBe(true);
  });

  it("returns a single product by slug", async () => {
    const readPort = createPort();
    const res = createResponse();

    await createCatalogProductReadHandler({ readPort })(
      request("GET", { slug: "lamb" }),
      res,
    );

    expect(readPort.getProductBySlug).toHaveBeenCalledWith("lamb");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "public, max-age=0, s-maxage=5, must-revalidate");
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({ product }),
      }),
    );
  });

  it("returns catalog allergens grounded in product links", async () => {
    const res = createResponse();

    await createCatalogAllergensListHandler({ readPort: createPort() })(
      request("GET"),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "public, s-maxage=300, stale-while-revalidate=86400");
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: {
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
      },
      meta: { contractVersion: CATALOG_CONTRACT_VERSION },
    });
  });

  it("rejects unsupported methods and missing or unknown slugs", async () => {
    const method = createResponse();
    await createCatalogProductsListHandler({ readPort: createPort() })(
      request("POST"),
      method,
    );

    const missing = createResponse();
    await createCatalogProductReadHandler({ readPort: createPort() })(
      request("GET"),
      missing,
    );

    // Open value space: a well-formed unknown slug is not a validation error —
    // "not found" is decided by the read port returning null, not by an enum.
    const unknown = createResponse();
    await createCatalogProductReadHandler({ readPort: createPort({ product: null }) })(
      request("GET", { slug: "duck" }),
      unknown,
    );

    expect(method.setHeader).toHaveBeenCalledWith("Allow", "GET");
    expect(method.status).toHaveBeenCalledWith(405);
    expect(missing.status).toHaveBeenCalledWith(400);
    expect(unknown.status).toHaveBeenCalledWith(404);
  });

  it("maps invalid port responses and upstream failures", async () => {
    const invalid = createResponse();
    await createCatalogProductsListHandler({
      readPort: createPort({ products: [{ ...product, id: "" }] }),
    })(request("GET"), invalid);

    const failed = createResponse();
    await createCatalogAllergensListHandler({
      readPort: createPort(new Error("catalog unavailable")),
    })(request("GET"), failed);

    expect(invalid.status).toHaveBeenCalledWith(502);
    expect(failed.status).toHaveBeenCalledWith(503);
  });
});

function request(
  method: string,
  query: Record<string, string | undefined> = {},
): VercelRequest {
  return { method, query } as unknown as VercelRequest;
}

function createPort(result?: unknown): CatalogReadPort {
  return {
    listProducts: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      if (result && typeof result === "object" && "products" in result) {
        return (result as { products: unknown }).products;
      }
      return [product];
    }),
    getProductBySlug: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      if (result && typeof result === "object" && "product" in result) {
        return (result as { product: unknown }).product;
      }
      return product;
    }),
    listAllergens: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      if (result && typeof result === "object" && "allergens" in result) {
        return (result as { allergens: unknown }).allergens;
      }
      return [
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
      ];
    }),
  };
}

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;

  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
