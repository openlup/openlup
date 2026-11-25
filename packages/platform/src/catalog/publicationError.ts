import type { CatalogPublicationFailure } from "./publicationContracts.js";
import type { CatalogCandidateIssue } from "./contracts/candidate.js";
import type { CatalogCandidateError } from "./candidate.js";
import type { CatalogConformanceCode, CatalogConformanceRule } from "./contracts/catalogConformance.js";
import { CATALOG_CONFORMANCE_RULES } from "./catalogConformance.js";
import { z } from "./validation.js";

// Refusal reasons returned by the LC3 claim and apply routines.
const priceRefusalCodes = [
  "command_fingerprint_invalid", "command_invalid", "command_key_reused", "operator_mismatch",
  "command_in_progress", "sku_not_found", "sku_archived", "price_list_not_found",
  "price_list_not_active", "base_price_ambiguous",
] as const;
export const publicationPriceRefusalReason: z.ZodEnum<{ [Code in typeof priceRefusalCodes[number]]: Code }> =
  z.enum(priceRefusalCodes);
const reviewDraft = "Review the selected draft and prepare it again.";

const rulesMismatch = "The product rules and installed definition differ. Rebuild the rules, attach the build to the product type, and install the updated definition before retrying.";
const publicationCodes = [
  "activation_not_assessed", "activation_unknown", "catalog_action_conflict",
  "catalog_archive_barrier_unavailable", "catalog_bound_obligations",
  "catalog_obligation_evidence_unknown", "catalog_obligation_evidence_unavailable",
  "catalog_lifecycle_child_effects_mismatch", "catalog_lifecycle_evidence_unavailable",
  "catalog_lifecycle_fresh_sale_refused", "catalog_lifecycle_last_active_child", "catalog_lifecycle_raw_status_fenced",
  "catalog_lifecycle_state_conflict", "catalog_lifecycle_transition_refused",
  "catalog_lifecycle_withdrawal_overlay_refused", "catalog_publication_absent", "catalog_publication_use_readback_v2", "catalog_publication_use_readback_v3",
  "catalog_publication_activation_effect_missing", "catalog_publication_approval_missing",
  "catalog_publication_approval_state_valid", "catalog_publication_approval_wrong",
  "catalog_publication_attributes_invalid", "catalog_publication_authored_amounts_invalid",
  "catalog_publication_axes_invalid", "catalog_publication_busy", "catalog_publication_candidate_already_issued",
  "catalog_publication_candidate_invalid", "catalog_publication_command_key_reused",
  "catalog_publication_committed_at_valid", "catalog_publication_content_invalid",
  "catalog_publication_cursor_invalid", "catalog_publication_decided_at_valid",
  "catalog_publication_derived_source_mismatch", "catalog_publication_document_bytes_unavailable",
  "catalog_publication_document_invalid", "catalog_publication_document_required",
  "catalog_publication_document_revision_sequence", "catalog_publication_document_source_mismatch",
  "catalog_publication_document_source_missing", "catalog_publication_document_text_copied",
  "catalog_publication_draft_advanced", "catalog_publication_eligibility_source_mismatch",
  "catalog_publication_envelope_too_large", "catalog_publication_facts_invalid", "catalog_publication_gross_below_net",
  "catalog_publication_gross_mass_invalid", "catalog_publication_gross_mass_required",
  "catalog_publication_gtin_conflict", "catalog_publication_gtin_invalid", "catalog_publication_head_invalid",
  "catalog_publication_history_item_too_large", "catalog_publication_identifier_blank",
  "catalog_publication_identifier_conflict", "catalog_publication_identifier_effect_missing",
  "catalog_publication_identifier_key_reused", "catalog_publication_identifier_primary_invalid",
  "catalog_publication_identifier_requires_created_sku", "catalog_publication_identifier_source_mismatch",
  "catalog_publication_identity_conflict", "catalog_publication_integral_grams_required",
  "catalog_publication_net_content_invalid", "catalog_publication_quantity_definition_unqualified",
  "catalog_publication_issue_sealed", "catalog_publication_lifecycle_assertion_changed",
  "catalog_publication_lineage_invalid", "catalog_publication_lineage_unknown", "catalog_publication_live_drift",
  "catalog_publication_activation_membership_required", "catalog_publication_logistics_source_mismatch",
  "catalog_publication_manifest_invalid", "catalog_publication_mass_required_until_mc5",
  "catalog_publication_media_evidence_mismatch", "catalog_publication_media_readiness_unproven",
  "catalog_publication_media_validation_unavailable", "catalog_publication_membership_change_not_allowed",
  "catalog_publication_membership_effect_missing", "catalog_publication_membership_source_mismatch",
  "catalog_publication_metadata_effect_missing", "catalog_publication_net_weight_unsupported",
  "catalog_publication_operation_invalid", "catalog_publication_operation_source_ambiguous",
  "catalog_publication_operation_source_mismatch", "catalog_publication_operation_source_missing",
  "catalog_publication_page_invalid", "catalog_publication_pointer_capability_unconsumed",
  "catalog_publication_post_state_changed", "catalog_publication_presentation_effect_missing",
  "catalog_publication_presentation_invalid", "catalog_publication_presentation_source_mismatch",
  "catalog_publication_presentation_unavailable", "catalog_publication_price_changed",
  "catalog_publication_price_key_reused", "catalog_publication_price_readiness",
  "catalog_publication_price_unavailable", "catalog_publication_primary_sku_required",
  "catalog_publication_product_identity_conflict", "catalog_publication_product_name_source_mismatch",
  "catalog_publication_query_invalid", "catalog_publication_read_invalid",
  "catalog_publication_readback_item_too_large", "catalog_publication_receipt_input_invalid",
  "catalog_publication_receipt_invalid", "catalog_publication_receipt_unsupported",
  "catalog_publication_record_immutable", "catalog_publication_reserved_carrier", "catalog_publication_roster_limit",
  "catalog_publication_route_conflict", "catalog_publication_rule_failed",
  "catalog_publication_rules_binding_mismatch", "catalog_publication_rules_digest_mismatch",
  "catalog_publication_rules_module_invalid", "catalog_publication_scope_expansion",
  "catalog_publication_sku_effect_missing", "catalog_publication_sku_identity_changed",
  "catalog_publication_sku_price_not_ready", "catalog_publication_sku_price_shape_invalid",
  "catalog_publication_sku_revision_invalid", "catalog_publication_sku_title_invalid",
  "catalog_publication_sku_too_large", "catalog_publication_source_invalid", "catalog_publication_source_mismatch",
  "catalog_publication_tax_class_unavailable", "catalog_publication_v3_activation_readiness_failed",
  "catalog_publication_v3_active_primary_required", "catalog_publication_v3_compile_archive_refused",
  "catalog_publication_v3_compile_change_noop", "catalog_publication_v3_compile_derived_facts_mismatch",
  "catalog_publication_v3_compile_document_absent", "catalog_publication_v3_compile_document_conflict",
  "catalog_publication_v3_compile_document_stale", "catalog_publication_v3_compile_identifier_conflict",
  "catalog_publication_v3_compile_primary_foreign", "catalog_publication_v3_compile_primary_immutable",
  "catalog_publication_v3_compile_product_absent", "catalog_publication_v3_compile_product_conflict",
  "catalog_publication_v3_compile_product_incomplete", "catalog_publication_v3_compile_sku_absent",
  "catalog_publication_v3_compile_sku_archived", "catalog_publication_v3_compile_sku_conflict",
  "catalog_publication_v3_document_digest_mismatch", "catalog_publication_v3_document_invalid",
  "catalog_publication_v3_document_not_canonical", "catalog_publication_v3_document_reference_stale",
  "catalog_publication_v3_presentation_required", "catalog_publication_v3_structural_readiness_failed",
  "catalog_publication_wire_invalid", "catalog_publications_canonical_state_check",
  "catalog_sku_revisions_full_facts_check", "channel_identity_not_assessed", "commerce_product_slug_unsupported",
  "commercial_activation_not_assessed", "content_missing", "dimension_not_declared", "dimension_not_installed",
  "current_primary_mismatch", "document_reference_missing", "duplicate_dimension", "duplicate_option_combination", "duplicate_sku_code",
  "duplicate_sku_id", "duplicate_trade_identifier", "foreign_product_reference", "gross_mass_invalid",
  "gross_mass_missing", "intent_sku_absent", "logistics_reference_missing", "media_readiness_mismatch",
  "media_readiness_unknown", "media_reference_missing", "net_content_invalid", "net_content_missing",
  "net_content_option_mismatch", "option_quantity_invalid", "option_type_invalid", "option_value_invalid",
  "price_reference_missing", "price_validation_unavailable", "primary_sku_missing", "primary_sku_not_in_product",
  "publication_authority_unavailable", "publication_evidence_unavailable", "publication_head_unavailable", "publication_preparation_unavailable",
  "publisher_not_authorized", "retained_read_not_authorized", "retained_revision_unavailable",
  "retained_source_mismatch", "sku_code_missing", "sku_missing", "slug_missing", "trade_identifier_invalid",
  "trade_identifier_quantity_invalid", "trade_identifier_scheme_unsupported", "type_not_installed",
  "unit_trade_identifier_missing",
] as const;

