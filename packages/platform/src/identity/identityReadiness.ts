import type { ReadinessIssue } from "@openlup/core/readiness";
import { assessEmailTrust, type EmailTrustPolicy } from "./emailTrustPolicy.js";

/** The module field stays structural so older core readiness types still compile; no new core code is needed. */
export async function identityEmailTrustReadiness(policy: EmailTrustPolicy): Promise<readonly (ReadinessIssue & { module: "identity" })[]> {
  const result = await assessEmailTrust(policy);
  if (result.trusted) return [];
  return [{
    code: "OPENLUP_E_PORT_MISSING", package: "@openlup/platform", module: "identity",
    subject: "emailTrustPolicy", observation: result.code,
    fix: result.code === "EMAIL_TRUST_ENVELOPE_REFUSED"
      ? "Disable automatic confirmation and declare only providers that verify email."
      : "Restore access to valid public identity settings or bind an explicit email-trust policy.",
  }];
}

/** Discovery and fresh key availability are independent readiness observations. */
export async function identityOidcReadiness(verifier: import("./oidcIdentityVerifier.js").OidcIdentityVerifier): Promise<readonly (ReadinessIssue & { module: "identity" })[]> {
  const report = await verifier.readiness();
  if (report.state === "ready") return [];
  return [
    ...(!report.discovery.valid ? ["oidcDiscovery"] : []),
    ...(!report.jwks.loaded ? ["oidcJwks"] : []),
  ].map(subject => ({ code: "OPENLUP_E_PORT_MISSING", package: "@openlup/platform", module: "identity", subject,
    observation: report.code ?? "OIDC_JWKS_INVALID", fix: "Restore valid issuer discovery and fresh same-origin signing keys." }));
}
