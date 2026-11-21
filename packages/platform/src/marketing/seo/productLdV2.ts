import { canonicalizeCatalogQuantity, type CatalogQuantity, type CatalogQuantityUnit } from "@openlup/core/catalog";
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
  const { unscaled, scale } = canonicalizeCatalogQuantity(product.weight, units);
  const digits = unscaled.replace(/0+$/u, "");
  const exponent = unscaled.length - scale - 1;
  const mantissa = digits.length === 1 ? digits : `${digits[0]}.${digits.slice(1)}`;
  const value = Number(`${unscaled}e-${scale}`);
  if (value.toExponential() !== `${mantissa}e${exponent < 0 ? "" : "+"}${exponent}`)
    throw new RangeError("Product JSON-LD weight cannot be represented exactly in grams.");
  return { ...node, weight: { "@type": "QuantitativeValue", value, unitCode: "GRM" } };
}
