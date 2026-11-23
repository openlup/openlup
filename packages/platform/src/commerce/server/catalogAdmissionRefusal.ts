const refusalCodes = [
  "catalog_admission_quote_authority_required",
  "catalog_admission_evidence_binding_mismatch",
  "catalog_admission_quote_projection_moved",
  "catalog_publication_head_moved",
  "catalog_admission_membership_authority_unavailable",
  "catalog_admission_line_ineligible",
  "catalog_admission_price_context_required",
  "catalog_admission_fence_unavailable",
  "catalog_admission_roster_archived",
  "catalog_acceptance_receipt_mismatch",
  "catalog_acceptance_line_mismatch",
  "catalog_acceptance_immutable",
] as const;

/** Read a safe admission refusal without copying upstream diagnostics.
 * @experimental
 */
export function catalogAdmissionRefusal(error: unknown): typeof refusalCodes[number] | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const { message, constraint, details } = error as { message?: unknown; constraint?: unknown; details?: { reason?: unknown } };
  return refusalCodes.find(code => code === message || code === constraint || code === details?.reason);
}
