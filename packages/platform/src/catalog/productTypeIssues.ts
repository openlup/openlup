import { z } from "./validation.js";
import { validateCatalogSubscriptionProfile, validateCatalogUnitFactor } from "@openlup/core/catalog";
import type { CatalogConformanceCode, CatalogDefinitionIssue } from "./contracts/catalogConformance.js";
export const catalogNamespacedKeySchema = z.string().max(120).regex(/^[a-z][a-z0-9.-]*:[a-z][a-z0-9._-]*$/u);
export const catalogDimensionKeySchema = z.string().max(64).regex(/^[a-z][a-z0-9_-]*$/u)
  .refine((key) => !["__proto__", "constructor", "prototype"].includes(key));
export const catalogQuantityDimensionSchema = z.enum(["mass", "volume", "count"]);
export const catalogQuantitySchema = z.object({
  dimension: catalogQuantityDimensionSchema,
  unscaled: z.string().regex(/^[1-9][0-9]{0,39}$/u),
  scale: z.number().int().min(0).max(12),
  unit: catalogNamespacedKeySchema,
}).strict();
export const catalogOptionValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("choice"), value: z.string().min(1).max(120) }).strict(),
  z.object({ kind: z.literal("quantity"), value: catalogQuantitySchema }).strict(),
  z.object({ kind: z.literal("boolean"), value: z.boolean() }).strict(),
]);
export const catalogProductTypeRefSchema = z.object({
  key: catalogNamespacedKeySchema,
  version: z.number().int().positive().max(2_147_483_647),
}).strict();
const unitSchema = z.object({
  code: catalogNamespacedKeySchema,
  dimension: catalogQuantityDimensionSchema,
  integral: z.boolean(),
  factor: z.object({ canonicalUnit: z.enum(["openlup:g", "openlup:ml", "openlup:piece"]), unscaled: z.string().regex(/^[1-9][0-9]{0,39}$/u), scale: z.number().int().min(0).max(12) }).strict().optional(),
}).strict();
const dimensionSchema = z.discriminatedUnion("kind", [
  z.object({ key: catalogDimensionKeySchema, kind: z.literal("choice"), values: z.array(z.string().min(1).max(120)).min(1).max(1000) }).strict(),
  z.object({ key: catalogDimensionKeySchema, kind: z.literal("quantity"), dimension: catalogQuantityDimensionSchema,
    units: z.array(catalogNamespacedKeySchema).min(1).max(32), role: z.literal("net_content").optional() }).strict(),
  z.object({ key: catalogDimensionKeySchema, kind: z.literal("boolean") }).strict(),
]);
const labels = z.record(z.string().min(1).max(64), z.string().max(1000));
const bound = z.number().int().min(0).max(1_000_000);
const decimalString = z.string().max(66).regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u);
const scalarSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), maxLength: bound, minLength: bound.optional() }).strict(),
  z.object({ kind: z.literal("localized_text"), maxLength: bound, locales: z.array(z.string().min(1).max(64)).min(1).max(100), requiredLocales: z.array(z.string().min(1).max(64)).max(100).optional() }).strict(),
  z.object({ kind: z.literal("decimal"), scale: z.number().int().min(0).max(12), min: decimalString.optional(), max: decimalString.optional() }).strict(),
  z.object({ kind: z.literal("quantity"), dimension: catalogQuantityDimensionSchema, units: z.array(catalogNamespacedKeySchema).min(1).max(64) }).strict(),
  z.object({ kind: z.literal("boolean") }).strict(),
  z.object({ kind: z.literal("enum"), values: z.array(z.object({ id: z.string().min(1).max(120), labels: labels.optional() }).strict()).min(1).max(1000) }).strict(),
  z.object({ kind: z.literal("reference"), allowlist: z.array(catalogNamespacedKeySchema).min(1).max(64) }).strict(),
  z.object({ kind: z.literal("date") }).strict(),
]);
const valueTypeSchema = z.union([scalarSchema, z.object({ kind: z.literal("list"), item: scalarSchema, min: bound, max: bound }).strict()]);
const attributeSchema = z.object({
  key: catalogDimensionKeySchema, scope: z.enum(["product", "variant"]), valueType: valueTypeSchema,
  required: z.boolean(), cardinality: z.object({ min: bound, max: bound }).strict(),
  filterable: z.boolean(), facetable: z.boolean(), public: z.boolean(), displayOrder: bound, labels,
}).strict();
/** @experimental */
export const catalogDefinitionMetadataSchema = catalogProductTypeRefSchema.extend({
  units: z.array(unitSchema).max(64),
  netContentUnits: z.array(catalogNamespacedKeySchema).min(1).max(64),
  dimensions: z.array(dimensionSchema).max(16),
  attributes: z.array(attributeSchema).max(1000).optional(),
  axes: z.array(z.object({ key: catalogDimensionKeySchema, attributeKey: catalogDimensionKeySchema, labels: labels.optional() }).strict()).max(16).optional(),
  validatorRef: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
  publicationRules: z.literal(true).optional(),
  subscriptionProfileRef: catalogProductTypeRefSchema.optional(),
  taxClass: z.string().min(1).max(120).optional(),
  labels: labels.optional(),
}).strict();
const pointer = (path: readonly PropertyKey[]): string => path.map((part) => `/${String(part).replace(/~/gu, "~0").replace(/\//gu, "~1")}`).join("");
function parseCode(path: readonly PropertyKey[], code: string): CatalogConformanceCode {
  if (code === "unrecognized_keys") return "definition_unknown_field";
  const codes: Record<string, CatalogConformanceCode> = {
    key: "definition_key_invalid", version: "definition_version_invalid", units: "definition_unit_invalid",
    dimensions: "definition_dimension_invalid", netContentUnits: "definition_net_content_invalid", attributes: "definition_attribute_invalid",
    axes: "definition_axis_invalid", validatorRef: "definition_validator_ref_invalid", subscriptionProfileRef: "definition_profile_ref_invalid", taxClass: "definition_tax_class_invalid",
  };
  return codes[String(path[0])] ?? "definition_invalid_shape";
}
/** Reference admission shares the definition key/version grammar and issue codes.
 * @experimental
 */
