import { expect, it } from "vitest";
import { identityEmailTrustReadiness } from "../../src/identity/identityReadiness.js";
import { createIdentityContribution } from "../../src/identity/contribution.js";
it.each(["EMAIL_TRUST_ENVELOPE_REFUSED", "EMAIL_TRUST_SETTINGS_UNAVAILABLE"] as const)("readiness_identifies_identity_module: %s", async code => {
  expect(await identityEmailTrustReadiness({ assess: async () => ({ trusted: false, code }) })).toEqual([expect.objectContaining({
    code: "OPENLUP_E_PORT_MISSING", package: "@openlup/platform", module: "identity", subject: "emailTrustPolicy", observation: code,
  })]);
});
it("safe policy is ready and policy port is always required", async () => {
  expect(await identityEmailTrustReadiness({ assess: async () => ({ trusted: true }) })).toEqual([]);
  const contribution = createIdentityContribution({ version: "0.15.0", requiredSchema: { version: "fixture", migration: "fixture", objects: [] }, requiredPorts: ["fixture"] });
  expect(contribution.manifest.requiredPorts).toEqual(["emailTrustPolicy", "fixture"]);
  expect(contribution.manifest.module.id).toBe("identity");
});
it("oidc_readiness_requires_discovery_and_fresh_jwks", async () => {
  const { identityOidcReadiness } = await import("../../src/identity/identityReadiness.js");
  const { createOidcIdentityVerifier } = await import("../../src/identity/oidcIdentityVerifier.js");
  const verifier = createOidcIdentityVerifier({ issuer: "https://issuer.example.com", audience: "customer-api", algorithms: ["RS256"], maxTokenLifetimeSeconds: 3600 }, {
    loadJwt: async () => { throw new Error("synthetic unavailable"); }, fetch: async () => { throw new Error("synthetic unavailable"); },
  });
  expect(await identityOidcReadiness(verifier)).toEqual([expect.objectContaining({ subject: "oidcDiscovery", module: "identity" }), expect.objectContaining({ subject: "oidcJwks", module: "identity" })]);
});
