import type { EmailTrustFailureCode } from "./contracts/emailTrust.js";
export type EmailTrustAssessment = { trusted: true } | { trusted: false; code: EmailTrustFailureCode };
export interface EmailTrustPolicy { assess(): Promise<EmailTrustAssessment> }
/** Explicitly retain verifier-only admission. This does not bypass mailbox verification. */
export function createVerifierResultOnlyEmailTrustPolicy(): EmailTrustPolicy {
  return { async assess() { return { trusted: true }; } };
}
/** Invalid, absent or throwing JavaScript bindings fail closed, including invalid results. */
export async function assessEmailTrust(policy: EmailTrustPolicy): Promise<EmailTrustAssessment> {
  try {
    const result = await policy.assess();
    if (result?.trusted === true) return { trusted: true };
    if (result?.trusted === false && result.code === "EMAIL_TRUST_ENVELOPE_REFUSED") return result;
  } catch { /* Do not expose policy or transport details. */ }
  return { trusted: false, code: "EMAIL_TRUST_SETTINGS_UNAVAILABLE" };
}
