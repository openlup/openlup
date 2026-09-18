import {
  validateEmailField,
  validateNameField,
  validatePhoneField,
} from "@/lib/schemas/fields";

import type { ConfiguratorFormData } from "./configuratorFormStore";

/** Outcome of the "Twoje dane" step: what to reject, and what to canonicalize. */
export interface YourDataEvaluation {
  /** Field -> `checkout:errors.*` key. Empty means the step may advance. */
  errors: Record<string, string>;
  /**
   * Canonical values the caller should merge into the form once the step
   * passes. Empty when nothing needed rewriting. Only ever *replaces* a value
   * the canonical validator accepted — never blanks one.
   */
  patch: Partial<ConfiguratorFormData>;
}

/**
 * Validate the "Twoje dane" step — owner first name, last name, email, phone.
 *
 * Captured right after the pet step so the email is known BEFORE pricing (the
 * package step). The email drives first-order discount eligibility server-side,
 * so resolving it early keeps the displayed price honest (no last-step "jump").
 *
 * Reuses the canonical field validators from `@/lib/schemas/fields` — the same
 * ones the address step uses — so error keys (`checkout:errors.*`) stay
 * identical across the flow and the ad-hoc-regex guardrail does not trip.
 *
 * Returns the canonical phone alongside the errors because
 * `validatePhoneField` already computes the E.164 form to decide validity, and
 * `docs/CANONICAL_FORM_FIELDS.md` requires the caller to keep it: "After a
 * successful parse, use `validatePhoneField(...).value`". This step used to
 * type the result as `{ success: boolean }`, which made `.value` structurally
 * unreachable, so a valid national number (`507231665`) passed validation and
 * was stored verbatim while an equivalent number typed as `+48507231665` was
 * stored canonically. The rejection rules and message keys are unchanged; only
 * the accepted value is now canonical.
 */
export function evaluateYourData(data: ConfiguratorFormData): YourDataEvaluation {
  const errors: Record<string, string> = {};
  const patch: Partial<ConfiguratorFormData> = {};
  const setIfInvalid = (
    field: string,
    result: { success: boolean },
    messageKey: string,
  ) => {
    if (!result.success) errors[field] = messageKey;
  };

  setIfInvalid("firstName", validateNameField(data.firstName), "checkout:errors.firstName");
  setIfInvalid("lastName", validateNameField(data.lastName), "checkout:errors.lastName");
  setIfInvalid("email", validateEmailField(data.email), "checkout:errors.email");

  const phone = validatePhoneField(data.phone, { country: data.country });
  setIfInvalid("phone", phone, "checkout:errors.phone");
  // Fail-open by construction: `validatePhoneField` returns `e164 ?? raw`, so an
  // unparsable number yields the untouched input and no patch entry.
  if (phone.success && phone.value && phone.value !== data.phone) {
    patch.phone = phone.value;
  }

  return { errors, patch };
}

/**
 * Errors-only view of {@link evaluateYourData}, for the "is this step still
 * valid?" predicates (progress-bar status, draft resume clamp) that never
 * advance the form and so have nothing to apply a patch to.
 */
export function validateYourData(data: ConfiguratorFormData): Record<string, string> {
  return evaluateYourData(data).errors;
}
