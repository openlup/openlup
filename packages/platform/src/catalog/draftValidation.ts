import { validateDraftFacts } from "./draftFacts.js";
import type { CatalogDraftPayload } from "./draftSchemas.js";
import {
  type CatalogDraftIssue, type CatalogProductTypeRegistry,
} from "./productTypeSchemas.js";
import { type Issue } from "./publicationError.js";

export interface CatalogDraftReadiness {
  publication: { status: "incomplete" | "not_assessed"; issues: CatalogDraftIssue[] };
  commercial: { status: "inactive"; issues: CatalogDraftIssue[] };
}
export type CatalogDraftValidation =
  | { valid: false; issues: CatalogDraftIssue[] }
  | { valid: true; readiness: CatalogDraftReadiness };

type OwnedReadiness = { [K in keyof CatalogDraftReadiness]: Omit<CatalogDraftReadiness[K], "issues"> & { issues: Issue[] } };
export type DraftValidationIssues = { valid: false; issues: Issue[] } | { valid: true; readiness: OwnedReadiness };

/** Supplied facts must be true; absent publish-time facts remain draft readiness issues. */
export function validateCatalogDraft(payload: CatalogDraftPayload, registry: CatalogProductTypeRegistry): CatalogDraftValidation {
  return draftValidationResult(validateDraftIssues(payload, registry));
}

export function draftValidationResult(result: DraftValidationIssues): CatalogDraftValidation {
  const field = ({ path, code }: Issue) => ({ path, code });
  if (!result.valid) return { valid: false, issues: result.issues.map(field) };
  const { publication, commercial } = result.readiness;
  return { valid: true, readiness: {
    publication: { ...publication, issues: publication.issues.map(field) },
    commercial: { ...commercial, issues: commercial.issues.map(field) },
  } };
}

export function validateDraftIssues(payload: CatalogDraftPayload, registry: CatalogProductTypeRegistry): DraftValidationIssues {
  return validateDraftFacts(payload, registry);
}
