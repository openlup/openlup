import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { createCustomerIdentityVerifier } from "./customerIdentityVerifier.js";
import { createCustomerSessionIssuer } from "./customerSessionIssuer.js";

describe("customer session issuer", () => {
  it("issues a token accepted by the existing offline verifier", async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    const privateJwk = { ...(await exportJWK(pair.privateKey)), alg: "ES256", use: "sig", kid: "customer.key" };
    const publicJwk = { ...(await exportJWK(pair.publicKey)), alg: "ES256", use: "sig", kid: "customer.key" };
    const config = {
      audience: "customer-audience",
      issuer: "https://identity.example.invalid",
      keyId: "customer.key",
      privateJwk: JSON.stringify(privateJwk),
      ttlSeconds: 600,
    };
    const issued = await createCustomerSessionIssuer(config).issue({
      principalId: "11111111-1111-4111-8111-111111111111",
      email: "Owner@Example.invalid",
    });
    const verified = await createCustomerIdentityVerifier({
      audience: config.audience,
      issuer: config.issuer,
      jwks: JSON.stringify({ keys: [publicJwk] }),
    }).verifyAccessToken(issued.accessToken);
    expect(verified?.principalId).toBe("11111111-1111-4111-8111-111111111111");
    expect(Date.parse(issued.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("rejects non-ES256 private material and unbounded TTL", async () => {
    expect(() => createCustomerSessionIssuer({
      audience: "a",
      issuer: "i",
      keyId: "k",
      privateJwk: "{}",
      ttlSeconds: 600,
    })).toThrow("private JWK");
    const pair = await generateKeyPair("ES256", { extractable: true });
    const jwk = { ...(await exportJWK(pair.privateKey)), alg: "ES256" };
    expect(() => createCustomerSessionIssuer({
      audience: "a",
      issuer: "i",
      keyId: "k",
      privateJwk: JSON.stringify(jwk),
      ttlSeconds: 1,
    })).toThrow("ttl");
  });
});