/** @internal The platform-owned refusal vocabulary. */
type PlatformCode = typeof publicationCodes[number] | CatalogConformanceCode
  | CatalogCandidateError["code"] | z.infer<typeof publicationPriceRefusalReason>;
export type { PlatformCode };

type Rule = "validateContent" | "validateProduct" | "validatePrices" | "presentationReadiness" | "assessActivation";
export type PlatformIssue = { kind: "platform"; code: PlatformCode; stored?: true };
export type Issue = Omit<CatalogCandidateIssue, "code" | "message"> & { detail?: string } & (
  PlatformIssue | { kind: "adopterRule"; rule: Rule; code: string }
);
export type EvaluationIssue = { outcome: CatalogPublicationFailure["outcome"]; diagnostic: Issue };
type Remedy = readonly [reason: string, fix: string, cause?: string] | CatalogConformanceRule | { fix: string; cause?: string };

const skuSizeFix = "Reduce the facts or details for this SKU and prepare the publication again.";

export function publicationIssue(code: PlatformCode, phase: CatalogCandidateIssue["phase"], path: string, subject?: string): Issue & PlatformIssue {
  return { kind: "platform", code, path, ...(phase === undefined ? {} : { phase }), ...(subject === undefined ? {} : { subject }) };
}

const promotionRemedy = "Have the promotion owner verify definitions, codes, mirrors and parents.";
const priceRemedy = "Have the pricing and catalogue owners reconcile retained evidence.";
const agreementRemedy = "Have the subscription owner verify the governing agreement and retained quote.";
const orderRemedy = "Have the order owner verify retained order and admission evidence.";
const readinessRemedies = {
  effective_price_list_changed: ["The effective settlement list changed after reservation.", "Restore the intended effective settlement list.", "Verify the target and approved head."],
  first_subscription_pair_invalid: ["The first-subscription acquisition configuration is invalid.", "Restore one effective first-subscription acquisition revision.", "Verify its region, dates and terms."],
  first_subscription_mirror_not_ready: ["The first-subscription promotion lacks a matching active mirror.", "Restore the corresponding active mirror with matching terms and dates."],
  bundle_5_policy_invalid: ["The effective one-time bundle count differs from one.", "Restore exactly one qualifying automatic one-time bundle with the promotion owner."],
  catalog_1490_legacy_1340_invalid: ["The effective list or the eligible SKU price census could not be verified.", "Restore one effective list and verify each eligible SKU’s base and subscription branch with the pricing owner."],
  promotion_claim_sweep_not_ready: ["The promotion claim sweep lacks a current successful run.", "Ask the operations owner to enable the promotion claim sweep and verify its configured driver can run it.", "Wait for the next run or have the owner trigger one. Verify successful evidence from the past 15 minutes."],
  promotion_watchdog_not_ready: ["The promotion watchdog lacks healthy, enabled and current evidence.", "Ask the operations owner to enable the watchdog, verify its operations principal is active, and resolve any enabled failed jobs.", "Wait for the next run or have the owner trigger one. Verify a healthy, successful watchdog run from the past six hours."],
  legacy_frozen_records_invalid: ["Legacy subscription currency, policy or line money could not be verified.", "Have the subscription and money owners verify the governing records."],
  automatic_v2_money_invalid: ["Recent order money disagrees with frozen quote or order evidence.", "Have the order-money owner reconcile frozen quote and order evidence."],
  settlement_context_unverified: ["The settlement context could not be verified.", "Have the settlement owner verify the installed region and currency."],
  native_promotion_domain_unverified: ["Native promotion evidence failed integrity checks.", promotionRemedy],
  native_promotion_unverified: ["Retained promotion evidence could not be verified.", promotionRemedy],
  native_price_domain_unverified: ["Native price evidence failed integrity checks.", priceRemedy],
  native_catalog_domain_unverified: ["Retained catalogue evidence could not be verified.", priceRemedy],
  native_policy_domain_unverified: ["The retained policy digest did not match.", "Have the policy owner verify the revision and provenance."],
  native_cohort_unverified: ["The native cohort marking or audit baseline could not be verified.", "Have the subscription owner verify the cohort and audit baseline."],
  native_agreement_domain_unverified: ["Native governing agreement evidence failed integrity checks.", agreementRemedy],
  native_agreement_unverified: ["The retained agreement or line evidence could not be verified.", agreementRemedy],
  native_order_policy_pair_unverified: ["The retained order policy pair could not be verified.", "Have the order owner verify the retained policy pair."],
  native_order_admission_unverified: ["Native order admission evidence could not be verified.", "Have the order owner verify native admission evidence."],
  native_order_claim_guard_unverified: ["The settled-order claim guard failed.", "Have the order and promotions owners verify claim provenance."],
  native_order_guard_unverified: ["The recent native order guard failed.", orderRemedy],
  native_order_unverified: ["The retained order evidence could not be verified.", orderRemedy],
  native_order_domain_unverified: ["The native order-money input is invalid.", "Have the order-money owner verify the authoritative input and retained quote."],
  native_job_domain_unverified: ["Native job evidence could not be verified.", "Have the operations owner verify native job and heartbeat evidence."],
  readiness_unverified: ["The authority did not report a recognized readiness cause.", "Recheck the installed authority and have the store owner inspect its evidence if the result remains unavailable."],
} as const satisfies Record<string, readonly [string, string, string?]>;

