import { exactCatalogMassGrams, type CatalogQuantity, type CatalogQuantityUnit } from "@openlup/core/catalog";
import { productLd, type ProductFacts } from "./jsonLd.js";

/**
 * Project declared mass into Product JSON-LD using the caller's weight fact.
 * @experimental
 */
export function productLdV2(origin: string, product: Omit<ProductFacts, "netContent"> & {
  weight?: CatalogQuantity | null;
}, units?: readonly CatalogQuantityUnit[]) {
  const { netContent: _legacy, ...facts } = product as ProductFacts;
  const node = productLd(origin, facts);
  if (product.weight?.dimension !== "mass") return node;
  const value = exactCatalogMassGrams(product.weight, units);
  if (value === null)
    throw new RangeError("Product JSON-LD weight cannot be represented exactly in grams.");
  return { ...node, weight: { "@type": "QuantitativeValue", value, unitCode: "GRM" } };
}
