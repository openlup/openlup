import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
export type OidcTokens = { access_token: string; refresh_token: string; id_token: string };
/** Real issuer administration. Credentials and token responses never enter diagnostics. */
export async function createOidcIssuerFixture(origin: string, adminPassword: string, redirectUri: string) {
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${origin}${path}`, { ...init, redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("Owned issuer operation refused");
    const text = await response.text(); return text ? JSON.parse(text) : null;
  };
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try { await request("/realms/master/.well-known/openid-configuration"); ready = true; break; } catch { /* Only startup is retried. */ }
    await new Promise(done => setTimeout(done, 500));
  }
  assert(ready, "Owned issuer startup deadline exceeded");
  const adminToken = () => request("/realms/master/protocol/openid-connect/token", { method: "POST", body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "conformance-admin", password: adminPassword }) });
  const password = randomBytes(24).toString("hex");
  const realms = ["reference", "foreign"];
  const adminRequest = async (path: string, method = "GET", body?: unknown) => request(`/admin${path}`, {
    method, headers: { authorization: `Bearer ${(await adminToken()).access_token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  for (const realm of realms) {
    await adminRequest("/realms", "POST", { realm, enabled: true, sslRequired: "none", accessTokenLifespan: 8,
      ssoSessionIdleTimeout: 1800, ssoSessionMaxLifespan: 3600, revokeRefreshToken: false,
      clients: ["customer-rp", "operator-rp", "foreign-rp"].map(clientId => ({ clientId, enabled: true, publicClient: true,
        standardFlowEnabled: true, directAccessGrantsEnabled: false, defaultClientScopes: ["profile", "email"], redirectUris: [redirectUri], webOrigins: [new URL(redirectUri).origin],
        attributes: { "pkce.code.challenge.method": "S256" },
        protocolMappers: [{ name: "api-audience", protocol: "openid-connect", protocolMapper: "oidc-audience-mapper", config: {
          "included.custom.audience": clientId === "customer-rp" ? "customer-api" : clientId === "operator-rp" ? "operator-api" : "foreign-api",
          "id.token.claim": "false", "access.token.claim": "true",
        } }],
      })),
      users: [true, false].map(verified => ({ username: verified ? "customer" : "unverified", enabled: true, email: `${verified ? "customer" : "unverified"}@example.com`,
        firstName: "Example", lastName: "User", emailVerified: verified, credentials: [{ type: "password", value: password, temporary: false }] })),
    });
  }
  const issuer = `${origin}/realms/reference`;
  return { issuer, password, issuerFor: (realm: string) => `${origin}/realms/${realm}`,
    async rotate() {
      const realm = await adminRequest("/realms/reference");
      await adminRequest("/realms/reference/components", "POST", { name: "rotated-signing-key", parentId: realm.id,
        providerId: "rsa-generated", providerType: "org.keycloak.keys.KeyProvider", config: { priority: ["200"], enabled: ["true"], active: ["true"], algorithm: ["RS256"], keySize: ["2048"] } });
    },
    async removePreviousKeys() {
      const components = await adminRequest("/realms/reference/components?type=org.keycloak.keys.KeyProvider");
      for (const component of components) if (component.name !== "rotated-signing-key" && component.providerId === "rsa-generated") await adminRequest(`/realms/reference/components/${encodeURIComponent(component.id)}`, "DELETE");
    },
    async logout(refreshToken: string, clientId: string) {
      const response = await fetch(`${issuer}/protocol/openid-connect/logout`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000), body: new URLSearchParams({ client_id: clientId, refresh_token: refreshToken }) });
      assert(response.ok, "Issuer logout refused");
    },
    async refresh(refreshToken: string, clientId: string): Promise<OidcTokens | null> {
      const response = await fetch(`${issuer}/protocol/openid-connect/token`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000), body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }) });
      return response.ok ? response.json() : null;
    },
  };
}
