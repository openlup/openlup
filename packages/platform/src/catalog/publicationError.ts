import type { CatalogPublicationFailure } from "./publicationContracts.js";
import type { CatalogCandidateIssue } from "./contracts/candidate.js";
import { z } from "./validation.js";

// Refusal reasons returned by the LC3 claim and apply routines.
export const publicationPriceRefusalReason = z.enum([
  "command_fingerprint_invalid", "command_invalid", "command_key_reused", "operator_mismatch",
  "command_in_progress", "sku_not_found", "sku_archived", "price_list_not_found",
  "price_list_not_active", "base_price_ambiguous",
]);
const reviewDraft = "Review the selected draft and prepare it again.";

const rulesMismatch = "The product rules and installed definition differ. Rebuild the rules, attach the build to the product type, and install the updated definition before retrying.";
const fixes = new Map([
  ["catalog_publication_rules_digest_mismatch", rulesMismatch],
  ["catalog_publication_rules_binding_mismatch", rulesMismatch],
  ["catalog_definition_drift", rulesMismatch],
  ["catalog_publication_rules_module_invalid", "Export all required hooks from the self-contained rules module and rebuild it."],
  ["unit_trade_identifier_missing", "Add a valid unit trade identifier to the SKU, then prepare the draft again."],
  ["catalog_lifecycle_fresh_sale_refused", "Restore the withdrawn product and SKU before making them sellable."],
  ["catalog_publication_gross_mass_required", "supply the gross mass for this SKU"],
  ["catalog_publication_presentation_invalid", "Use the supported presentation fields and keep the authored document in the draft."],
  ["catalog_publication_v3_compile_product_incomplete", "Set the document and the primary SKU before activation. Select a primary SKU or move set_primary_sku before set_product_status."],
  ["catalog_publication_v3_document_invalid", "Use a complete JSON object for the product document revision."],
  ["sku_identity_change_requires_new_sku", "Keep the existing SKU identity or prepare a new SKU."],
  ["catalog_publication_document_text_copied", "Replace the copied document text with the display value for this field."],
]);

function skuSizeRemedy(subject?: string): string {
  return `Reduce the facts or details for ${subject ? `SKU ${subject}` : "this SKU"} and prepare the publication again.`;
}

export function publicationIssue(code: string, phase: NonNullable<CatalogCandidateIssue["phase"]>, path: string, subject?: string): CatalogCandidateIssue {
  let message = code === "catalog_publication_sku_too_large" ? skuSizeRemedy(subject) : fixes.get(code) ?? (Object.hasOwn(publicationRefusals, code) ? publicationRefusals[code as AdmissionDiagnostic][1] : undefined);
  if (subject && message && ["catalog_publication_identifier_blank", "catalog_publication_identifier_key_reused",
    "catalog_publication_sku_price_not_ready", "catalog_publication_sku_price_shape_invalid"].includes(code)) {
    message = `SKU ${subject}. ${message}`;
  }
  return { code, phase, path, ...(subject === undefined ? {} : { subject }), ...(message === undefined ? {} : { message }) };
}

/** @internal */
export class CatalogPublicationError extends Error {
  constructor(readonly code: string, readonly outcome: "unauthorized" | "validation_issue" | "conflict" | "dependency_unavailable" | "unsupported" = "validation_issue",
    readonly diagnostic?: CatalogCandidateIssue) {
    super((diagnostic ?? publicationIssue(code, "structural", "publication")).message ?? code);
    this.name = "CatalogPublicationError";
  }
}

export function publicationDiagnostic(error: CatalogPublicationError, phase: NonNullable<CatalogCandidateIssue["phase"]>,
  path: string, subject: string): CatalogCandidateIssue {
  return error.diagnostic?.phase ? error.diagnostic : {
    ...error.diagnostic, ...publicationIssue(error.code, phase, path, subject),
  };
}
export const publicationRefuse = (code: string, outcome?: CatalogPublicationError["outcome"]): never => { throw new CatalogPublicationError(code, outcome); };

