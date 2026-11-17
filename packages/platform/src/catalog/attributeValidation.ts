import {
  CATALOG_QUANTITY_UNITS, CatalogQuantityError, canonicalizeCatalogQuantity,
  type CatalogQuantityUnit,
} from "@openlup/core/catalog";
import { z } from "./validation.js";
import { canonicalCatalogPublicationJson, canonicalCatalogDraftJson } from "./contracts/draft.js";
import type { AttributeDefinition, CatalogAttributeScalarType } from "./contracts/attributes.js";
import type { CatalogDefinitionIssue, CatalogConformanceCode } from "./contracts/catalogConformance.js";
import type { CatalogProductTypeInput } from "./contracts/productTypes.js";
import { catalogProductTypeIssues, catalogQuantitySchema } from "./productTypeIssues.js";
import { catalogAttributeDateSchema, catalogAttributeDecimal, catalogAttributeStorageBytes, catalogAttributeReferenceSchema, compareAttributeDecimals } from "./attributeSchemas.js";
import type { CatalogAttributeReference, CatalogAttributeReferencePort } from "./attributeReferencePort.js";

/** @experimental */
export interface CatalogAttributeInput {
  productAttributes?: unknown;
  skus: readonly { id: string; attributes?: unknown }[];
}
/** Slots of the one projection, prepared without a publication revision or any SQL.
 * @experimental
 */
export interface CatalogAttributeProjectionValue {
  attribute_key: string; definition_version: number; value_ordinal: number;
  value_kind: CatalogAttributeScalarType["kind"];
  text_value: string | null; numeric_value: string | null; bool_value: boolean | null;
  date_value: string | null; ref_value: string | null; quantity_dimension: string | null;
  canonical_unit: string | null; canonical_value: string | null;
}
const validatedAttributes: unique symbol = Symbol("validated catalog attributes");
/** @experimental */
export type CatalogAttributeValidation =
  | { readonly valid: false; readonly issues: readonly CatalogDefinitionIssue[] }
  | { readonly valid: true; readonly [validatedAttributes]: true;
    readonly readinessIssues: readonly CatalogDefinitionIssue[];
    readonly skus: readonly { readonly id: string; readonly values: readonly Readonly<CatalogAttributeProjectionValue>[] }[] };
