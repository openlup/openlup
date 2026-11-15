/** Stable meanings shared by runtime admission and offline conformance. */
export type CatalogConformanceCode =
  | "definition_invalid_shape" | "definition_unknown_field" | "definition_key_invalid" | "definition_version_invalid"
  | "definition_unit_invalid" | "definition_dimension_invalid" | "definition_net_content_invalid" | "definition_attribute_invalid"
  | "definition_axis_invalid" | "definition_validator_ref_invalid" | "definition_profile_ref_invalid" | "definition_tax_class_invalid"
  | "definition_callback_missing" | "definition_duplicate_identity" | "definition_duplicate_unit" | "definition_duplicate_dimension"
  | "definition_duplicate_net_content_unit" | "definition_unknown_net_content_unit" | "definition_duplicate_choice"
  | "definition_duplicate_dimension_unit" | "definition_dimension_unit_mismatch" | "definition_net_content_unit_mismatch"
  | "definition_multiple_net_content_dimensions" | "definition_unit_factor_invalid" | "definition_duplicate_attribute"
  | "definition_facetable_not_filterable" | "definition_unknown_attribute_unit" | "definition_duplicate_axis"
  | "definition_unknown_axis_attribute" | "definition_axis_scope_invalid" | "definition_duplicate_enum_value"
  | "definition_unknown_axis_dimension"
  | "quantity_invalid" | "quantity_cross_dimension" | "quantity_fractional_count"
  | "quantity_unknown_unit" | "quantity_overflow" | "quantity_not_exactly_representable";
export interface CatalogConformanceRule { severity: "error" | "warning"; rule: string; fix: string; recipe: string }
const recipe = (anchor: string): string => `how-to/extend/catalogue-extension.md#${anchor}`;
const rule = (text: string, fix: string, anchor: string): CatalogConformanceRule => Object.freeze({ severity: "error", rule: text, fix, recipe: recipe(anchor) });
export const CATALOG_CONFORMANCE_RULES: Readonly<Record<CatalogConformanceCode, CatalogConformanceRule>> = Object.freeze({
  quantity_invalid: rule("Quantities use positive decimal strings and scale 0–12.", "Correct the quantity shape or exact unit factor.", "add-unit"),
  quantity_cross_dimension: rule("Conversions stay within one dimension.", "Choose a unit of the same dimension; never infer density or item mass.", "add-unit"),
  quantity_fractional_count: rule("Counts and integral units contain whole items.", "Supply a whole-item quantity and integral count factor.", "add-unit"),
  quantity_unknown_unit: rule("Units must be uniquely declared.", "Declare the unit once or correct the reference.", "add-unit"),
  quantity_overflow: rule("Quantities fit the bounded exact decimal representation.", "Reduce the value to the supported precision without rounding.", "add-unit"),
  quantity_not_exactly_representable: rule("Canonical values and conversions are exact at scale 0–12.", "Use a factor and quantity that can be represented exactly; do not round.", "add-unit"),
  definition_invalid_shape: rule("Definitions use bounded declared metadata.", "Supply the declared definition shape and bounds.", "new-vertical"),
  definition_unknown_field: rule("Definition fields are closed.", "Remove the undeclared field.", "new-vertical"),
  definition_key_invalid: rule("Type keys are namespaced.", "Use a bounded namespaced type key.", "new-vertical"),
  definition_version_invalid: rule("Versions are positive bounded integers.", "Supply a positive version within the supported integer range.", "upgrade-a-definition"),
  definition_unit_invalid: rule("Units have a code, dimension and integrality.", "Correct the unit metadata and bounds.", "add-unit"),
  definition_dimension_invalid: rule("Dimensions use the closed option grammar.", "Correct the dimension kind, key, values or bounds.", "add-axis"),
  definition_net_content_invalid: rule("Net content has bounded declared units.", "Declare at least one net-content unit.", "add-unit"),
  definition_attribute_invalid: rule("Attributes use the closed bounded grammar.", "Correct the attribute kind, cardinality or bounds.", "add-attribute"),
  definition_axis_invalid: rule("Axes reference declared variant attributes.", "Correct the axis metadata.", "add-axis"),
  definition_validator_ref_invalid: rule("Validator artifacts are build-pinned.", "Use a sha256 artifact reference with 64 lowercase hexadecimal digits.", "upgrade-a-definition"),
  definition_profile_ref_invalid: rule("Profiles use a namespaced key and positive version.", "Correct the profile reference.", "subscription-profile"),
  definition_tax_class_invalid: rule("Tax classes use stable bounded keys.", "Supply a nonempty default tax-class key within the supported bound.", "add-tax-class"),
  definition_callback_missing: rule("Installed definitions supply a validator callback.", "Compose a validateContent function.", "new-vertical"),
  definition_duplicate_identity: rule("A key and version identify one definition.", "Remove the duplicate or declare a new version.", "upgrade-a-definition"),
  definition_duplicate_unit: rule("Unit codes are unique per type.", "Remove the duplicate unit code.", "add-unit"),
  definition_duplicate_dimension: rule("Dimension keys are unique per type.", "Remove the duplicate dimension key.", "add-axis"),
  definition_duplicate_net_content_unit: rule("Net-content unit codes are unique.", "Remove the duplicate net-content unit.", "add-unit"),
  definition_unknown_net_content_unit: rule("Net-content units are declared by the type.", "Declare the unit or remove its reference.", "add-unit"),
  definition_duplicate_choice: rule("Choice identities are unique.", "Remove the duplicate choice identity.", "add-axis"),
  definition_duplicate_dimension_unit: rule("Dimension unit references are unique.", "Remove the duplicate dimension unit.", "add-axis"),
  definition_dimension_unit_mismatch: rule("Dimension units exist with a matching dimension.", "Reference a declared unit of the same dimension.", "add-axis"),
  definition_net_content_unit_mismatch: rule("Net-content axes use admitted net-content units.", "Admit the unit for net content or remove the axis reference.", "add-axis"),
  definition_multiple_net_content_dimensions: rule("At most one dimension has the net-content role.", "Keep one net-content dimension.", "add-axis"),
  definition_unit_factor_invalid: rule("Unit factors convert exactly to their canonical dimension.", "Supply a positive exact decimal factor to the matching canonical unit.", "add-unit"),
  definition_duplicate_attribute: rule("Attribute keys are unique per type.", "Remove the duplicate attribute key.", "add-attribute"),
  definition_facetable_not_filterable: rule("Facetable attributes are filterable.", "Enable filtering or disable faceting.", "add-attribute"),
  definition_unknown_attribute_unit: rule("Quantity attributes use declared compatible units.", "Declare or correct the referenced unit.", "add-attribute"),
  definition_duplicate_axis: rule("Axis keys are unique per type.", "Remove the duplicate axis key.", "add-axis"),
  definition_unknown_axis_attribute: rule("Axis attributes exist in the same type.", "Reference an attribute declared by this type.", "add-axis"),
  definition_axis_scope_invalid: rule("Axis attributes belong to variants.", "Choose a variant-scoped attribute.", "add-axis"),
  definition_duplicate_enum_value: rule("Enum value IDs are unique.", "Remove the duplicate value ID; labels do not identify values.", "add-attribute"),
  definition_unknown_axis_dimension: rule("An axis key names a declared option dimension.", "Declare the option dimension or correct the axis key.", "add-axis"),
});
export interface CatalogDefinitionIssue { code: CatalogConformanceCode; path: string }
