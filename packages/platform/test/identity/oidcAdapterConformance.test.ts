import { expect, it, vi } from "vitest";
import { reconcileAccountForPrincipal } from "../../src/identity/reconcileAccountForPrincipal.js";
import { createOperatorAdminAuth } from "../../src/identity/operatorAdminAuth.js";
import type { AccountLinkStore } from "../../src/identity/ports.js";
import * as jose from "jose";
import { createOidcIdentityVerifier } from "../../src/identity/oidcIdentityVerifier.js";
import { deriveOidcPrincipalId } from "../../src/identity/oidcPrincipal.js";
import { OIDC_FAILURE_CODES } from "../../src/identity/contracts/oidc.js";

it("browser_contracts_do_not_export_oidc_refusals", async () => {
  const contracts = await import("../../src/identity/contracts/index.js");
  expect(contracts).not.toHaveProperty("OIDC_FAILURE_CODES");
});
it("server_identity_exports_oidc_refusals_for_hosts", async () => {
  const identity = await import("../../src/identity/index.js");
  expect(identity).toHaveProperty("OIDC_FAILURE_CODES", OIDC_FAILURE_CODES);
});

const expectedPrincipal = { principalId: deriveOidcPrincipalId("https://issuer.example.com", "subject"), email: "customer@example.com", emailVerified: true };
async function verifiedPrincipal(operator = false) {
  const pair = await jose.generateKeyPair("ES256"), issuer = "https://issuer.example.com", audience = operator ? "operator-api" : "customer-api";
  const verifier = createOidcIdentityVerifier({ issuer, audience, algorithms: ["ES256"], maxTokenLifetimeSeconds: operator ? 900 : 3600, requireSingleAudience: operator }, {
    loadJwt: async () => jose, fetch: async url => Response.json(String(url).endsWith("openid-configuration") ? { issuer, jwks_uri: `${issuer}/keys` } : { keys: [{ ...await jose.exportJWK(pair.publicKey), alg: "ES256", use: "sig", kid: "key" }] }),
  });
  const token = await new jose.SignJWT({ iss: issuer, aud: audience, sub: "subject", email: "customer@example.com", email_verified: true, roles: ["admin"], iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 }).setProtectedHeader({ alg: "ES256", kid: "key" }).sign(pair.privateKey);
  const principal = await verifier.verifyAccessToken(token); expect(principal).toEqual(expectedPrincipal); return principal!;
}
function store(): AccountLinkStore {
  return { isReservedPrincipal: vi.fn(async () => false), findAccountByPrincipalId: vi.fn(async () => null),
    findAccountByEmail: vi.fn(async () => null), linkPrincipalToAccount: vi.fn(async () => ({ ok: true as const, alreadyLinked: false })), createAccount: vi.fn(async () => ({ id: "contact" })) };
}
it("normal_reconcile_keeps_trust_policy_and_conflict_retry", async () => {
  const principal = await verifiedPrincipal();
  const accounts = store(); const denied = { assess: async () => ({ trusted: false as const, code: "EMAIL_TRUST_ENVELOPE_REFUSED" as const }) };
  expect(await reconcileAccountForPrincipal(accounts, principal, denied)).toEqual({ ok: false, code: "EMAIL_TRUST_ENVELOPE_REFUSED" });
  expect(accounts.findAccountByEmail).not.toHaveBeenCalled(); expect(accounts.createAccount).not.toHaveBeenCalled();
  vi.mocked(accounts.createAccount).mockRejectedValueOnce(new Error("synthetic concurrent insert"));
  vi.mocked(accounts.findAccountByEmail).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "contact", email: principal.email, principalId: null });
  expect(await reconcileAccountForPrincipal(accounts, principal, { assess: async () => ({ trusted: true }) })).toEqual({ ok: true, accountId: "contact", created: false, linked: true });
  expect(accounts.findAccountByEmail).toHaveBeenCalledTimes(2);
  expect(accounts.linkPrincipalToAccount).toHaveBeenCalledWith("contact", principal.principalId);
});
it("legacy_links_and_machine_principals_refuse_without_writes", async () => {
  const principal = await verifiedPrincipal();
  const accounts = store(); vi.mocked(accounts.findAccountByEmail).mockResolvedValue({ id: "contact", email: principal.email, principalId: "11111111-1111-4111-8111-111111111111" });
  expect((await reconcileAccountForPrincipal(accounts, principal, { assess: async () => ({ trusted: true }) })).ok).toBe(false);
  vi.mocked(accounts.isReservedPrincipal).mockResolvedValue(true);
  expect(await reconcileAccountForPrincipal(accounts, principal, { assess: async () => ({ trusted: true }) })).toEqual({ ok: false, code: "RESERVED_PRINCIPAL_REFUSED" });
  expect(accounts.linkPrincipalToAccount).not.toHaveBeenCalled(); expect(accounts.createAccount).not.toHaveBeenCalled();
});
it("operator_uses_live_membership_only", async () => {
  const principal = await verifiedPrincipal(true);
  let state = "active";
  const findMembership = vi.fn(async () => ({ ...principal, email: principal.email!, role: "distributor", membershipState: state }));
  const auth = createOperatorAdminAuth({ verifier: { verifyAccessToken: async () => principal }, authority: { findMembership } });
  expect((await auth.authorize("signed-token")).ok).toBe(true);
  expect((await auth.authorize("signed-token", { allowedRoles: ["admin"] })).ok).toBe(false);
  state = "revoked"; expect((await auth.authorize("signed-token")).ok).toBe(false);
  findMembership.mockResolvedValueOnce(null as never); expect((await auth.authorize("signed-token")).ok).toBe(false);
  expect(findMembership).toHaveBeenCalledTimes(4);
});