export function catalogProductTypeRefIssues(input: unknown): CatalogDefinitionIssue[] {
  const parsed = catalogProductTypeRefSchema.safeParse(input);
  if (parsed.success) return [];
  return parsed.error.issues.flatMap<CatalogDefinitionIssue>(issue => issue.code === "unrecognized_keys"
    ? issue.keys.map(key => ({ code: "definition_unknown_field", path: pointer([...issue.path, key]) }))
    : [{ code: parseCode(issue.path, issue.code), path: pointer(issue.path) }]);
}

/** The runtime throws the first issue; offline callers can report the complete list.
 * @experimental
 */
export function catalogProductTypeIssues(definitions: readonly unknown[]): CatalogDefinitionIssue[] {
  const issues: CatalogDefinitionIssue[] = [];
  const identities = new Set<string>();
  const add = (code: CatalogConformanceCode, path: PropertyKey[]): void => { issues.push({ code, path: pointer(path) }); };
  definitions.forEach((input, index) => {
    const base: PropertyKey[] = [index];
    if (!input || typeof input !== "object" || Array.isArray(input)) { add("definition_invalid_shape", base); return; }
    const { validateContent, ...metadata } = input as Record<string, unknown>;
    const result = catalogDefinitionMetadataSchema.safeParse(metadata);
    if (typeof validateContent !== "function") add("definition_callback_missing", [...base, "validateContent"]);
    if (!result.success) {
      for (const issue of result.error.issues) {
        if (issue.code === "unrecognized_keys") for (const key of issue.keys) add("definition_unknown_field", [...base, ...issue.path, key]);
        else add(parseCode(issue.path, issue.code), [...base, ...issue.path]);
      }
      return;
    }
    const definition = result.data;
    const identity = `${definition.key}@${definition.version}`;
    if (identities.has(identity)) add("definition_duplicate_identity", [...base, "key"]);
    identities.add(identity);
    function duplicates(values: readonly string[], code: CatalogConformanceCode, path: PropertyKey[], suffix?: string): void {
      const seen = new Set<string>();
      values.forEach((value, i) => {
        if (seen.has(value)) add(code, [...base, ...path, i, ...(suffix ? [suffix] : [])]);
        seen.add(value);
      });
    }
    duplicates(definition.units.map((unit) => unit.code), "definition_duplicate_unit", ["units"], "code");
    duplicates(definition.dimensions.map((dimension) => dimension.key), "definition_duplicate_dimension", ["dimensions"], "key");
    duplicates(definition.netContentUnits, "definition_duplicate_net_content_unit", ["netContentUnits"]);
    const units = new Map(definition.units.map((unit) => [unit.code, unit]));
    definition.units.forEach((unit, i) => {
      if (!unit.factor) return; // Original definitions remain valid.
      try { validateCatalogUnitFactor({ ...unit, factor: unit.factor }); }
      catch { add("definition_unit_factor_invalid", [...base, "units", i, "factor"]); }
    });
    definition.netContentUnits.forEach((code, i) => { if (!units.has(code)) add("definition_unknown_net_content_unit", [...base, "netContentUnits", i]); });
    let netDimensions = 0;
    definition.dimensions.forEach((dimension, i) => {
      if (dimension.kind === "choice") duplicates(dimension.values, "definition_duplicate_choice", ["dimensions", i, "values"]);
      if (dimension.kind !== "quantity") return;
      duplicates(dimension.units, "definition_duplicate_dimension_unit", ["dimensions", i, "units"]);
      dimension.units.forEach((code, j) => {
        if (units.get(code)?.dimension !== dimension.dimension) add("definition_dimension_unit_mismatch", [...base, "dimensions", i, "units", j]);
        if (dimension.role === "net_content" && !definition.netContentUnits.includes(code)) add("definition_net_content_unit_mismatch", [...base, "dimensions", i, "units", j]);
      });
      if (dimension.role === "net_content" && ++netDimensions > 1) add("definition_multiple_net_content_dimensions", [...base, "dimensions", i, "role"]);
    });
    const attributes = definition.attributes ?? [];
    duplicates(attributes.map((attribute) => attribute.key), "definition_duplicate_attribute", ["attributes"], "key");
    attributes.forEach((attribute, i) => {
      const path = [...base, "attributes", i];
      if (attribute.facetable && !attribute.filterable) add("definition_facetable_not_filterable", [...path, "facetable"]);
      if (attribute.cardinality.min > attribute.cardinality.max) add("definition_attribute_invalid", [...path, "cardinality"]);
      const valueType = attribute.valueType.kind === "list" ? attribute.valueType.item : attribute.valueType;
      const valuePath = [...path, "valueType", ...(attribute.valueType.kind === "list" ? ["item"] : [])];
      if (attribute.valueType.kind === "list" && attribute.valueType.min > attribute.valueType.max) add("definition_attribute_invalid", [...path, "valueType", "max"]);
      if (valueType.kind === "text" && (valueType.minLength ?? 0) > valueType.maxLength) add("definition_attribute_invalid", [...valuePath, "maxLength"]);
      if (valueType.kind === "localized_text" && valueType.requiredLocales?.some((locale) => !valueType.locales.includes(locale))) add("definition_attribute_invalid", [...valuePath, "requiredLocales"]);
      if (valueType.kind === "enum") duplicates(valueType.values.map((value) => value.id), "definition_duplicate_enum_value", ["attributes", i, "valueType", ...(attribute.valueType.kind === "list" ? ["item"] : []), "values"], "id");
      if (valueType.kind === "quantity") valueType.units.forEach((code, j) => {
        if (units.get(code)?.dimension !== valueType.dimension) add("definition_unknown_attribute_unit", [...valuePath, "units", j]);
      });
    });
    const axes = definition.axes ?? [];
    duplicates(axes.map((axis) => axis.key), "definition_duplicate_axis", ["axes"], "key");
    axes.forEach((axis, i) => {
      const attribute = attributes.find(({ key }) => key === axis.attributeKey);
      if (!attribute) add("definition_unknown_axis_attribute", [...base, "axes", i, "attributeKey"]);
      else if (attribute.scope !== "variant") add("definition_axis_scope_invalid", [...base, "axes", i, "attributeKey"]);
      if (!definition.dimensions.some(({ key }) => key === axis.key)) add("definition_unknown_axis_dimension", [...base, "axes", i, "key"]);
    });
  });
  return issues;
}

