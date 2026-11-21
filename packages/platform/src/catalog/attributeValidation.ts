import type { AttributeDefinition, CatalogAttributeScalarType } from "./contracts/attributes.js";
import type { CatalogDefinitionIssue } from "./contracts/catalogConformance.js";
import type { CatalogProductTypeInput } from "./contracts/productTypes.js";
import type { CatalogAttributeReferencePort } from "./attributeReferencePort.js";
import { validateAttributeValues } from "./attributeValues.js";

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
/** @experimental */
const validatedAttributes: unique symbol = Symbol("validated catalog attributes");
/** @experimental */
export type CatalogAttributeValidation =
  | { readonly valid: false; readonly issues: readonly CatalogDefinitionIssue[] }
  | { readonly valid: true; readonly [validatedAttributes]: true;
    readonly readinessIssues: readonly CatalogDefinitionIssue[];
    readonly skus: readonly { readonly id: string; readonly values: readonly Readonly<CatalogAttributeProjectionValue>[] }[] };
/** Validate complete supplied facts; missing publish-time facts remain readiness issues.
 * Definition metadata is checked by its existing owner. Cross-field policy stays in validateContent.
 * No v1 draft admission, callback execution, database access or publication occurs here.
 * @experimental
 */
export async function validateCatalogAttributes(
  definition: CatalogProductTypeInput, input: CatalogAttributeInput, references?: CatalogAttributeReferencePort,
): Promise<CatalogAttributeValidation> {
  const result = await validateAttributeValues(definition, input, references);
  if (!result.valid) return result;
  return Object.freeze({ valid: true, [validatedAttributes]: true as const,
    readinessIssues: result.readinessIssues, skus: result.skus });
}

/** An admission predicate only; the publisher must also prove all other publication duties.
 * @experimental
 */
export function catalogAttributesReadyForPublication(result: CatalogAttributeValidation): boolean {
  return result.valid && result.readinessIssues.length === 0;
}
