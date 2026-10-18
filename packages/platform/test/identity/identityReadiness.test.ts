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