const pointer = (key: string): string => key.replace(/~/gu, "~0").replace(/\//gu, "~1");
const referenceKey = (ref: CatalogAttributeReference): string => JSON.stringify([ref.namespace, ref.id]);
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const decimalText = (unscaled: string, scale: number): string => scale === 0 ? unscaled
  : `${unscaled.padStart(scale + 1, "0").slice(0, -scale)}.${unscaled.padStart(scale + 1, "0").slice(-scale)}`;

/** Validate complete supplied facts; missing publish-time facts remain readiness issues.
 * Definition metadata is checked by its existing owner. Cross-field policy stays in validateContent.
 * No v1 draft admission, callback execution, database access or publication occurs here.
 * @experimental
 */
export function validateCatalogAttributes(
  definition: CatalogProductTypeInput, input: CatalogAttributeInput, references?: CatalogAttributeReferencePort,
): Promise<CatalogAttributeValidation> { return validate(definition, input, references, 1_048_576); }
/** Publication envelopes may exceed the draft aggregate limit; each attribute object retains its own 1 MiB cap. */
export function validateCatalogPublicationAttributes(
  definition: CatalogProductTypeInput, input: CatalogAttributeInput, references?: CatalogAttributeReferencePort,
): Promise<CatalogAttributeValidation> { return validate(definition, input, references, 16_777_216); }
async function validate(definition: CatalogProductTypeInput, input: CatalogAttributeInput,
  references: CatalogAttributeReferencePort | undefined, maxBytes: number): Promise<CatalogAttributeValidation> {
  const issues = catalogProductTypeIssues([definition]).map((issue) => ({ ...issue, path: `/definition${issue.path.slice(2)}` }));
  if (issues.length) return { valid: false, issues };
  const readinessIssues: CatalogDefinitionIssue[] = [];
  const add = (path: string, code: CatalogConformanceCode): void => { issues.push({ path, code }); };
  const missing = (path: string, code: CatalogConformanceCode): void => { readinessIssues.push({ path, code }); };
  // Snapshot canonical data before awaiting the injected resolver. Reuse the existing depth/byte guard.
  let snapshot: CatalogAttributeInput;
  try { snapshot = JSON.parse(maxBytes === 1_048_576 ? canonicalCatalogDraftJson(input) : canonicalCatalogPublicationJson(input)) as CatalogAttributeInput; }
  catch { return { valid: false, issues: [{ path: "", code: "attribute_values_invalid" }] }; }
  if (!snapshot || !Array.isArray(snapshot.skus) || Object.keys(snapshot).some((key) => !["productAttributes", "skus"].includes(key))) {
    return { valid: false, issues: [{ path: "", code: "attribute_values_invalid" }] };
  }
  const attributes = new Map((definition.attributes ?? []).map((attribute) => [attribute.key, attribute]));
  const units: CatalogQuantityUnit[] = definition.units.flatMap((unit) => {
    const factor = unit.factor ?? CATALOG_QUANTITY_UNITS.find(({ code }) => code === unit.code)?.factor;
    return factor ? [{ ...unit, factor }] : [];
  });
  const pending = new Map<string, { reference: Readonly<CatalogAttributeReference>; paths: string[] }>();
  const emptyValue = (attribute: AttributeDefinition, ordinal: number, kind: CatalogAttributeScalarType["kind"]): CatalogAttributeProjectionValue => ({
    attribute_key: attribute.key, definition_version: definition.version, value_ordinal: ordinal, value_kind: kind,
    text_value: null, numeric_value: null, bool_value: null, date_value: null, ref_value: null,
    quantity_dimension: null, canonical_unit: null, canonical_value: null,
  });
  function scalar(type: CatalogAttributeScalarType, value: unknown, path: string, row: CatalogAttributeProjectionValue): CatalogAttributeProjectionValue[] {
    const invalid = (): [] => { add(path, "attribute_value_invalid"); return []; };
    switch (type.kind) {
      case "text":
        if (!z.string().min(type.minLength ?? 0).max(type.maxLength).safeParse(value).success) return invalid();
        row.text_value = value as string; break;
      case "localized_text": {
        if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
        const localized = value as Record<string, unknown>;
        for (const locale of Object.keys(localized).sort(compare)) {
          if (!type.locales.includes(locale) || !z.string().max(type.maxLength).safeParse(localized[locale]).success) add(`${path}/${pointer(locale)}`, "attribute_value_invalid");
        }
        for (const locale of type.requiredLocales ?? []) if (!Object.hasOwn(localized, locale)) missing(`${path}/${pointer(locale)}`, "attribute_required_locale_missing");
        // One scalar remains one ordinal: its deterministic locale map occupies the text slot.
        row.text_value = canonicalCatalogDraftJson(localized); break;
      }
      case "decimal": {
        const number = catalogAttributeDecimal(value);
        if (!number || number.scale > type.scale) return invalid();
        const min = type.min === undefined ? undefined : catalogAttributeDecimal(type.min);
        const max = type.max === undefined ? undefined : catalogAttributeDecimal(type.max);
        if ((min && compareAttributeDecimals(number, min) < 0n) || (max && compareAttributeDecimals(number, max) > 0n)) return invalid();
        row.numeric_value = value as string; break;
      }
      case "quantity": {
        const parsed = catalogQuantitySchema.safeParse(value);
        if (!parsed.success || parsed.data.dimension !== type.dimension || !type.units.includes(parsed.data.unit)) return invalid();
        try {
          const canonical = canonicalizeCatalogQuantity(parsed.data, units);
          row.quantity_dimension = canonical.dimension; row.canonical_unit = canonical.unit;
          row.canonical_value = decimalText(canonical.unscaled, canonical.scale);
        } catch (error) {
          if (!(error instanceof CatalogQuantityError)) throw error;
          add(path, error.code); return [];
        }
        break;
      }
      case "boolean":
        if (typeof value !== "boolean") return invalid();
        row.bool_value = value; break;
      case "enum":
        if (typeof value !== "string" || !type.values.some(({ id }) => id === value)) return invalid();
        row.text_value = value; break;
      case "reference": {
        const parsed = catalogAttributeReferenceSchema.safeParse(value);
        if (!parsed.success || !type.allowlist.includes(parsed.data.namespace)) return invalid();
        const key = referenceKey(parsed.data);
        const prior = pending.get(key);
        if (prior) prior.paths.push(path);
        else pending.set(key, { reference: Object.freeze(parsed.data), paths: [path] });
        row.ref_value = key; break;
      }
      case "date":
        if (!catalogAttributeDateSchema.safeParse(value).success) return invalid();
        row.date_value = value as string; break;
    }
    // The unconditional text index also carries an ASCII key (<=64 B), int4
    // version and UUID. 2048 B + 64 + 4 + 16 + 128 B header/alignment reserve
    // stays below the 2704 B B-tree budget on the qualified 8 KiB-page profile.
    // Bound actual slot bytes, including the complete localized JSON map.
    if (row.text_value !== null && new TextEncoder().encode(row.text_value).byteLength > 2_048) {
      add(path, "attribute_projection_text_too_large"); return [];
    }
    return [row];
  }
  function values(raw: unknown, scope: AttributeDefinition["scope"], path: string): CatalogAttributeProjectionValue[] {
    const rows: CatalogAttributeProjectionValue[] = [];
    if (raw === undefined || raw === null) raw = {};
    if (typeof raw !== "object" || Array.isArray(raw)) { add(path, "attribute_values_invalid"); return rows; }
    // Independent of the aggregate canonical-input ceiling: mirror S3a's per-object CHECK.
    if (catalogAttributeStorageBytes(raw) > 1_048_576) { add(path, "attribute_storage_too_large"); return rows; }
    const supplied = raw as Record<string, unknown>;
    for (const key of Object.keys(supplied).sort(compare)) {
      const attribute = attributes.get(key), at = `${path}/${pointer(key)}`;
      if (!attribute) { add(at, "attribute_unknown_key"); continue; }
      if (attribute.scope !== scope) { add(at, "attribute_scope_conflict"); continue; }
      const value = supplied[key], type = attribute.valueType;
      if (type.kind === "list") {
        if (!Array.isArray(value) || value.length < type.min || value.length > type.max
          || value.length < attribute.cardinality.min || value.length > attribute.cardinality.max) { add(at, "attribute_cardinality_invalid"); continue; }
        value.forEach((item, ordinal) => { rows.push(...scalar(type.item, item, `${at}/${ordinal}`, emptyValue(attribute, ordinal, type.item.kind))); });
      } else {
        if (attribute.cardinality.min > 1 || attribute.cardinality.max < 1) { add(at, "attribute_cardinality_invalid"); continue; }
        rows.push(...scalar(type, value, at, emptyValue(attribute, 0, type.kind)));
      }
    }
    for (const attribute of attributes.values()) if (attribute.scope === scope && !Object.hasOwn(supplied, attribute.key)
      && (attribute.required || attribute.cardinality.min > 0)) missing(`${path}/${pointer(attribute.key)}`, "attribute_required_missing");
    return rows;
  }
  const product = values(snapshot.productAttributes, "product", "/productAttributes");
  const ids = new Set<string>();
  const skus = snapshot.skus.map((sku, index) => {
    const path = `/skus/${index}`;
    const parsed = z.object({ id: z.uuid(), attributes: z.unknown().optional() }).strict().safeParse(sku);
    if (!parsed.success) { add(path, "attribute_values_invalid"); return { id: "", values: [] }; }
    const id = parsed.data.id.toLowerCase();
    if (ids.has(id)) add(`${path}/id`, "attribute_values_invalid");
    ids.add(id);
    const local = values(parsed.data.attributes, "variant", `${path}/attributes`);
    return { id, values: [...product, ...local].sort((a, b) => compare(a.attribute_key, b.attribute_key) || a.value_ordinal - b.value_ordinal) };
  }).sort((a, b) => compare(a.id, b.id));
  if (issues.length) return { valid: false, issues };
  if (pending.size) {
    const batch = [...pending.values()].sort((a, b) => compare(referenceKey(a.reference), referenceKey(b.reference)));
    let resolved: Awaited<ReturnType<CatalogAttributeReferencePort["resolve"]>> = [];
    try { resolved = references ? await references.resolve(Object.freeze(batch.map(({ reference }) => reference))) : []; }
    catch { /* Resolver failures are unavailable evidence, never successful validation. */ }
    for (const { reference, paths } of batch) {
      const matches = Array.isArray(resolved) ? resolved.filter((item) => item && item.namespace === reference.namespace && item.id === reference.id) : [];
      if (matches.length !== 1 || matches[0].status !== "resolved") for (const path of paths) add(path, "attribute_reference_unresolved");
    }
  }
  if (issues.length) return { valid: false, issues };
  return Object.freeze({ valid: true, [validatedAttributes]: true as const,
    readinessIssues: Object.freeze(readinessIssues.map((issue) => Object.freeze(issue))),
    skus: Object.freeze(skus.map((sku) => Object.freeze({ id: sku.id, values: Object.freeze(sku.values.map((row) => Object.freeze(row))) }))),
  });
}

/** An admission predicate only; the publisher must also prove all other publication duties.
 * @experimental
 */
export function catalogAttributesReadyForPublication(result: CatalogAttributeValidation): boolean {
  return result.valid && result.readinessIssues.length === 0;
}