export const publicationRefusals = {
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
  catalog_publication_sku_too_large: ["publication_sku_too_large", skuSizeRemedy()],
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
  catalog_publication_gtin_conflict: ["publication_gtin_conflict", "This GTIN is already assigned. Verify the barcode and prepare the draft again."],
  catalog_publication_identifier_conflict: ["publication_identifier_conflict", "This identifier is already assigned. Check its issuer and value."],
  catalog_publication_identifier_blank: ["publication_identifier_blank", "Enter a nonblank value for this identifier."],
  catalog_publication_identifier_key_reused: ["publication_identifier_key_reused", "Use a distinct issuer and value pair for this identifier."],
  catalog_publication_draft_advanced: ["publication_draft_advanced", "The saved draft changed. Prepare its current revision."],
  catalog_publication_route_conflict: ["publication_route_conflict", "Another product uses this route. Choose a different route and prepare the draft again."],
  catalog_publication_lifecycle_assertion_changed: ["publication_lifecycle_assertion_changed", "Reload the SKU revisions and prepare the lifecycle changes again."],
  catalog_publication_tax_class_unavailable: ["publication_tax_class_unavailable", "Install or activate the tax class declared by this product type."],
  catalog_publication_price_key_reused: ["publication_price_key_reused", "Use a distinct command key for each price change in the draft."],
  catalog_publication_price_changed: ["publication_price_changed", "The current base price differs from the draft. Reload it and prepare the draft again."],
  catalog_publication_price_unavailable: ["publication_price_unavailable", "The base price could not be verified. Check the price list or retry the command."],
  catalog_publication_price_readiness: ["publication_price_readiness", "The proposed prices or offers do not meet storefront readiness. Check their setup and prepare the draft again."],
  catalog_publication_sku_price_not_ready: ["publication_sku_price_not_ready", "Set a positive gross base price and check the subscription price for this SKU in the effective price list."],
  catalog_publication_sku_price_shape_invalid: ["publication_sku_price_shape_invalid", "Use gross one-time or subscription pricing at minimum quantity one for this SKU in the effective price list."],
  price_list_not_active: ["price_list_not_active", "Activate the intended price list or select an effective list for the settlement region and currency."],
  price_list_not_found: ["price_list_not_found", "Select an installed, effective price list for the settlement region and currency, then prepare the draft again."],
  command_key_reused: ["command_key_reused", "Give the changed price operation a fresh command key and prepare the draft again."],
  command_fingerprint_invalid: ["command_fingerprint_invalid", reviewDraft],
  command_invalid: ["command_invalid", reviewDraft],
  operator_mismatch: ["operator_mismatch", reviewDraft],
  command_in_progress: ["command_in_progress", "Retry the publication with the same command keys after the price change finishes."],
  sku_not_found: ["sku_not_found", "Select an existing SKU for the price change or create it in this publication."],
  sku_archived: ["sku_archived", "Restore the SKU before changing its price or remove the price change."],
  base_price_ambiguous: ["base_price_ambiguous", "Resolve overlapping base price entries for this SKU and price list, then prepare the draft again."],
  catalog_definition_drift: ["catalog_definition_drift", rulesMismatch],
  publication_preparation_unavailable: ["publication_preparation_unavailable", reviewDraft],
  publication_evaluation_refused: ["publication_evaluation_refused", reviewDraft],
  catalog_publication_identity_conflict: ["publication_identity_conflict", "A product slug or SKU code is already in use. Choose an available identity and prepare the draft again."],
  duplicate_combination: ["duplicate_combination", "A SKU already has this combination of options. Use distinct options for the new SKU."],
} as const satisfies Record<string, readonly [string, string]>
  & Record<z.infer<typeof publicationPriceRefusalReason>, readonly [string, string]>;

export type AdmissionDiagnostic = keyof typeof publicationRefusals;
export const refusePublicationCommand: (code: AdmissionDiagnostic, outcome?: CatalogPublicationError["outcome"]) => never = publicationRefuse;
export function publicationRemedy(code: AdmissionDiagnostic): string {
  return publicationRefusals[code][1];
}
type AdmissionRefusal = { outcome: "validation_issue"; reason: (typeof publicationRefusals)[AdmissionDiagnostic][0]; message: string; path?: string };

const deferredForeignKeys = new Map([
  ["catalog_publications_previous_fk", "catalog_publication_lineage_invalid"],
  ["catalog_publication_heads_issue_fk", "catalog_publication_head_invalid"],
  ["catalog_sku_revisions_issue_fk", "catalog_publication_issue_sealed"],
  ["catalog_operator_receipts_issue_fk", "catalog_publication_receipt_invalid"],
  ["catalog_publication_decisions_receipt_fk", "catalog_publication_receipt_invalid"],
]);

function sqlAdmissionDiagnostic(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return;
  if (error.code === "22023" && "message" in error && error.message === "catalog_publication_wire_invalid")
    return error.message;
  if (!("constraint" in error) || typeof error.constraint !== "string") return;
  if (error.code === "23503") return deferredForeignKeys.get(error.constraint);
  if (error.code === "23514") return error.constraint;
}

/** Maps publication admission diagnostics after the transaction has rolled back.
 * @experimental
 */
export function catalogPublicationAdmissionRefusal(error: unknown): AdmissionRefusal | null {
  const diagnostic = error instanceof CatalogPublicationError ? error.code : sqlAdmissionDiagnostic(error);
  if (!diagnostic || !Object.hasOwn(publicationRefusals, diagnostic)) return null;
  const name = diagnostic as AdmissionDiagnostic;
  const refusal = publicationRefusals[name];

  const contentFixes = {
    presentation: "Use the supported product presentation fields and review their values.",
    offerMemberships: "Set an offer and admission status once per SKU.",
    requestedModes: "Choose one-time purchase or subscription once per SKU.",
    publicationSkus: "Set a title, order minimum, and valid facts once per SKU.",
  };
  const field = error && typeof error === "object" && "column" in error && typeof error.column === "string" ? error.column : "";
  const message = name === "catalog_publication_content_invalid" && Object.hasOwn(contentFixes, field)
    ? contentFixes[field as keyof typeof contentFixes] : refusal[1];
  const path = error instanceof CatalogPublicationError ? error.diagnostic?.path : undefined;
  return { outcome: "validation_issue", reason: refusal[0], message, ...(path ? { path } : {}) };
}

export function publicationReadFailure(error: unknown): CatalogPublicationFailure & { message: string } {
  const unreadable = publicationRefusals.catalog_publication_read_invalid[1];
  if (error instanceof CatalogPublicationError) {
    const details = Object.hasOwn(publicationRefusals, error.code) ? publicationRefusals[error.code as AdmissionDiagnostic] : undefined;
    return { outcome: error.outcome, reason: details?.[0] ?? "publication_authority_unavailable", message: details?.[1] ?? unreadable };
  }
  const refusal = catalogPublicationAdmissionRefusal(error);
  return refusal ? { ...refusal, outcome: "dependency_unavailable" }
    : { outcome: "dependency_unavailable", reason: "publication_authority_unavailable", message: unreadable };
}
