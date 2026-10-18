import type { ReadinessIssue } from "@openlup/core/readiness";
import { identityEmailTrustReadiness, type EmailTrustPolicy } from "@openlup/platform/identity";
/** Reuse core's issue codes and host admission seam; never add a synchronous HTTP probe. */
export async function assessIdentityReadiness(bind: () => EmailTrustPolicy) {
  let issues: readonly (ReadinessIssue & { module: "identity" })[];
  try { issues = await identityEmailTrustReadiness(bind()); }
  catch {
    issues = [{ code: "OPENLUP_E_ENV_MISSING", package: "@openlup/platform", module: "identity",
      subject: "emailTrustPolicy", fix: "Configure the identity origin, public key and explicit provider declarations." }];
  }
  const state = !issues.length ? "ready" : issues.some(issue => issue.observation === "EMAIL_TRUST_SETTINGS_UNAVAILABLE") ? "unknown" : "unsatisfied";
  return { state, issues } as const;
}