export function refusePublicationReadiness(reasons: unknown, hard = false): never {
  const first = Array.isArray(reasons) && reasons.length <= 32
    ? reasons.find((reason): reason is keyof typeof readinessRemedies => typeof reason === "string" && Object.hasOwn(readinessRemedies, reason))
    : undefined;
  const subject = first ?? "readiness_unverified";
  const [cause, fix, recheck] = readinessRemedies[subject];
  const issue = publicationIssue(hard ? "publication_authority_unavailable" : "catalog_publication_price_readiness",
    "activation", "pricing.readiness", subject);
  throw new CatalogPublicationError({ ...issue, detail: `Observed: Publish could not verify price and offer readiness. Cause: ${cause} Fix: ${fix} Recheck: ${recheck ? recheck + " " : ""}Retry the same approved request only while its draft and head still match.` },
    hard ? "dependency_unavailable" : "validation_issue");
}

export function adopterIssue(rule: Rule, code: string, path: string): Issue {
  return { kind: "adopterRule", rule, code, path: path || "product" };
}

export function renderPublicationIssue(issue: Issue): CatalogCandidateIssue & { message: string } {
  if (issue.kind === "adopterRule") {
    const { kind: _kind, rule, detail: _detail, ...fields } = issue;
    return { ...fields, message: `Fix the rule violation ${issue.code} reported by ${rule} at ${issue.path}.` };
  }
  const { kind: _kind, stored, detail, ...fields } = issue;
  const { code, subject } = fields;
  const fix = stored ? "Recover the sealed publication or re-export it from a verified copy."
    : detail ?? (code === "catalog_publication_sku_too_large" && subject ? skuSizeFix.replace("this SKU", () => `SKU ${subject}`) : publicationRemedy(code));
  const sku = subject && (["catalog_publication_identifier_blank", "catalog_publication_identifier_key_reused",
    "catalog_publication_sku_price_not_ready", "catalog_publication_sku_price_shape_invalid",
    "catalog_publication_v3_activation_readiness_failed"].includes(code));
  return { ...fields, message: sku ? `SKU ${subject}. ${fix}` : fix };
}

/** @internal */
export class CatalogPublicationError extends Error {
  readonly diagnostic: Issue;
  constructor(issue: PlatformCode | Issue, readonly outcome: CatalogPublicationFailure["outcome"] = "validation_issue") {
    const diagnostic = typeof issue === "string" ? publicationIssue(issue, undefined, "") : issue;
    super(renderPublicationIssue(diagnostic).message);
    this.diagnostic = diagnostic;
    this.name = "CatalogPublicationError";
  }
  get code() { return this.diagnostic.code; }
  get stored() { return this.diagnostic.kind === "platform" && this.diagnostic.stored === true; }
}

export function publicationDiagnostic(error: CatalogPublicationError, phase: NonNullable<CatalogCandidateIssue["phase"]>,
  path: string, subject: string): Issue {
  const issue = error.diagnostic;
  return issue.phase ? issue : { ...issue, phase, path: issue.kind === "adopterRule" ? issue.path : path, subject };
}
export const publicationRefuse = (code: PlatformCode, outcome?: CatalogPublicationError["outcome"]): never => { throw new CatalogPublicationError(code, outcome); };

