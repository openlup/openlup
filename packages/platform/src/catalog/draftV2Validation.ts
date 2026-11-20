import type { CatalogDraftPayloadV2 } from "./contracts/draftV2.js";
import type { CatalogProductTypeRegistry } from "./contracts/productTypes.js";
import type { CatalogAttributeReferencePort } from "./attributeReferencePort.js";
import { validateCatalogDraft, type CatalogDraftValidation } from "./draftValidation.js";
import { validateCatalogAttributes } from "./attributeValidation.js";
import { CatalogCombinationError } from "./variantCombination.js";
import { validateDraftCombinations } from "./combinationOptions.js";

export const catalogCombinationIssue = (error: CatalogCombinationError, prefix = "") =>
  ({ path: `${prefix}${error.path}`, code: error.code });

/** Incomplete v2 drafts remain saveable; required attributes participate in publication readiness.
 * @experimental
 */
export async function validateCatalogDraftV2(payload: CatalogDraftPayloadV2, registry: CatalogProductTypeRegistry,
  references?: CatalogAttributeReferencePort): Promise<CatalogDraftValidation> {
  const { attributes: _attributes, ...product } = payload.product;
  const result = validateCatalogDraft({ schemaVersion: 1, product,
    skus: payload.skus.map(({ attributes: _a, priceOperations: _p, ...sku }) => sku) }, registry);
  if (!result.valid) return result;
  const definition = registry.resolve(product.type)!;
  const attributes = await validateCatalogAttributes(definition, {
    ...(payload.product.attributes === undefined ? {} : { productAttributes: payload.product.attributes }),
    skus: payload.skus.map(sku => ({ id: sku.id, ...(sku.attributes === undefined ? {} : { attributes: sku.attributes }) })),
  }, references);
  if (!attributes.valid) return { valid: false, issues: [...attributes.issues] };
  try {
    validateDraftCombinations(definition, { product, skus: payload.skus }, (code, path) => { throw new CatalogCombinationError(code, path); });
  } catch (error) {
    if (!(error instanceof CatalogCombinationError)) throw error;
    return { valid: false, issues: [catalogCombinationIssue(error)] };
  }
  result.readiness.publication.issues.push(...attributes.readinessIssues);
  result.readiness.publication.status = result.readiness.publication.issues.length ? "incomplete" : "not_assessed";
  result.readiness.commercial.issues = result.readiness.commercial.issues.filter(issue => issue.code !== "price_reference_missing");
  return result;
}
