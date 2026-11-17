import type { CatalogDraftPayloadV2 } from "./contracts/draftV2.js";
import type { CatalogProductTypeRegistry } from "./contracts/productTypes.js";
import type { CatalogAttributeReferencePort } from "./attributeReferencePort.js";
import { validateCatalogDraft, type CatalogDraftValidation } from "./draftValidation.js";
import { validateCatalogAttributes } from "./attributeValidation.js";
import { canonicalizeCatalogCombinationV2, CatalogCombinationError } from "./variantCombination.js";

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
  const combinations = new Set<string>();
  for (const [index, sku] of payload.skus.entries()) {
    if (product.dimensions.some(key => !Object.hasOwn(sku.options, key))) continue;
    try {
      const identity = canonicalizeCatalogCombinationV2({ definition, axes: product.dimensions, options: sku.options });
      const bytes = Buffer.from(identity.canonicalOptionBytes).toString("hex");
      if (combinations.has(bytes)) return { valid: false, issues: [{ path: `skus.${index}.options`, code: "duplicate_combination" }] };
      combinations.add(bytes);
    } catch (error) {
      if (!(error instanceof CatalogCombinationError)) throw error;
      return { valid: false, issues: [{ path: `skus.${index}.${error.path}`, code: error.code }] };
    }
  }
  result.readiness.publication.issues.push(...attributes.readinessIssues);
  result.readiness.publication.status = result.readiness.publication.issues.length ? "incomplete" : "not_assessed";
  result.readiness.commercial.issues = result.readiness.commercial.issues.filter(issue => issue.code !== "price_reference_missing");
  return result;
}
