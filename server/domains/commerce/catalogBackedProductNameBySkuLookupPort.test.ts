import { describe, expect, it, vi } from "vitest";
import type { CatalogReadPort } from "../../../src/domains/catalog/ports.js";
import type { CatalogProduct, CatalogSku } from "../../../src/domains/catalog/types.js";
import { createCatalogBackedProductNameBySkuLookupPort } from "./catalogBackedProductNameBySkuLookupPort.js";

function sku(value: string): CatalogSku {
  return { sku: value } as CatalogSku;
}

function product(displayName: string, skus: string[]): CatalogProduct {
  const variants = skus.map(sku);
  return { displayName, primarySku: variants[0], variants } as CatalogProduct;
}

function catalogWith(products: CatalogProduct[], listImpl?: () => Promise<CatalogProduct[]>): CatalogReadPort {
  return {
    listProducts: listImpl ?? vi.fn(async () => products),
    getProductBySlug: vi.fn(async () => null),
    listAllergens: vi.fn(async () => []),
  };
}

describe("catalogBackedProductNameBySkuLookupPort", () => {
  it("resolves a sku (incl. non-primary variants) to the product display name", async () => {
    const port = createCatalogBackedProductNameBySkuLookupPort(
      catalogWith([
        product("Karma sucha Jagnięcina", ["OPENLUP-LAMB-5KG", "OPENLUP-LAMB-12KG"]),
        product("Karma sucha Łosoś", ["OPENLUP-SALMON-2KG"]),
      ]),
    );

    expect(await port.lookupNameBySku("OPENLUP-LAMB-5KG")).toBe("Karma sucha Jagnięcina");
    expect(await port.lookupNameBySku("OPENLUP-LAMB-12KG")).toBe("Karma sucha Jagnięcina");
    expect(await port.lookupNameBySku("OPENLUP-SALMON-2KG")).toBe("Karma sucha Łosoś");
  });

  it("returns null for an unknown sku (the email then uses a generic label)", async () => {
    const port = createCatalogBackedProductNameBySkuLookupPort(
      catalogWith([product("Karma sucha Jagnięcina", ["OPENLUP-LAMB-5KG"])]),
    );

    expect(await port.lookupNameBySku("hidden-preview-8-9fb477fa-back_in_stock")).toBeNull();
  });

  it("returns null without hitting the catalog for a blank sku", async () => {
    const listProducts = vi.fn(async () => []);
    const port = createCatalogBackedProductNameBySkuLookupPort(catalogWith([], listProducts));

    expect(await port.lookupNameBySku("   ")).toBeNull();
    expect(listProducts).not.toHaveBeenCalled();
  });

  it("degrades to null when the catalog read throws (names are cosmetic)", async () => {
    const port = createCatalogBackedProductNameBySkuLookupPort(
      catalogWith([], async () => {
        throw new Error("catalog down");
      }),
    );

    await expect(port.lookupNameBySku("OPENLUP-LAMB-5KG")).resolves.toBeNull();
  });
});
