import type { CatalogDefinitionIssue } from "./contracts/catalogConformance.js";
import { catalogAttributesReadyForPublication, type CatalogAttributeProjectionValue, type CatalogAttributeValidation } from "./attributeValidation.js";

/** @experimental */
export interface CatalogAttributeProjectionRow extends CatalogAttributeProjectionValue {
  sku_id: string; publication_revision: string;
}
/** @experimental */
export type CatalogAttributeProjectionPreparation =
  | { prepared: false; issues: readonly CatalogDefinitionIssue[] }
  | { prepared: true; rows: readonly Readonly<CatalogAttributeProjectionRow>[] };
/** Pure preparation for the publisher's executor: never persists or switches a generation.
 * @experimental
 */
export function prepareCatalogAttributeProjection(
  validation: CatalogAttributeValidation, publicationRevision: string,
): CatalogAttributeProjectionPreparation {
  if (!catalogAttributesReadyForPublication(validation) || !validation.valid) {
    return { prepared: false, issues: validation.valid ? validation.readinessIssues : validation.issues };
  }
  if (typeof publicationRevision !== "string" || !/^[1-9][0-9]{0,18}$/u.test(publicationRevision)
    || BigInt(publicationRevision) > 9_223_372_036_854_775_807n) {
    return { prepared: false, issues: [{ path: "/publicationRevision", code: "attribute_publication_revision_invalid" }] };
  }
  return { prepared: true, rows: Object.freeze(validation.skus.flatMap((sku) => sku.values.map((value) => Object.freeze({
    ...value, sku_id: sku.id, publication_revision: publicationRevision,
  })))) };
}
