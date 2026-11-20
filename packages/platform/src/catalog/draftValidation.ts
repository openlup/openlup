import { validateDraftFacts } from "./draftFacts.js";
import type { CatalogDraftPayload } from "./draftSchemas.js";
import {
  type CatalogDraftIssue, type CatalogProductTypeRegistry,
} from "./productTypeSchemas.js";

export interface CatalogDraftReadiness {
  publication: { status: "incomplete" | "not_assessed"; issues: CatalogDraftIssue[] };
  commercial: { status: "inactive"; issues: CatalogDraftIssue[] };
}
export type CatalogDraftValidation =
  | { valid: false; issues: CatalogDraftIssue[] }
  | { valid: true; readiness: CatalogDraftReadiness };

/** Supplied facts must be true; absent publish-time facts remain draft readiness issues. */
export function validateCatalogDraft(payload: CatalogDraftPayload, registry: CatalogProductTypeRegistry): CatalogDraftValidation {
  return validateDraftFacts(payload, registry);
}
