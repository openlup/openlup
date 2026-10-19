import type { ReadinessIssue } from "@openlup/core/readiness";
import { identityEmailTrustReadiness, identityOidcReadiness, type OidcIdentityVerifier, type EmailTrustPolicy } from "@openlup/platform/identity";
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

/** Include only explicitly selected OIDC bindings in host admission. */
export async function assessOidcReadiness(verifiers: readonly OidcIdentityVerifier[]) {
  const issues = (await Promise.all(verifiers.map(verifier => identityOidcReadiness(verifier)))).flat();
  const state = !issues.length ? "ready" : issues.some(issue => issue.observation?.endsWith("_UNAVAILABLE") || issue.observation === "OIDC_JWKS_REFRESH_RATE_LIMITED") ? "unknown" : "unsatisfied";
  return { state, issues } as const;
}
