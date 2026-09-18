// Adapter: resolves a back-in-stock alert's sku to a localized display name via
// the catalog read port, so the marketing email reads "Karma sucha Jagnięcina
// znów dostępny" instead of the raw sku. Names are cosmetic — any catalog failure
// or unknown sku returns null and the handler falls back to a generic label.

import type { CatalogReadPort } from "../../../src/domains/catalog/ports.js";
import type { ProductNameBySkuLookupPort } from "./marketingEmailPorts.js";

export function createCatalogBackedProductNameBySkuLookupPort(
  catalog: CatalogReadPort,
): ProductNameBySkuLookupPort {
  return {
    async lookupNameBySku(sku: string): Promise<string | null> {
      const wanted = sku.trim();
      if (wanted === "") return null;
      try {
        const products = await catalog.listProducts();
        for (const product of products) {
          for (const variant of product.variants) {
            if (variant.sku === wanted) return product.displayName;
          }
        }
      } catch {
        // Degrade to the generic label rather than fail the email.
      }
      return null;
    },
  };
}
