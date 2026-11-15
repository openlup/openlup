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
export interface CatalogDefinitionIssue { code: CatalogConformanceCode; path: string }
