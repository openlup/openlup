/** Definition grammar. Owner validation prepares values for later publication integration.
 * @experimental
 */
export type CatalogAttributeScalarType =
  | { kind: "text"; maxLength: number; minLength?: number }
  | { kind: "localized_text"; maxLength: number; locales: readonly string[]; requiredLocales?: readonly string[] }
  | { kind: "decimal"; scale: number; min?: string; max?: string }
  | { kind: "quantity"; dimension: import("./productTypes.js").CatalogQuantityDimension; units: readonly string[] }
  | { kind: "boolean" }
  | { kind: "enum"; values: readonly { id: string; labels?: Readonly<Record<string, string>> }[] }
  | { kind: "reference"; allowlist: readonly string[] }
  | { kind: "date" };
/** @experimental */
export type CatalogAttributeValueType = CatalogAttributeScalarType
  | { kind: "list"; item: CatalogAttributeScalarType; min: number; max: number };
/** @experimental */
export interface AttributeDefinition {
  key: string; scope: "product" | "variant"; valueType: CatalogAttributeValueType;
  required: boolean; cardinality: { min: number; max: number };
  filterable: boolean; facetable: boolean; public: boolean; displayOrder: number;
  labels: Readonly<Record<string, string>>;
}
/** Axes reference variant attributes; display order stays in the declared array.
 * @experimental
 */
export interface CatalogAxisDefinition { key: string; attributeKey: string; labels?: Readonly<Record<string, string>> }
