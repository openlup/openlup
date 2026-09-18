import { isValidGtin } from "../../../src/domains/catalog/catalogFoundationContracts.js";
import type { CatalogDraftPayload } from "../../../src/domains/catalog/catalogDraftContracts.js";
import {
  canonicalCatalogOption, validateCatalogQuantity,
  type CatalogDraftIssue, type CatalogProductTypeRegistry,
} from "../../../src/domains/catalog/catalogProductTypeContracts.js";

export interface CatalogDraftReadiness {
  publication: { status: "incomplete" | "not_assessed"; issues: CatalogDraftIssue[] };
  commercial: { status: "inactive"; issues: CatalogDraftIssue[] };
}
export type CatalogDraftValidation =
  | { valid: false; issues: CatalogDraftIssue[] }
  | { valid: true; readiness: CatalogDraftReadiness };

/** Supplied facts must be true; absent publish-time facts remain draft readiness issues. */
export function validateCatalogDraft(payload: CatalogDraftPayload, registry: CatalogProductTypeRegistry): CatalogDraftValidation {
  const issues: CatalogDraftIssue[] = [];
  const publication: CatalogDraftIssue[] = [];
  const commercial: CatalogDraftIssue[] = [];
  const add = (path: string, code: string) => issues.push({ path, code });
  const missing = (path: string, code: string) => publication.push({ path, code });
  const { product, skus } = payload;
  const definition = registry.resolve(product.type);
  if (!definition) return { valid: false, issues: [{ path: "product.type", code: "type_not_installed" }] };
  const dimensions = new Map(definition.dimensions.map((dimension) => [dimension.key, dimension]));
  if (new Set(product.dimensions).size !== product.dimensions.length) add("product.dimensions", "duplicate_dimension");
  product.dimensions.forEach((key) => { if (!dimensions.has(key)) add(`product.dimensions.${key}`, "dimension_not_installed"); });
  if (product.sharedContent !== undefined) {
    issues.push(...definition.validateContent(product.sharedContent).map((issue) => ({ ...issue, path: `product.sharedContent${issue.path ? `.${issue.path}` : ""}` })));
  } else if (!product.documentRevision) missing("product.sharedContent", "content_missing");
  if (product.documentRevision && product.documentRevision.productId !== product.id) add("product.documentRevision.productId", "foreign_product_reference");
  if (product.primarySkuId && !skus.some((sku) => sku.id === product.primarySkuId)) add("product.primarySkuId", "primary_sku_not_in_product");
  if (!product.primarySkuId) missing("product.primarySkuId", "primary_sku_missing");
  if (!product.slug) missing("product.slug", "slug_missing");
  if (!skus.length) missing("skus", "sku_missing");
  const skuIds = new Set<string>();
  const skuCodes = new Set<string>();
  const combinations = new Set<string>();
  const identifiers = new Set<string>();
  skus.forEach((sku, index) => {
    const path = `skus.${index}`;
    if (sku.productId !== product.id) add(`${path}.productId`, "foreign_product_reference");
    if (skuIds.has(sku.id)) add(`${path}.id`, "duplicate_sku_id");
    skuIds.add(sku.id);
    if (sku.code) {
      if (skuCodes.has(sku.code)) add(`${path}.code`, "duplicate_sku_code");
      skuCodes.add(sku.code);
    } else missing(`${path}.code`, "sku_code_missing");
    const optionKeys = Object.keys(sku.options);
    for (const key of optionKeys) {
      const option = sku.options[key];
      const dimension = dimensions.get(key);
      if (!product.dimensions.includes(key) || !dimension) { add(`${path}.options.${key}`, "dimension_not_declared"); continue; }
      if (dimension.kind !== option.kind) { add(`${path}.options.${key}`, "option_type_invalid"); continue; }
      if (dimension.kind === "choice" && option.kind === "choice" && !dimension.values.includes(option.value)) add(`${path}.options.${key}`, "option_value_invalid");
      if (dimension.kind === "quantity" && option.kind === "quantity"
        && (option.value.dimension !== dimension.dimension || !dimension.units.includes(option.value.unit)
          || !validateCatalogQuantity(option.value, definition))) add(`${path}.options.${key}`, "option_quantity_invalid");
    }
    const absent = product.dimensions.filter((key) => !Object.prototype.hasOwnProperty.call(sku.options, key));
    absent.forEach((key) => missing(`${path}.options.${key}`, "option_missing"));
    if (!absent.length && optionKeys.length === product.dimensions.length) {
      const combination = JSON.stringify([...product.dimensions].sort().map((key) => [key, canonicalCatalogOption(sku.options[key])]));
      if (combinations.has(combination)) add(`${path}.options`, "duplicate_option_combination");
      combinations.add(combination);
    }
    if (sku.netContent) {
      if (!validateCatalogQuantity(sku.netContent, definition) || !definition.netContentUnits.includes(sku.netContent.unit)) add(`${path}.netContent`, "net_content_invalid");
    } else missing(`${path}.netContent`, "net_content_missing");
    if (sku.grossMass && (sku.grossMass.dimension !== "mass" || !validateCatalogQuantity(sku.grossMass, definition))) add(`${path}.grossMass`, "gross_mass_invalid");
    (sku.identifiers ?? []).forEach((identifier, identifierIndex) => {
      const identity = JSON.stringify([identifier.scheme, identifier.issuer, identifier.value]);
      if (identifiers.has(identity)) add(`${path}.identifiers.${identifierIndex}`, "duplicate_trade_identifier");
      identifiers.add(identity);
      if (identifier.scheme === "gs1:gtin" && !isValidGtin(identifier.value)) add(`${path}.identifiers.${identifierIndex}`, "trade_identifier_invalid");
    });
    if (!sku.identifiers?.length) commercial.push({ path: `${path}.identifiers`, code: "channel_identity_not_assessed" });
    if (!sku.priceRef) commercial.push({ path: `${path}.priceRef`, code: "price_reference_missing" });
    if (!sku.logisticsRef) commercial.push({ path: `${path}.logisticsRef`, code: "logistics_reference_missing" });
  });
  if (issues.length) return { valid: false, issues };
  // Opaque references are not current pricing, stock, logistics or publication proof.
  commercial.push({ path: "skus", code: "commercial_activation_not_assessed" });
  return { valid: true, readiness: {
    publication: { status: publication.length ? "incomplete" : "not_assessed", issues: publication },
    commercial: { status: "inactive", issues: commercial },
  } };
}
