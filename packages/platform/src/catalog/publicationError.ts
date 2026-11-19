import type { CatalogCandidateIssue } from "./contracts/candidate.js";

const rulesMismatch = "The product rules and installed definition differ. Rebuild the rules, attach the build to the product type, and install the updated definition before retrying.";
const fixes = new Map([
  ["catalog_publication_rules_digest_mismatch", rulesMismatch],
  ["catalog_publication_rules_binding_mismatch", rulesMismatch],
  ["catalog_definition_drift", rulesMismatch],
  ["catalog_publication_rules_module_invalid", "Export all required hooks from the self-contained rules module and rebuild it."],
  ["price_list_not_found", "Select an installed price list for this price change, then prepare the draft again."],
  ["unit_trade_identifier_missing", "Add a valid unit trade identifier to the SKU, then prepare the draft again."],
  ["catalog_lifecycle_fresh_sale_refused", "Restore the withdrawn product and SKU before making them sellable."],
  ["catalog_publication_presentation_invalid", "Use the supported presentation fields and keep the authored document in the draft."],
  ["catalog_publication_facts_invalid", "Use scalar SKU facts. Put structured display values in typed attributes."],
  ["catalog_publication_document_text_copied", "Replace the copied document text with the display value for this field."],
]);

export function publicationIssue(code: string, phase: NonNullable<CatalogCandidateIssue["phase"]>, path: string, subject?: string): CatalogCandidateIssue {
  const message = fixes.get(code);
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
