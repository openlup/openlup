import type { catalogAdmissionRefusal } from "./catalogAdmissionRefusal.js";

export function catalogAdmissionRefusalMessage(reason: NonNullable<ReturnType<typeof catalogAdmissionRefusal>>): string {
  return reason === "catalog_admission_quote_authority_required"
    ? "Governed checkout is unavailable for this selection. Use a supported offer or replay the original request."
    : reason;
}
