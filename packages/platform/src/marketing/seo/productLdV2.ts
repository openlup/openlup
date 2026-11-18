import { canonicalizeCatalogQuantity, type CatalogQuantity } from "@openlup/core/catalog";
import { productLd, type ProductFacts } from "./jsonLd.js";

/**
 * Project declared mass into Product JSON-LD using the caller's weight fact.
 * @experimental
 */
export function productLdV2(origin: string, product: Omit<ProductFacts, "netContent"> & {
  weight?: CatalogQuantity | null;
}) {
  const { netContent: _legacy, ...facts } = product as ProductFacts;
  const node = productLd(origin, facts);
  if (product.weight?.dimension !== "mass") return node;
  const mass = canonicalizeCatalogQuantity(product.weight);
  const value = Number(mass.unscaled) / 10 ** mass.scale;
  return { ...node, weight: { "@type": "QuantitativeValue", value, unitCode: "GRM" } };
}
