import { expect, it, vi } from "vitest";
import * as jose from "jose";
import { createOidcIdentityVerifier, type OidcIdentityVerifierConfig } from "../../src/identity/oidcIdentityVerifier.js";
const issuer = "https://issuer.example.com/realm";
const audience = "customer-api";
const epoch = 1900000000000;
async function fixture(config: Partial<OidcIdentityVerifierConfig> = {}) {
  let time = epoch, unavailable = false;
  const first = await jose.generateKeyPair("RS256");
  const second = await jose.generateKeyPair("RS256");
  const jwk = async (pair: typeof first, kid: string) => ({ ...await jose.exportJWK(pair.publicKey), alg: "RS256", kid, use: "sig" });
  let keys = [await jwk(first, "first")];
  const fetch = vi.fn(async (url: string | URL | Request) => {
    if (unavailable) throw new Error("synthetic transport failure");
    return Response.json(String(url).endsWith("openid-configuration") ? { issuer, jwks_uri: `${issuer}/keys` } : { keys });
  });
  const loadJwt = vi.fn(async () => jose);
  const verifier = createOidcIdentityVerifier({ issuer, audience, algorithms: ["RS256"], maxTokenLifetimeSeconds: 3600, ...config }, { fetch, loadJwt, now: () => time });
  const token = (claims: Record<string, unknown> = {}, kid = "first", pair = first, algorithm = "RS256") => new jose.SignJWT({
    iss: issuer, aud: audience, sub: "subject", email: "customer@example.com", email_verified: true,
    iat: Math.floor(time / 1000), exp: Math.floor(time / 1000) + 300, ...claims,
  }).setProtectedHeader({ alg: algorithm, kid }).sign(pair.privateKey);
  return { verifier, token, fetch, loadJwt, first, second, jwk, advance: (ms: number) => { time += ms; },
    rotate: async () => { keys = [await jwk(second, "second")]; }, fail: () => { unavailable = true; } };
}
const denied = (code: string) => ({ ok: false, code });
it("construction_and_import_are_cold", async () => {
  const f = await fixture(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.loadJwt).not.toHaveBeenCalled();
  expect((await f.verifier.verifyToken(await f.token())).ok).toBe(true);
});
it("requires_verified_signature_and_allowed_algorithm", async () => {
  const f = await fixture();
  expect(await f.verifier.verifyToken(await f.token({}, "first", f.second))).toEqual(denied("OIDC_TOKEN_INVALID"));
  const hmac = await new jose.SignJWT({}).setProtectedHeader({ alg: "HS256", kid: "first" }).sign(new Uint8Array(32));
  expect(await f.verifier.verifyToken(hmac)).toEqual(denied("OIDC_TOKEN_INVALID"));
  expect(await f.verifier.verifyToken("e30.e30.e30")).toEqual(denied("OIDC_TOKEN_INVALID"));
});
it.each(["RS256", "ES256"] as const)("supports_declared_asymmetric_profile %s", async algorithm => {
  const pair = await jose.generateKeyPair(algorithm);
  const keys = [{ ...await jose.exportJWK(pair.publicKey), alg: algorithm, use: "sig", kid: "key" }];
  const verifier = createOidcIdentityVerifier({ issuer, audience, algorithms: [algorithm], maxTokenLifetimeSeconds: 3600 }, {
    loadJwt: async () => jose, now: () => epoch,
    fetch: async url => Response.json(String(url).endsWith("openid-configuration") ? { issuer, jwks_uri: `${issuer}/keys` } : { keys }),
  });
  const token = await new jose.SignJWT({ iss: issuer, aud: audience, sub: "subject", email: "a@example.com", email_verified: true, iat: epoch / 1000, exp: epoch / 1000 + 300 }).setProtectedHeader({ alg: algorithm, kid: "key" }).sign(pair.privateKey);
  expect((await verifier.verifyToken(token)).ok).toBe(true);
});
it.each([
  [{ iss: "https://foreign.example.com" }, "OIDC_ISSUER_MISMATCH"],
  [{ aud: "foreign-api" }, "OIDC_AUDIENCE_MISMATCH"],
  [{ exp: undefined }, "OIDC_TOKEN_LIFETIME_INVALID"],
  [{ iat: epoch / 1000 - 1, exp: epoch / 1000 }, "OIDC_TOKEN_EXPIRED"],
  [{ nbf: epoch / 1000 + 1 }, "OIDC_TOKEN_NOT_ACTIVE"],
  [{ iat: epoch / 1000 + 1 }, "OIDC_TOKEN_LIFETIME_INVALID"],
  [{ exp: epoch / 1000 + 3601 }, "OIDC_TOKEN_LIFETIME_INVALID"],
  [{ exp: epoch / 1000 + 0.5 }, "OIDC_TOKEN_LIFETIME_INVALID"],
  [{ iat: epoch / 1000 - 0.5 }, "OIDC_TOKEN_LIFETIME_INVALID"],
  [{ nbf: epoch / 1000 - 0.5 }, "OIDC_TOKEN_NOT_ACTIVE"],
  [{ sub: "" }, "OIDC_SUBJECT_INVALID"],
  [{ email: "customer\u0000@example.com" }, "OIDC_EMAIL_INVALID"],
  [{ email: "invalid" }, "OIDC_EMAIL_INVALID"],
  [{ email_verified: "true" }, "OIDC_EMAIL_UNVERIFIED"],
  [{ email_verified: undefined, user_metadata: { email_verified: true } }, "OIDC_EMAIL_UNVERIFIED"],
  [{ email_verified: false }, "OIDC_EMAIL_UNVERIFIED"],
])("rejects_signed_claim_boundary %j", async (claims, code) => {
  const f = await fixture(); expect(await f.verifier.verifyToken(await f.token(claims))).toEqual(denied(code));
});
it("operator_retains_scalar_audience_and_900_second_profile", async () => {
  const f = await fixture({ audience: "operator-api", maxTokenLifetimeSeconds: 900, requireSingleAudience: true });
  expect(await f.verifier.verifyToken(await f.token())).toEqual(denied("OIDC_AUDIENCE_MISMATCH"));
  expect(await f.verifier.verifyToken(await f.token({ aud: ["operator-api"] }))).toEqual(denied("OIDC_AUDIENCE_MISMATCH"));
  expect(await f.verifier.verifyToken(await f.token({ aud: "operator-api", exp: epoch / 1000 + 901 }))).toEqual(denied("OIDC_TOKEN_LIFETIME_INVALID"));
  expect((await f.verifier.verifyToken(await f.token({ aud: "operator-api", exp: epoch / 1000 + 900 }))).ok).toBe(true);
});
it("principal_is_stable_across_refresh_email_and_key_change", async () => {
  const f = await fixture(); const initial = await f.verifier.verifyToken(await f.token());
  await f.rotate(); f.advance(31000);
  const next = await f.verifier.verifyToken(await f.token({ email: "changed@example.com" }, "second", f.second));
  expect(initial.ok && next.ok && initial.principal.principalId === next.principal.principalId).toBe(true);
});
it("unknown_kid_refreshes_once_then_refuses", async () => {
  const f = await fixture(); await f.verifier.readiness();
  const missing = await f.token({}, "missing");
  expect(await f.verifier.verifyToken(missing)).toEqual(denied("OIDC_JWKS_REFRESH_RATE_LIMITED"));
  f.advance(30000);
  expect(await f.verifier.verifyToken(missing)).toEqual(denied("OIDC_KID_UNKNOWN"));
  expect(await f.verifier.verifyToken(missing)).toEqual(denied("OIDC_JWKS_REFRESH_RATE_LIMITED"));
  expect(f.fetch).toHaveBeenCalledTimes(3);
  f.advance(30000); f.fail();
  expect(await f.verifier.verifyToken(missing)).toEqual(denied("OIDC_JWKS_UNAVAILABLE"));
  expect(await f.verifier.verifyToken(missing)).toEqual(denied("OIDC_JWKS_REFRESH_RATE_LIMITED"));
  expect(f.fetch).toHaveBeenCalledTimes(4);
});
it("rotation_replaces_keys_and_expired_cache_fails_closed", async () => {
  const f = await fixture(); const old = await f.token({ exp: epoch / 1000 + 3600 });
  expect((await f.verifier.verifyToken(old)).ok).toBe(true);
  f.advance(30000); await f.rotate();
  expect((await f.verifier.verifyToken(await f.token({}, "second", f.second))).ok).toBe(true);
  expect(await f.verifier.verifyToken(old)).toEqual(denied("OIDC_JWKS_REFRESH_RATE_LIMITED"));
  f.advance(301000); f.fail();
  expect(await f.verifier.verifyToken(await f.token({}, "second", f.second))).toEqual(denied("OIDC_JWKS_UNAVAILABLE"));
  expect((await f.verifier.readiness()).jwks.loaded).toBe(false);
});
it("coalesces_requests_and_does_not_refresh_for_known_bad_signature", async () => {
  const f = await fixture(); const valid = await f.token();
  const results = await Promise.all(Array.from({ length: 8 }, () => f.verifier.verifyToken(valid)));
  expect(results.every(result => result.ok)).toBe(true); expect(f.fetch).toHaveBeenCalledTimes(2);
  f.advance(31000);
  expect(await f.verifier.verifyToken(await f.token({}, "first", f.second))).toEqual(denied("OIDC_TOKEN_INVALID"));
  expect(f.fetch).toHaveBeenCalledTimes(2);
});
it.each([
  [{ issuer: "https://foreign.example.com", jwks_uri: `${issuer}/keys` }, "OIDC_DISCOVERY_INVALID"],
  [{ issuer, jwks_uri: "https://foreign.example.com/keys" }, "OIDC_DISCOVERY_INVALID"],
  [{ issuer, jwks_uri: `${issuer}/keys?secret=invalid` }, "OIDC_DISCOVERY_INVALID"],
])("discovery_is_pinned %j", async (document, code) => {
  const verifier = createOidcIdentityVerifier({ issuer, audience, algorithms: ["RS256"], maxTokenLifetimeSeconds: 3600 }, { loadJwt: async () => jose, fetch: async (_url, init) => {
    expect(init?.redirect).toBe("error"); return Response.json(document);
  } });
  expect((await verifier.readiness()).code).toBe(code);
});
it("discovery_body_is_bounded_and_deadline_includes_body", async () => {
  vi.useFakeTimers();
  try {
    for (const [body, code] of [
      [new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ issuer, jwks_uri: `${issuer}/keys`, padding: " ".repeat(65536) }))); controller.close(); } }), "OIDC_DISCOVERY_INVALID"],
      [new ReadableStream(), "OIDC_DISCOVERY_UNAVAILABLE"],
    ] as const) {
      const verifier = createOidcIdentityVerifier({ issuer, audience, algorithms: ["RS256"], maxTokenLifetimeSeconds: 3600 }, { loadJwt: async () => jose, fetch: async () => new Response(body) });
      const pending = verifier.readiness(); await vi.advanceTimersByTimeAsync(3001);
      expect((await pending).code).toBe(code);
    }
  } finally { vi.useRealTimers(); }
});
it("cache_directives_shorten_lifetimes_and_readiness_needs_keys", async () => {
  const f = await fixture(); const upstream = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async url => { const response = await upstream(url); response.headers.set("cache-control", "max-age=40"); response.headers.set("age", "10"); return response; });
  const report = await f.verifier.readiness(); expect(report.state).toBe("ready");
  expect(report.discovery.expiresAt).toBe(new Date(epoch + 30000).toISOString());
  expect(report.jwks.expiresAt).toBe(new Date(epoch + 30000).toISOString());
  f.advance(30000); f.fail(); expect((await f.verifier.readiness()).state).toBe("unknown");
  expect((await f.verifier.readiness()).jwks.loaded).toBe(false);
});
it("no_store_is_not_reused", async () => {
  const f = await fixture(); const upstream = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async url => { const response = await upstream(url); response.headers.set("cache-control", "no-store"); return response; });
  expect((await f.verifier.verifyToken(await f.token())).ok).toBe(true);
  expect(await f.verifier.verifyToken(await f.token())).toEqual(denied("OIDC_JWKS_REFRESH_RATE_LIMITED"));
});
it("configuration_and_loader_refusals_are_sanitized", async () => {
  const invalid = await fixture({ issuer: "http://issuer.example.com" });
  expect((await invalid.verifier.readiness()).code).toBe("OIDC_CONFIGURATION_INVALID"); expect(invalid.fetch).not.toHaveBeenCalled();
  const f = await fixture(); f.loadJwt.mockRejectedValue(new Error("private details"));
  expect(await f.verifier.verifyToken(await f.token())).toEqual(denied("OIDC_JWT_LIBRARY_UNAVAILABLE"));
  await expect(f.verifier.verifyAccessToken(await f.token())).rejects.toThrow("OIDC identity verification unavailable");
});
it("token_supplied_urls_never_choose_transport_and_bad_jwks_refuse", async () => {
  const f = await fixture();
  const token = await new jose.SignJWT({ iss: issuer, aud: audience, sub: "subject", email: "customer@example.com", email_verified: true, iat: epoch / 1000, exp: epoch / 1000 + 300 })
    .setProtectedHeader({ alg: "RS256", kid: "first", jku: "https://foreign.example.com/keys", x5u: "https://foreign.example.com/cert" }).sign(f.first.privateKey);
  expect((await f.verifier.verifyToken(token)).ok).toBe(true);
  expect(f.fetch.mock.calls.map(call => String(call[0]))).toEqual([`${issuer}/.well-known/openid-configuration`, `${issuer}/keys`]);
  const broken = await fixture(); const upstream = broken.fetch.getMockImplementation()!;
  broken.fetch.mockImplementation(async url => String(url).endsWith("/keys") ? Response.json({ keys: [{ kty: "RSA", kid: "key", alg: "RS256", n: "invalid", e: "invalid", d: "private" }] }) : upstream(url));
  expect((await broken.verifier.readiness()).code).toBe("OIDC_JWKS_INVALID");
  expect((await broken.verifier.readiness()).state).toBe("unsatisfied");
});
