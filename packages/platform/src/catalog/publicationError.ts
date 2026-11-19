import type { CatalogCandidateIssue } from "./contracts/candidate.js";

const rulesMismatch = "The installed product rules differ from this build. Run node --test owned/catalogue-rules.test.cjs, then rerun ./lifecycle up locally or install the updated product rules before retrying.";

export function publicationIssue(code: string, phase: NonNullable<CatalogCandidateIssue["phase"]>, path: string, subject?: string): CatalogCandidateIssue {
  const message = code === "catalog_publication_rules_digest_mismatch" || code === "catalog_publication_rules_binding_mismatch"
    || code === "catalog_definition_drift" ? rulesMismatch
    : code === "catalog_publication_rules_module_invalid" ? "The product rules could not load. Run node --test owned/catalogue-rules.test.cjs and rebuild the self-contained rules module."
    : code === "price_list_not_found" ? "Select an installed price list for this price change, then prepare the draft again."
    : undefined;
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
export const publicationRefuse = (code: string, outcome?: CatalogPublicationError["outcome"]): never => { throw new CatalogPublicationError(code, outcome); };
