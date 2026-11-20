import { isValidGtin } from "./foundationSchemas.js";
import type { CatalogDraftPayload } from "./draftSchemas.js";
import type { DraftValidationIssues } from "./draftValidation.js";
import {
  canonicalCatalogOption, validateCatalogQuantity,
  type CatalogProductTypeRegistry,
} from "./productTypeSchemas.js";
import { adopterIssue, publicationIssue, type Issue, type PlatformCode } from "./publicationError.js";

/** The offline checker uses JSON pointers while the released draft validator retains its dot paths. */
export function validateDraftFacts(
  payload: Pick<CatalogDraftPayload, "product" | "skus">, registry: CatalogProductTypeRegistry, jsonPointers = false,
): DraftValidationIssues {
  const at = (...parts: (string | number)[]) => jsonPointers
    ? "/" + parts.map(part => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")
    : parts.join(".");
  const issues: Issue[] = [], publication: Issue[] = [], commercial: Issue[] = [];
  const add = (path: string, code: PlatformCode) => issues.push(publicationIssue(code, undefined, path));
  const missing = (path: string, code: PlatformCode) => publication.push(publicationIssue(code, undefined, path));
  const assess = (path: string, code: PlatformCode) => commercial.push(publicationIssue(code, undefined, path));
  const { product, skus } = payload;
  const definition = registry.resolve(product.type);
  if (!definition) return { valid: false, issues: [publicationIssue("type_not_installed", undefined, at("product", "type"))] };
  const dimensions = new Map(definition.dimensions.map((dimension) => [dimension.key, dimension]));
  const netContentKey = definition.dimensions.find((dimension) => dimension.kind === "quantity" && dimension.role === "net_content")?.key;
  if (new Set(product.dimensions).size !== product.dimensions.length) add(at("product", "dimensions"), "duplicate_dimension");
  product.dimensions.forEach((key, index) => {
    if (!dimensions.has(key)) add(at("product", "dimensions", jsonPointers ? index : key), "dimension_not_installed");
  });
  if (product.sharedContent !== undefined) {
    const path = at("product", "sharedContent");
    issues.push(...definition.validateContent(product.sharedContent).map(issue =>
      adopterIssue("validateContent", issue.code, path + (issue.path ? jsonPointers ? at(...issue.path.split(".")) : `.${issue.path}` : ""))));
  } else if (!product.documentRevision) missing(at("product", "sharedContent"), "content_missing");
  if (product.documentRevision && product.documentRevision.productId !== product.id) add(at("product", "documentRevision", "productId"), "foreign_product_reference");
  if (product.primarySkuId && !skus.some((sku) => sku.id === product.primarySkuId)) add(at("product", "primarySkuId"), "primary_sku_not_in_product");
  if (!product.primarySkuId) missing(at("product", "primarySkuId"), "primary_sku_missing");
  if (!product.slug) missing(at("product", "slug"), "slug_missing");
  if (!skus.length) missing(at("skus"), "sku_missing");
  const skuIds = new Set<string>();
  const skuCodes = new Set<string>();
  const combinations = new Set<string>();
  const identifiers = new Set<string>();
  skus.forEach((sku, index) => {
    const skuPath = (...parts: (string | number)[]) => at("skus", index, ...parts);
    if (sku.productId !== product.id) add(skuPath("productId"), "foreign_product_reference");
    if (skuIds.has(sku.id)) add(skuPath("id"), "duplicate_sku_id");
    skuIds.add(sku.id);
    if (sku.code) {
      if (skuCodes.has(sku.code)) add(skuPath("code"), "duplicate_sku_code");
      skuCodes.add(sku.code);
    } else missing(skuPath("code"), "sku_code_missing");
    const optionKeys = Object.keys(sku.options);
    for (const key of optionKeys) {
      const option = sku.options[key];
      const dimension = dimensions.get(key);
      if (!product.dimensions.includes(key) || !dimension) { add(skuPath("options", key), "dimension_not_declared"); continue; }
      if (dimension.kind !== option.kind) { add(skuPath("options", key), "option_type_invalid"); continue; }
      if (dimension.kind === "choice" && option.kind === "choice" && !dimension.values.includes(option.value)) add(skuPath("options", key), "option_value_invalid");
      if (dimension.kind === "quantity" && option.kind === "quantity"
        && (option.value.dimension !== dimension.dimension || !dimension.units.includes(option.value.unit)
          || !validateCatalogQuantity(option.value, definition))) add(skuPath("options", key), "option_quantity_invalid");
    }
    const absent = product.dimensions.filter((key) => !Object.prototype.hasOwnProperty.call(sku.options, key));
    absent.forEach((key) => missing(skuPath("options", key), "option_missing"));
    if (!absent.length && optionKeys.length === product.dimensions.length) {
      const combination = JSON.stringify([...product.dimensions].sort().map((key) => [key, canonicalCatalogOption(sku.options[key])]));
      if (combinations.has(combination)) add(skuPath("options"), "duplicate_option_combination");
      combinations.add(combination);
    }
    if (sku.netContent) {
      if (!validateCatalogQuantity(sku.netContent, definition) || !definition.netContentUnits.includes(sku.netContent.unit)) add(skuPath("netContent"), "net_content_invalid");
    } else missing(skuPath("netContent"), "net_content_missing");
    const netContentOption = netContentKey === undefined ? undefined : sku.options[netContentKey];
    if (netContentKey !== undefined && netContentOption?.kind === "quantity" && sku.netContent
      && canonicalCatalogOption(netContentOption) !== canonicalCatalogOption({ kind: "quantity", value: sku.netContent })) add(skuPath("options", netContentKey), "net_content_option_mismatch");
    if (sku.grossMass && (sku.grossMass.dimension !== "mass" || !validateCatalogQuantity(sku.grossMass, definition))) add(skuPath("grossMass"), "gross_mass_invalid");
    (sku.identifiers ?? []).forEach((identifier, identifierIndex) => {
      const identifierPath = skuPath("identifiers", identifierIndex);
      // One GTIN is one identity in any 8-, 12-, 13- or 14-digit spelling, whatever its issuer text.
      const gtin = identifier.scheme === "gs1:gtin" && isValidGtin(identifier.value) ? identifier.value.padStart(14, "0") : null;
      const identity = JSON.stringify(gtin === null ? [identifier.scheme, identifier.issuer, identifier.value] : [identifier.scheme, gtin]);
      if (identifiers.has(identity)) add(identifierPath, "duplicate_trade_identifier");
      identifiers.add(identity);
      if (identifier.scheme === "gs1:gtin" && gtin === null) add(identifierPath, "trade_identifier_invalid");
      if (identifier.scheme !== "gs1:gtin" && identifier.scheme.startsWith("gs1:")) add(identifierPath, "trade_identifier_scheme_unsupported");
      // Checked here, not in the wire schema, so a stored revision without a quantity stays readable.
      if (identifier.packagingLevel === "case" ? (identifier.quantity ?? 0) < 2 : (identifier.quantity ?? 1) !== 1) add(skuPath("identifiers", identifierIndex, "quantity"), "trade_identifier_quantity_invalid");
    });
    if (!sku.identifiers?.length) assess(skuPath("identifiers"), "channel_identity_not_assessed");
    if (!sku.identifiers?.some((identifier) => identifier.scheme === "gs1:gtin" && identifier.packagingLevel === "unit")) assess(skuPath("identifiers"), "unit_trade_identifier_missing");
    if (!sku.priceRef) assess(skuPath("priceRef"), "price_reference_missing");
    if (!sku.logisticsRef) assess(skuPath("logisticsRef"), "logistics_reference_missing");
  });
  if (issues.length) return { valid: false, issues };
  // Opaque references are not current pricing, stock, logistics or publication proof.
  assess(at("skus"), "commercial_activation_not_assessed");
  return { valid: true, readiness: {
    publication: { status: publication.length ? "incomplete" : "not_assessed", issues: publication },
    commercial: { status: "inactive", issues: commercial },
  } };
}