const publicationRefusals = {
  ...CATALOG_CONFORMANCE_RULES,
  catalog_publication_cursor_invalid: ["candidate_invalid", "Restart from the first page or reuse the continuation returned for this product."],
  catalog_publication_query_invalid: ["candidate_invalid", "Reload the product and use the publication identifiers returned for it."],
  catalog_publication_absent: ["catalog_publication_absent", "The selected publication does not exist. Reload the product and select one of its publications."],
  head_conflict: ["head_conflict", "The selected publication head does not match the saved publication. Reload the product and select its publication again."],
  catalog_publication_lineage_unknown: ["catalog_publication_lineage_unknown", "This product has no publication yet. Publish a revision of the product before reading its publication."],
  catalog_publication_read_invalid: ["catalog_publication_read_invalid", "The saved publication could not be read. Try again, and ask the store operator to check its publication history if this continues."],
  catalog_publication_envelope_too_large: ["catalog_publication_envelope_too_large", "The response is too large. Read the publication page by page."],
  catalog_publication_history_item_too_large: ["catalog_publication_history_item_too_large", "A saved publication is too large for a history page. Read that publication with the full page reader."],
  catalog_publication_readback_item_too_large: ["catalog_publication_readback_item_too_large", "A saved SKU revision is too large for one page. Ask the store operator to check the publication size limits."],
  catalog_publication_receipt_unsupported: ["catalog_publication_receipt_unsupported", "Receipt lookup needs an authorized publisher. Authorize the reader, then look up the receipt again."],
  publisher_not_authorized: ["publisher_not_authorized", "Sign in as a store administrator and try again."],
  retained_read_not_authorized: ["retained_read_not_authorized", "This account cannot read the retained revision. Use the account, order or fulfilment that owns it."],
  retained_revision_unavailable: ["retained_revision_unavailable", "The retained revision is not available in this store. Check that its source was accepted here, then try again."],
  retained_source_mismatch: ["retained_source_mismatch", "The retained revision does not match the selected source. Reload the source and select its revision again."],
  catalog_publication_wire_invalid: ["publication_details_invalid", "Some publication details are invalid. Review the product and its revisions, then try again."],
  catalog_publication_axes_invalid: ["publication_axes_invalid", "Product axes are invalid. Use unique lowercase dimension keys."],
  catalog_publication_attributes_invalid: ["publication_attributes_invalid", "An attribute value is invalid. Check the value type in the product or SKU definition."],
  catalog_publication_content_invalid: ["publication_content_invalid", "Product content is invalid. Review the presentation fields and SKU settings."],
  catalog_publication_sku_title_invalid: ["publication_sku_title_invalid", "A SKU title is missing or too long. Enter a shorter title."],
  catalog_publication_gtin_invalid: ["publication_gtin_invalid", "A SKU barcode has an invalid GTIN. Check its digits and try again."],
  catalog_publication_page_invalid: ["publication_details_too_large", "The product and one SKU exceed the publication size limit. Reduce product or SKU details and prepare it again."],
  catalog_publication_live_drift: ["publication_changed", "The current product or a SKU differs from the prepared publication. Reload the product and prepare it again."],
  catalog_publication_manifest_invalid: ["publication_details_invalid", "The publication contains invalid product details. Review the product and prepare it again."],
  catalog_publication_head_invalid: ["publication_changed", "The current publication changed. Reload the product and try again."],
  catalog_publication_lineage_invalid: ["publication_version_invalid", "The selected previous publication is unavailable. Reload the product and select its current publication."],
  catalog_publication_document_invalid: ["publication_content_changed", "The selected product content differs from the approved revision. Review the product and prepare it again."],
  catalog_publication_record_immutable: ["publication_requires_new_revision", "Saved publication details cannot be changed. Reload the product and prepare a new publication."],
  catalog_publication_issue_sealed: ["publication_requires_new_revision", "This publication is complete. Create a new publication to add the revision."],
  catalog_publication_sku_revision_invalid: ["publication_revision_invalid", "The product revisions do not match this publication. Reload the product and prepare it again."],
  catalog_publication_receipt_invalid: ["publication_incomplete", "The publication is incomplete. Reload the product and check its publication status before you try again."],
  catalog_publication_approval_missing: ["publication_approval_missing", "This publication needs an active approval. Approve the proposed revision first."],
  catalog_publication_candidate_already_issued: ["publication_candidate_already_issued", "This candidate is already issued; revoking it has no effect. No action is needed."],
  catalog_publication_net_weight_unsupported: ["publication_net_weight_unsupported", "Net content must be expressed in whole grams at scale 0 to publish. Other units cannot be published yet."],
  catalog_publication_approval_wrong: ["publication_approval_wrong", "The approval has changed. Reload the active decision and try again."],
  catalog_publication_approval_state_valid: ["publication_approval_state_invalid", "The approved product details are invalid. Each SKU may appear once in the approved state. Prepare the publication again."],
  catalog_publication_post_state_changed: ["publication_post_state_changed", "The product or its SKUs differ from the approval. Prepare the publication again."],
  catalog_publication_roster_limit: ["publication_roster_limit", "A product can retain up to 10,000 SKUs. Put additional SKUs on another product and prepare the publication again."],
  catalog_publication_sku_too_large: ["publication_sku_too_large", skuSizeFix],
  catalog_publication_sku_identity_changed: ["publication_sku_identity_changed", "A SKU code differs from its published identity. Restore the saved code or prepare a new SKU."],
  catalog_publication_document_required: ["publication_document_required", "Select a product document revision and prepare the draft again."],
  catalog_publication_primary_sku_required: ["publication_primary_sku_required", "Select the primary SKU and prepare the draft again."],
  catalog_publication_reserved_carrier: ["publication_reserved_carrier", "Keep the authored document in its designated draft field. Remove this reserved key from published details."],
  catalog_publication_facts_invalid: ["publication_facts_invalid", "Remove reserved document keys from the published product or SKU details. Keep the authored document only in its designated draft field, then prepare the publication again."],
  catalog_publication_receipt_input_invalid: ["publication_receipt_input_invalid", "The saved command result contains invalid text or structure. Restore the original result from a verified copy or ask the store operator to recover it."],
  catalog_publication_committed_at_valid: ["publication_time_invalid", "The publication date is out of range. Re-export a result dated between years 0001 and 9999."],
  catalog_publication_decided_at_valid: ["publication_decision_time_invalid", "The approval date is out of range. Re-export a decision dated between years 0001 and 9999."],
  catalog_publications_canonical_state_check: ["publication_details_invalid", "The saved product details are too large or empty. Review the product and prepare it again."],
  catalog_sku_revisions_full_facts_check: ["publication_revision_invalid", "A SKU's saved details are too large or empty. Review the SKU and prepare the product again."],
  catalog_publication_candidate_invalid: ["publication_approval_invalid", "Approval does not match the selected product revision. Review and approve that revision again."],
  catalog_publication_pointer_capability_unconsumed: ["publication_content_not_saved", "The selected product content was not saved. Select the content again and retry."],
  catalog_publication_busy: ["publication_busy", "Another catalogue change is in progress. Retry with the same command key."],
  catalog_publication_command_key_reused: ["publication_command_key_reused", "This command key belongs to a different request. Retry the original request or use a fresh key."],
  catalog_publication_gtin_conflict: ["publication_gtin_conflict", "This GTIN is already assigned. Verify the barcode and prepare the draft again.", "This GTIN is already assigned in the store, either to another SKU or to this SKU under a different issuer."],
  catalog_publication_identifier_conflict: ["publication_identifier_conflict", "This identifier is already assigned. Check its issuer and value."],
  catalog_publication_identifier_blank: ["publication_identifier_blank", "Enter a nonblank value for this identifier."],
  catalog_publication_identifier_key_reused: ["publication_identifier_key_reused", "Use a distinct issuer and value pair for this identifier."],
  catalog_publication_draft_advanced: ["publication_draft_advanced", "The saved draft changed. Prepare its current revision."],
  catalog_publication_route_conflict: ["publication_route_conflict", "Another product uses this route. Choose a different route and prepare the draft again."],
  catalog_publication_lifecycle_assertion_changed: ["publication_lifecycle_assertion_changed", "Reload the SKU revisions and prepare the lifecycle changes again."],
  catalog_publication_tax_class_unavailable: ["publication_tax_class_unavailable", "Install or activate the tax class declared by this product type.", "The selected product type declares a tax class that is absent or inactive."],
  catalog_publication_price_key_reused: ["publication_price_key_reused", "Use a distinct command key for each price change in the draft.", "More than one price change in the draft uses the same command key."],
  catalog_publication_price_changed: ["publication_price_changed", "The current base price differs from the draft. Reload it and prepare the draft again.", "The effective base price does not match the price state expected by the command."],
  catalog_publication_price_unavailable: ["publication_price_unavailable", "The base price could not be verified. Check the price list or retry the command.", "The price read or write did not return the evidence needed to verify the base price."],
  catalog_publication_price_readiness: ["publication_price_readiness", "Repair the reported price or offer readiness issue with its owner. Retry the same approved request while its draft and head still match.", "The proposed prices or offers do not meet the readiness requirements of the selected storefront or price list."],
  publication_authority_unavailable: ["publication_authority_unavailable", "Ask the publication owner to verify the required authority and evidence, then retry once they are available.", "The publication operation could not verify its required authority or evidence."],
  catalog_publication_sku_price_not_ready: ["publication_sku_price_not_ready", "Set a positive gross base price and check the subscription price for this SKU in the effective price list.", "The SKU fails the effective price list's readiness checks. There must be exactly one active, effective one-time entry at minimum quantity 1, and its gross amount must be positive. With no D2C subscription pricing policy history, there must be exactly one active, effective subscription entry, with a positive gross amount at minimum quantity 1. With policy history, exactly one valid policy revision must be effective and derive a positive price, and there must be no active, effective explicit subscription entry."],
  catalog_publication_sku_price_shape_invalid: ["publication_sku_price_shape_invalid", "Use gross one-time or subscription pricing at minimum quantity one for this SKU in the effective price list.", "The effective price entries have an unsupported tax basis, channel or minimum quantity."],
  price_list_not_active: ["price_list_not_active", "Activate the intended price list or select an effective list for the settlement region and currency.", "The price operation names an ineligible list, or the SKU readiness check found no eligible list. An eligible price list is active, matches the settlement region and currency, and is within its validity window."],
  price_list_not_found: ["price_list_not_found", "Select an installed, effective price list for the settlement region and currency, then prepare the draft again.", "The price list selected by the base-price command does not exist."],
  command_key_reused: ["command_key_reused", "Give the changed price operation a fresh command key and prepare the draft again.", "This price command key already belongs to a different fingerprint."],
  command_fingerprint_invalid: ["command_fingerprint_invalid", reviewDraft, "The price command fingerprint has an invalid format."],
  command_invalid: ["command_invalid", reviewDraft, "The submitted base-price operation violates the command’s input requirements."],
  operator_mismatch: ["operator_mismatch", "Have the administrator who completed the child price command replay it.", "A different operator owns the existing price command."],
  command_in_progress: ["command_in_progress", "Retry the publication with the same command keys after the price change finishes.", "The price command already has an unfinished claim."],
  sku_not_found: ["sku_not_found", "Select an existing SKU for the price change or create it in this publication.", "The price command refers to a SKU that does not exist."],
  sku_archived: ["sku_archived", "Restore the SKU before changing its price or remove the price change.", "The price command refers to an archived SKU."],
  base_price_ambiguous: ["base_price_ambiguous", "Resolve overlapping base price entries for this SKU and price list, then prepare the draft again.", "Multiple base-price entries match the same SKU and price-list context."],
  catalog_definition_drift: ["catalog_definition_drift", rulesMismatch],
  publication_preparation_unavailable: ["publication_preparation_unavailable", reviewDraft, "The selected draft version cannot be prepared here or required preparation evidence is unavailable."],
  catalog_publication_identity_conflict: ["publication_identity_conflict", "A product slug or SKU code is already in use. Choose an available identity and prepare the draft again."],
  activation_not_assessed: { fix: "Verify purchase readiness for the proposed product and SKUs." },
  activation_unknown: { fix: "Verify purchase readiness for the proposed product and SKUs." },
  candidate_dependency_unavailable: { fix: "Load the installed definition, draft and current publication before retrying." },
  candidate_digest_mismatch: { fix: "Prepare the selected draft and use its returned digest." },
  candidate_invalid: { fix: "Correct the candidate input and prepare the draft again." },
  catalog_action_conflict: { fix: "Choose create for a new product or revise for an existing publication." },
  catalog_archive_barrier_unavailable: ["catalog_archive_barrier_unavailable", "Keep the product or SKU withdrawn until catalogue archive is supported."],
  catalog_bound_obligations: ["catalog_bound_obligations", "Keep the product or SKU withdrawn while commerce obligations are outstanding."],
  catalog_obligation_evidence_unknown: ["catalog_obligation_evidence_unknown", "Keep the product or SKU withdrawn and reconcile the commerce owner records."],
  catalog_obligation_evidence_unavailable: ["catalog_obligation_evidence_unavailable", "Keep the product or SKU withdrawn until the complete commerce census is available."],
  catalog_lifecycle_child_effects_mismatch: { fix: "Reload the current lifecycle state and prepare a transition permitted for the product and its SKUs." },
  catalog_lifecycle_evidence_unavailable: ["catalog_lifecycle_evidence_unavailable", "This product was published without governed lifecycle. Keep revising it with schema-3 drafts until adoption is supported."],
  catalog_lifecycle_fresh_sale_refused: ["catalog_lifecycle_fresh_sale_refused", "Restore the withdrawn product and SKU before making them sellable."],
  catalog_lifecycle_last_active_child: { fix: "Keep an active child SKU or withdraw the whole product." },
  catalog_lifecycle_raw_status_fenced: ["catalog_lifecycle_raw_status_fenced", "Use a governed lifecycle operation to change status."],
  catalog_lifecycle_state_conflict: { fix: "Reload the current lifecycle state and prepare a transition permitted for the product and its SKUs." },
  catalog_publication_use_readback_v2: { fix: "Read this legacy issue with readbackV2." },
  catalog_publication_use_readback_v3: { fix: "Read this governed issue with readbackV3." },
  catalog_lifecycle_transition_refused: { fix: "Reload the current lifecycle state and prepare a transition permitted for the product and its SKUs." },
  catalog_lifecycle_withdrawal_overlay_refused: { fix: "Keep a withdrawal limited to status and purchase eligibility." },
  catalog_publication_activation_effect_missing: { fix: "Match purchase eligibility to the modes in the saved draft." },
  catalog_publication_authored_amounts_invalid: { fix: "Use a SKU code and net content accepted by the installed product rules." },
  catalog_publication_derived_source_mismatch: { fix: "Match the proposed SKU facts and options to the selected draft and installed derivation rules." },
  catalog_publication_document_bytes_unavailable: { fix: "Recover the selected document bytes from the receipted draft or a verified copy." },
  catalog_publication_document_revision_sequence: { fix: "Reload the document revisions and select the current revision or register the next one." },
  catalog_publication_document_source_mismatch: { fix: "Select a document revision backed by a saved draft for this product." },
  catalog_publication_document_source_missing: { fix: "Select a document revision backed by a saved draft for this product." },
  catalog_publication_document_text_copied: { fix: "Replace the copied document text with the display value for this field." },
  catalog_publication_eligibility_source_mismatch: { fix: "Match purchase eligibility to the modes in the saved draft." },
  catalog_publication_gross_below_net: { fix: "Supply a gross mass at least as large as the net content.", cause: "The SKU gross mass is less than its net content." },
  catalog_publication_gross_mass_invalid: { fix: "Supply a positive gross mass in an installed mass unit.", cause: "The SKU gross mass is invalid or uses a unit the pinned type cannot convert." },
  catalog_publication_gross_mass_required: { fix: "supply the gross mass for this SKU", cause: "The SKU needs a gross mass for the selected publication operation." },
  catalog_publication_identifier_effect_missing: { fix: "Match the identifier operation to the identifier saved for this SKU." },
  catalog_publication_identifier_primary_invalid: { fix: "Use a valid unit GTIN as the primary trade identifier." },
  catalog_publication_identifier_requires_created_sku: { fix: "Create the SKU before adding its identifier." },
  catalog_publication_identifier_source_mismatch: { fix: "Match the identifier operation to the identifier saved for this SKU." },
  catalog_publication_integral_grams_required: { fix: "Supply net content that converts to a supported positive whole number of grams.", cause: "Net content does not convert to a supported positive whole number of grams." },
  catalog_publication_net_content_invalid: { fix: "Supply a positive exact net quantity in an eligible unit of the pinned product type.", cause: "The SKU net content is absent or violates the pinned product type’s quantity rules." },
  catalog_publication_quantity_definition_unqualified: { fix: "Select an eligible unit with an exact conversion in the pinned product type, or use an eligible product type." },
  catalog_publication_activation_membership_required: { fix: "Admit this SKU to an offer before enabling purchases." },
  catalog_publication_logistics_source_mismatch: { fix: "Use the SKU metadata saved in the selected draft." },
  catalog_publication_mass_required_until_mc5: { fix: "Publish net content as the net mass in whole grams. Declare a labelled volume or count as a quantity variant option. If the option's dimension has role \"net_content\", remove that role in a new product type version, keep the option, and select the new version on the draft.", cause: "Publication accepts net content only as mass in whole grams." },
  catalog_publication_media_evidence_mismatch: { fix: "Bind the selected media reference and asset list to verified evidence for this SKU." },
  catalog_publication_media_readiness_unproven: { fix: "Bind the selected media reference and asset list to verified evidence for this SKU." },
  catalog_publication_media_validation_unavailable: { fix: "Verify the SKU media and retry once that evidence is available." },
  catalog_publication_membership_change_not_allowed: { fix: "Use the offer and admission status accepted by the saved draft and product rules." },
  catalog_publication_membership_effect_missing: { fix: "Use the offer and admission status accepted by the saved draft and product rules." },
  catalog_publication_membership_source_mismatch: { fix: "Use the offer and admission status accepted by the saved draft and product rules." },
  catalog_publication_metadata_effect_missing: { fix: "Use the SKU metadata saved in the selected draft." },
  catalog_publication_operation_invalid: { fix: "Use a supported publication operation." },
  catalog_publication_operation_source_ambiguous: { fix: "Select one receipted draft that authorizes this operation for the SKU." },
  catalog_publication_operation_source_mismatch: { fix: "Select one receipted draft that authorizes this operation for the SKU." },
  catalog_publication_operation_source_missing: { fix: "Select one receipted draft that authorizes this operation for the SKU." },
  catalog_publication_presentation_effect_missing: { fix: "Match the presentation operation to the saved product presentation." },
  catalog_publication_presentation_invalid: { fix: "Use the supported presentation fields and keep the authored document in the draft." },
  catalog_publication_presentation_source_mismatch: { fix: "Match the presentation operation to the saved product presentation." },
  catalog_publication_presentation_unavailable: { fix: "Verify the storefront presentation and route before retrying." },
  catalog_publication_product_identity_conflict: { fix: "Choose an unused product slug or revise the existing product." },
  catalog_publication_product_name_source_mismatch: { fix: "Use the product name saved in the selected draft." },
  catalog_publication_rule_failed: { fix: "Correct the reported rule hook and rebuild the product rules." },
  catalog_publication_rules_binding_mismatch: { fix: rulesMismatch },
  catalog_publication_rules_digest_mismatch: { fix: rulesMismatch },
  catalog_publication_rules_module_invalid: { fix: "Export all required hooks from the self-contained rules module and rebuild it." },
  catalog_publication_scope_expansion: { fix: "Keep changes within the product and SKUs named by the selected draft." },
  catalog_publication_sku_effect_missing: { fix: "Match the proposed SKU facts and options to the selected draft and installed derivation rules." },
  catalog_publication_source_invalid: { fix: "Select an open, receipted draft revision for this product." },
  catalog_publication_source_mismatch: { fix: "Select an open, receipted draft revision for this product." },
  catalog_publication_v3_activation_readiness_failed: { fix: "Supply the logistics reference for this SKU.", cause: "The SKU is being made sellable without its required logistics reference." },
  catalog_publication_v3_active_primary_required: { fix: "Activate the primary SKU with a purchase mode, or leave the product in draft.", cause: "The primary SKU is not active and sellable." },
  catalog_publication_v3_compile_archive_refused: { fix: "Withdraw the SKU through a supported lifecycle transition." },
  catalog_publication_v3_compile_change_noop: { fix: "Include a change to the product or one of its SKUs." },
  catalog_publication_v3_compile_derived_facts_mismatch: { fix: "Match the proposed SKU facts and options to the selected draft and installed derivation rules." },
  catalog_publication_v3_compile_document_absent: { fix: "Select a document revision backed by a saved draft for this product." },
  catalog_publication_v3_compile_document_conflict: { fix: "Reload the document revisions and select the current revision or register the next one." },
  catalog_publication_v3_compile_document_stale: { fix: "Reload the document revisions and select the current revision or register the next one." },
  catalog_publication_v3_compile_identifier_conflict: { fix: "Use a trade identifier that is unique to this SKU." },
  catalog_publication_v3_compile_primary_foreign: { fix: "Select a primary SKU belonging to this product." },
  catalog_publication_v3_compile_primary_immutable: { fix: "Keep the published primary SKU." },
  catalog_publication_v3_compile_product_absent: { fix: "Create the product before applying this operation." },
  catalog_publication_v3_compile_product_conflict: { fix: "Choose an unused product slug or revise the existing product." },
  catalog_publication_v3_compile_product_incomplete: { fix: "Set the document and the primary SKU before activation. Select a primary SKU or move set_primary_sku before set_product_status." },
  catalog_publication_v3_compile_sku_absent: { fix: "Select a SKU in the draft or create it before applying this operation." },
  catalog_publication_v3_compile_sku_archived: { fix: "Restore this SKU before making it sellable." },
  catalog_publication_v3_compile_sku_conflict: { fix: "Choose an unused SKU code." },
  catalog_publication_v3_document_digest_mismatch: { fix: "Use the canonical document bytes and their matching digest." },
  catalog_publication_v3_document_invalid: { fix: "Use a complete JSON object for the product document revision." },
  catalog_publication_v3_document_not_canonical: { fix: "Use the canonical document bytes and their matching digest." },
  catalog_publication_v3_document_reference_stale: { fix: "Reload the document revisions and select the current revision or register the next one." },
  catalog_publication_v3_presentation_required: { fix: "Supply the product presentation or its document revision." },
  catalog_publication_v3_structural_readiness_failed: { fix: "A new product needs its presentation. Add a set_product_presentation operation that matches the draft presentation." },
  channel_identity_not_assessed: { fix: "Verify trade identifiers and commercial readiness before selling this SKU." },
  commerce_product_slug_unsupported: { fix: "Use a lowercase product slug with letters, digits, hyphens or underscores." },
  commercial_activation_not_assessed: { fix: "Verify trade identifiers and commercial readiness before selling this SKU." },
  content_missing: { fix: "Supply the product presentation or its document revision." },
  current_primary_mismatch: { fix: "Reload the publication and select the current primary SKU." },
  dimension_not_declared: { fix: "Use a dimension installed for the product type and declared by this product." },
  dimension_not_installed: { fix: "Use a dimension installed for the product type and declared by this product." },
  document_reference_missing: { fix: "Select a document revision backed by a saved draft for this product." },
  duplicate_dimension: { fix: "Declare each selected dimension once." },
  duplicate_option_combination: { fix: "Use a distinct option combination for each SKU." },
  duplicate_sku_code: { fix: "Choose an unused SKU code." },
  duplicate_sku_id: { fix: "Use a distinct identifier for each SKU." },
  duplicate_trade_identifier: { fix: "Use a trade identifier that is unique to this SKU." },
  foreign_product_reference: { fix: "Reference the product that owns this draft." },
  gross_mass_invalid: { fix: "Supply a positive gross mass in an installed mass unit." },
  gross_mass_missing: { fix: "Supply the gross mass for this SKU." },
  intent_sku_absent: { fix: "Select a SKU in the draft or create it before applying this operation." },
  logistics_reference_missing: { fix: "Supply the logistics reference for this SKU." },
  media_readiness_mismatch: { fix: "Bind the selected media reference and asset list to verified evidence for this SKU." },
  media_readiness_unknown: { fix: "Verify the SKU media and retry once that evidence is available." },
  media_reference_missing: { fix: "Select the media reference for these assets." },
  net_content_invalid: { fix: "Supply net content in a unit admitted for this product type." },
  net_content_missing: { fix: "Supply the net content for this SKU." },
  net_content_option_mismatch: { fix: "Use the same net content in the SKU and its net-content option." },
  option_quantity_invalid: { fix: "Supply an option value that matches the installed dimension and its allowed values or units." },
  option_type_invalid: { fix: "Supply an option value that matches the installed dimension and its allowed values or units." },
  option_value_invalid: { fix: "Supply an option value that matches the installed dimension and its allowed values or units." },
  price_reference_missing: { fix: "Verify the selected price operations in the effective price list." },
  price_validation_unavailable: { fix: "Verify the selected price operations in the effective price list.", cause: "The price validator did not return usable validation evidence." },
  primary_sku_missing: { fix: "Select the primary SKU." },
  primary_sku_not_in_product: { fix: "Select a primary SKU belonging to this product." },
  publication_evidence_unavailable: { fix: "Load the current publication and its retained revisions before retrying." },
  publication_head_unavailable: { fix: "Load the current publication and its retained revisions before retrying." },
  sku_code_missing: { fix: "Supply the SKU code." },
  sku_missing: { fix: "Add a SKU for this product." },
  slug_missing: { fix: "Use a lowercase product slug with letters, digits, hyphens or underscores." },
  trade_identifier_invalid: { fix: "Supply a valid GTIN." },
  trade_identifier_quantity_invalid: { fix: "Use quantity one for a unit or at least two for a case." },
  trade_identifier_scheme_unsupported: { fix: "Use a supported trade identifier scheme." },
  type_not_installed: { fix: "Install the product type and version selected by the draft.", cause: "No installed definition matches the draft product type and version." },
  unit_trade_identifier_missing: { fix: "Add a valid unit trade identifier to the SKU, then prepare the draft again. For a product without a GS1 barcode, mint one with catalogInternalGtin.", cause: "The SKU needs a valid unit GTIN for publication." },
} as const satisfies Record<PlatformCode, Remedy>;

