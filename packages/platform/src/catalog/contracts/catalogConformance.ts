import type { CatalogQuantityCode } from "@openlup/core/catalog";

/** Stable meanings shared by runtime admission and offline conformance.
 * @experimental
 */
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
  | "definition_unknown_tax_class" | "definition_unknown_profile_ref" | "pack_type_namespace_mismatch"
  | "attribute_projection_text_too_large" | "attribute_storage_too_large"
  | "attribute_values_invalid" | "attribute_value_invalid" | "attribute_unknown_key" | "attribute_scope_conflict"
  | "attribute_cardinality_invalid" | "attribute_required_missing" | "attribute_required_locale_missing"
  | "attribute_reference_unresolved" | "attribute_publication_revision_invalid"
  | "conformance_subject_invalid" | "conformance_owner_unavailable"
  | "conformance_refusal_fixture_missing" | "conformance_refusal_fixture_invalid" | "conformance_refusal_fixture_mismatch"
  | "draft_input_invalid" | "draft_payload_invalid" | "draft_payload_too_large"
  | "quantity_invalid" | "quantity_cross_dimension" | "quantity_fractional_count"
  | "quantity_unknown_unit" | "quantity_overflow" | "quantity_not_exactly_representable"
  | "axis_not_installed" | "duplicate_axis" | "option_not_selected"
  | "option_missing" | "option_invalid" | "unit_factor_missing" | "sku_identity_change_requires_new_sku"
  | "duplicate_combination" | "combination_digest_collision" | "duplicate_sku_id" | "combination_identity_integrity_failed"
  | "sku_payload_limit" | "product_capacity_exceeded" | "product_capacity_invalid"
  | "definition_profile_invalid" | "cadence_kind_unsupported"
  | "advisory_net_content_not_publishable" | "advisory_filter_flags_unused" | "advisory_unit_identifier_missing"
  | "advisory_draft_version_not_publishable" | "advisory_fixtures_skipped_definition_invalid";
/** @experimental */
export interface CatalogConformanceRule { severity: "error" | "warning"; rule: string; fix: string; recipe: string }
/** @experimental */
export interface CatalogDefinitionIssue { code: CatalogConformanceCode; path: string; fix?: string; quantityCause?: CatalogQuantityCode }
