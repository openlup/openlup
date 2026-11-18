import { CATALOG_CANONICAL_UNITS, canonicalizeCatalogQuantity, type CatalogQuantity, type CatalogQuantityDimension } from "@openlup/core/catalog";
import { CommerceQuoteCatalogReadError } from "../pricing/index.js";
import { asLegacyIntegralGrams } from "./physicalQuantity.js";

/** Values from one managed read of the SKU and its existing current document. @experimental */
export interface ManagedCatalogContentRow {
  productId: string;
  skuProductId: string;
  currentDocumentRevisionId: string | null;
  document: { id: string; productId: string; digest: string };
  legacyNetWeightG: number;
  dimension: CatalogQuantityDimension | null;
  canonicalAmount: string | null;
  grossGrams: string | null;
  projectedGrams: number | null;
}

const invalid = () => new CommerceQuoteCatalogReadError("catalog_revision_invalid");

function exactQuantity(dimension: CatalogQuantityDimension, amount: string): CatalogQuantity {
  const parts = /^([0-9]{1,40})(?:\.([0-9]{1,12}))?$/u.exec(amount);
  if (!parts) throw invalid();
  const fractional = (parts[2] ?? "").replace(/0+$/u, "");
  const unscaled = `${parts[1]}${fractional}`.replace(/^0+/u, "");
  try { return canonicalizeCatalogQuantity({ dimension, unit: CATALOG_CANONICAL_UNITS[dimension], unscaled, scale: fractional.length }); }
  catch { throw invalid(); }
}

/** Project exact content under the existing managed document pointer. Hosts opt in explicitly. @experimental */
export function projectManagedCatalogContent(row: ManagedCatalogContentRow): {
  netContent: CatalogQuantity; grossMass: CatalogQuantity | null; documentRevision: ManagedCatalogContentRow["document"];
} {
  if (row.productId !== row.skuProductId || row.productId !== row.document.productId
    || row.currentDocumentRevisionId !== row.document.id || !/^[a-f0-9]{64}$/u.test(row.document.digest)) {
    throw new CommerceQuoteCatalogReadError("catalog_authority_changed");
  }
  if (row.dimension === null) {
    if (row.canonicalAmount !== null || row.projectedGrams !== null || row.grossGrams !== null || !Number.isSafeInteger(row.legacyNetWeightG)) throw invalid();
    return { netContent: exactQuantity("mass", String(row.legacyNetWeightG)), grossMass: null, documentRevision: row.document };
  }
  if (row.canonicalAmount === null || !Object.hasOwn(CATALOG_CANONICAL_UNITS, row.dimension)) throw invalid();
  const netContent = exactQuantity(row.dimension, row.canonicalAmount);
  const legacy = asLegacyIntegralGrams(netContent);
  if (row.projectedGrams !== (legacy.outcome === "converted" ? legacy.grams : null)
    || (legacy.outcome === "converted" && row.legacyNetWeightG !== legacy.grams)) throw invalid();
  return { netContent, grossMass: row.grossGrams === null ? null : exactQuantity("mass", row.grossGrams), documentRevision: row.document };
}
