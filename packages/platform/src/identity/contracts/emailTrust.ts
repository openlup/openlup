/** Browser-safe email-association refusal codes. */
export const EMAIL_TRUST_FAILURE_CODES = [
  "EMAIL_TRUST_ENVELOPE_REFUSED", "EMAIL_TRUST_SETTINGS_UNAVAILABLE",
] as const;
export type EmailTrustFailureCode = typeof EMAIL_TRUST_FAILURE_CODES[number];