/** @internal Static owner guidance used by the CLI and reader guide. */
export { publicationRefusals };

export type AdmissionDiagnostic = PlatformCode;
export const refusePublicationCommand = publicationRefuse;
export function publicationRemedy(code: PlatformCode): string {
  const remedy = publicationRefusals[code];
  return "fix" in remedy ? remedy.fix : remedy[1];
}
type AdmissionRefusal = CatalogPublicationFailure & { outcome: "validation_issue"; message: string };

const acceptedReferenceRefusals = {
  catalog_accepted_reference_invalid: "Supply a schema-2 accepted reference with exactly the supported fields.",
  catalog_accepted_reference_mismatch: "Capture the reference from the SKU revision’s issuing publication and retry.",
  catalog_retained_revision_unavailable: "Recover the issuing publication and SKU revision from the retained catalogue before retrying.",
  catalog_acceptance_invalid: "Supply a schema-2 acceptance with 1 to 100 distinct SKU identities and codes.",
  catalog_acceptance_line_mismatch: "Use the persisted draft to register matching purchase lines, preview a fresh edit quote, or rebuild the cycle snapshot from the current due subscription.",
  catalog_acceptance_receipt_mismatch: "Supply the persisted draft receipt for this order and retry with its original key.",
  catalog_acceptance_snapshot_mismatch: "Use the stored renewal operation, its original acceptance and its frozen snapshot.",
  catalog_acceptance_snapshot_immutable: "Replay the renewal operation with its original acceptance and frozen snapshot.",
  catalog_acceptance_immutable: "Replay the owner command with its original acceptance and evidence.",
  catalog_acceptance_order_missing: "Persist the order and its draft receipt before attaching the acceptance.",
} as const;