const packSchema = z.object({
  id: z.string(), namespace: z.string(), version: catalogProductTypeRefSchema.shape.version, openlupRange: z.string(),
  capabilities: z.record(z.string(), z.boolean()), types: z.array(z.unknown()),
  taxClasses: z.array(z.object({ key: z.string(), labels: labels.optional() }).strict()),
  subscriptionProfiles: z.array(catalogProductTypeRefSchema).optional(),
  subscriptionProfileDefinitions: z.array(z.unknown()).max(100).optional(),
}).strict();
/** Shared pack shape, definitions and references; installation also requires pinned validators and unique tax-class keys.
 * @experimental
 */
export function catalogPackIssues(input: unknown): CatalogDefinitionIssue[] {
  const parsed = packSchema.safeParse(input);
  if (!parsed.success) return parsed.error.issues.flatMap<CatalogDefinitionIssue>((issue) => issue.code === "unrecognized_keys"
    ? issue.keys.map((key) => ({ code: "definition_unknown_field" as const, path: pointer([...issue.path, key]) }))
    : [{ code: issue.path[0] === "version" ? "definition_version_invalid" as const : "definition_invalid_shape" as const, path: pointer(issue.path) }]);
  const pack = parsed.data;
  const issues = catalogProductTypeIssues(pack.types).map((issue) => ({ ...issue, path: `/types${issue.path}` }));
  pack.types.forEach((input, index) => {
    if (!input || typeof input !== "object") return;
    const definition = input as Record<string, unknown>;
    if (typeof definition.key === "string" && !definition.key.startsWith(`${pack.namespace}:`)) issues.push({ code: "pack_type_namespace_mismatch", path: `/types/${index}/key` });
    if (typeof definition.taxClass === "string" && !pack.taxClasses.some(({ key }) => key === definition.taxClass)) issues.push({ code: "definition_unknown_tax_class", path: `/types/${index}/taxClass` });
    if (definition.subscriptionProfileRef && typeof definition.subscriptionProfileRef === "object") {
      const ref = definition.subscriptionProfileRef as Record<string, unknown>;
      if (!pack.subscriptionProfiles?.some(({ key, version }) => key === ref.key && version === ref.version)) issues.push({ code: "definition_unknown_profile_ref", path: `/types/${index}/subscriptionProfileRef` });
    }
  });
  const profiles = new Set<string>();
  pack.subscriptionProfileDefinitions?.forEach((input, index) => {
    const result = validateCatalogSubscriptionProfile(input);
    const path = `/subscriptionProfileDefinitions/${index}`;
    if ("issue" in result) {
      issues.push({ code: result.issue.code, path: path + result.issue.path });
      return;
    }
    const { key, version } = result.profile;
    const identity = `${key}@${version}`;
    if (profiles.has(identity)) issues.push({ code: "definition_profile_invalid", path });
    profiles.add(identity);
    if (!pack.subscriptionProfiles?.some(ref => ref.key === key && ref.version === version)) {
      issues.push({ code: "definition_unknown_profile_ref", path });
    }
  });
  if (pack.subscriptionProfileDefinitions?.length) {
    pack.subscriptionProfiles?.forEach(({ key, version }, index) => {
      if (!profiles.has(`${key}@${version}`)) {
        issues.push({ code: "definition_unknown_profile_ref", path: `/subscriptionProfiles/${index}` });
      }
    });
  }
  return issues;
}
