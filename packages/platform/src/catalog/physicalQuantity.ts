import {
  CATALOG_QUANTITY_UNITS, CatalogQuantityError, canonicalizeCatalogQuantity, type CatalogQuantityUnit,
} from "@openlup/core/catalog";
import type { CatalogProductTypeDefinition, CatalogQuantity } from "./contracts/productTypes.js";

export function catalogPhysicalUnits(definition: Pick<CatalogProductTypeDefinition, "units">): CatalogQuantityUnit[] {
  return definition.units.flatMap(unit => {
    const factor = unit.factor ?? CATALOG_QUANTITY_UNITS.find(value => value.code === unit.code)?.factor;
    return factor ? [{ ...unit, factor }] : [];
  });
}

/**
 * Convert only an exact, positive mass that fits the legacy signed integer column.
 * @experimental
 */
export function asLegacyIntegralGrams(quantity: CatalogQuantity, units?: readonly CatalogQuantityUnit[]):
  { outcome: "converted"; grams: number } | { outcome: "quantity_requires_v2" } {
  try {
    const value = canonicalizeCatalogQuantity(quantity, units);
    if (value.dimension === "mass" && value.unit === "openlup:g" && value.scale === 0 && BigInt(value.unscaled) <= 2_147_483_647n) {
      return { outcome: "converted", grams: Number(value.unscaled) };
    }
  } catch (error) {
    if (!(error instanceof CatalogQuantityError)) throw error;
  }
  return { outcome: "quantity_requires_v2" };
}