const deferredForeignKeys = new Map<string, PlatformCode>([
  ["catalog_publications_previous_fk", "catalog_publication_lineage_invalid"],
  ["catalog_publication_heads_issue_fk", "catalog_publication_head_invalid"],
  ["catalog_sku_revisions_issue_fk", "catalog_publication_issue_sealed"],
  ["catalog_operator_receipts_issue_fk", "catalog_publication_receipt_invalid"],
  ["catalog_publication_decisions_receipt_fk", "catalog_publication_receipt_invalid"],
]);

function sqlAdmissionDiagnostic(error: unknown): PlatformCode | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return;
  if (error.code === "22023" && "message" in error && error.message === "catalog_publication_wire_invalid")
    return error.message;
  if (!("constraint" in error) || typeof error.constraint !== "string") return;
  if (error.code === "23503") return deferredForeignKeys.get(error.constraint);
  if (error.code === "23514" && Object.hasOwn(publicationRefusals, error.constraint)
    && !("fix" in publicationRefusals[error.constraint as PlatformCode])) return error.constraint as PlatformCode;
}

/** Maps publication admission diagnostics after the transaction has rolled back.
 * @experimental
 */
export function catalogPublicationAdmissionRefusal(error: unknown): AdmissionRefusal | null {
  if (error instanceof CatalogPublicationError) return { ...publicationFailure(error), outcome: "validation_issue" };
  if (error && typeof error === "object" && "code" in error && "message" in error
    && (error.code === "22023" || error.code === "55000") && typeof error.message === "string"
    && Object.hasOwn(acceptedReferenceRefusals, error.message)) {
    const reason = error.message as keyof typeof acceptedReferenceRefusals;
    return { outcome: "validation_issue", reason, message: acceptedReferenceRefusals[reason] };
  }
  const name = sqlAdmissionDiagnostic(error);
  if (!name) return null;
  const refusal = publicationRefusals[name];

  const contentFixes = {
    presentation: "Use the supported product presentation fields and review their values.",
    offerMemberships: "Set an offer and admission status once per SKU.",
    requestedModes: "Choose one-time purchase or subscription once per SKU.",
    publicationSkus: "Set a title, order minimum, and valid facts once per SKU.",
  };
  const field = error && typeof error === "object" && "column" in error && typeof error.column === "string" ? error.column : "";
  const message = name === "catalog_publication_content_invalid" && Object.hasOwn(contentFixes, field)
    ? contentFixes[field as keyof typeof contentFixes] : publicationRemedy(name);
  return { outcome: "validation_issue", reason: "fix" in refusal ? name : refusal[0], message };
}

function publicationFailure(error: CatalogPublicationError): CatalogPublicationFailure & { message: string } {
  const issue = error.diagnostic;
  const remedy = issue.kind === "platform" ? publicationRefusals[issue.code] : undefined;
  return { outcome: error.outcome, reason: remedy && !("fix" in remedy) ? remedy[0] : issue.code,
    message: error.message, ...(issue.path ? { path: issue.path } : {}), ...(issue.subject ? { subject: issue.subject } : {}),
    ...(issue.quantityCause === undefined ? {} : { quantityCause: issue.quantityCause }) };
}

export function publicationReadFailure(error: unknown): CatalogPublicationFailure & { message: string } {
  if (error instanceof CatalogPublicationError) return publicationFailure(error);
  const refusal = catalogPublicationAdmissionRefusal(error);
  return refusal ? { ...refusal, outcome: "dependency_unavailable" }
    : { outcome: "dependency_unavailable", reason: "publication_authority_unavailable", message: publicationRemedy("catalog_publication_read_invalid") };
}
