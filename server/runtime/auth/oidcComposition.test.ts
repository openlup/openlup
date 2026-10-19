import { expect, it, vi } from "vitest";
import * as jose from "jose";
import { createOidcComposition } from "./oidcComposition.js";
import { assessOidcReadiness } from "./identityReadiness.js";
const env = { PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: "postgresql://example.invalid/test", IDENTITY_OIDC_ISSUER: "https://issuer.example.com", IDENTITY_OIDC_CUSTOMER_AUDIENCE: "customer-api", IDENTITY_OIDC_OPERATOR_AUDIENCE: "operator-api" };
it("managed_bundles_require_native_sessions_and_audiences_are_distinct", () => {
  for (const bundle of ["node-supabase", "vercel-supabase"]) expect(() => createOidcComposition({ ...env, PLATFORM_BUNDLE: bundle })).toThrow("OIDC_NATIVE_SESSION_REQUIRED");
  expect(() => createOidcComposition({ ...env, IDENTITY_OIDC_OPERATOR_AUDIENCE: "customer-api" })).toThrow("OIDC_CONFIGURATION_INVALID");
});
it("host_lifetime_binding_is_cold_reuses_cache_and_scopes_customer_reads", async () => {
  const pair = await jose.generateKeyPair("RS256"); const issuer = env.IDENTITY_OIDC_ISSUER;
  const fetch = vi.fn(async url => Response.json(String(url).endsWith("openid-configuration")
    ? { issuer, jwks_uri: `${issuer}/keys` } : { keys: [{ ...await jose.exportJWK(pair.publicKey), kid: "key", alg: "RS256", use: "sig" }] }));
  const maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  const asActor = vi.fn(async (_claims, work) => work({ from: () => ({ select: () => ({ maybeSingle }) }) }));
  const binding = createOidcComposition(env, { fetch, loadJwt: async () => jose, customerGateway: { asActor, asService: vi.fn() } });
  expect(fetch).not.toHaveBeenCalled();
  expect((await assessOidcReadiness(binding.oidcVerifiers)).state).toBe("ready");
  expect((await assessOidcReadiness(binding.oidcVerifiers)).state).toBe("ready");
  expect(fetch).toHaveBeenCalledTimes(4);
  const principal = "11111111-1111-4111-8111-111111111111";
  await binding.customerProfile.getCustomerMe(principal);
  expect(asActor).toHaveBeenCalledWith({ role: "authenticated", sub: principal }, expect.any(Function));
  expect(binding.routes.map(route => route.route)).toEqual(["/api/bff/customers/reconcile-account", "/api/bff/customers/me"]);
  expect(binding.routes[0].pattern.test("/api/bff/customers/reconcile-account")).toBe(true);
  expect(binding.routes[0].availability).toBe("direct-postgres");
  expect(binding.routes[0].params).toEqual([]);
  await binding.close();
});
it("oidc_readiness_refuses_missing_keys_before_admission", async () => {
  const binding = createOidcComposition(env, { fetch: async () => { throw new Error("synthetic unavailable"); } });
  const result = await assessOidcReadiness(binding.oidcVerifiers);
  expect(result.state).toBe("unknown"); expect(result.issues).toHaveLength(4);
  await binding.close();
});
it("issuer_image_ownership_and_loopback_guards_refuse_unsafe_resources", async () => {
  const { assertOidcImage, assertOidcOwned, OIDC_IMAGE } = await import("../../../tests/postgres/runOidcIdentityConformance.mjs");
  const id = `sha256:${"1".repeat(64)}`, runId = "owned-run", project = "owned-project";
  const image = { Id: id, RepoDigests: [`quay.io/keycloak/keycloak${OIDC_IMAGE.slice(OIDC_IMAGE.indexOf("@"))}`] };
  expect(() => assertOidcImage(image)).not.toThrow(); expect(() => assertOidcImage({ ...image, RepoDigests: [] })).toThrow();
  const container = { Image: id, Config: { Labels: { "com.openlup.oidc.run": runId, "com.docker.compose.project": project } },
    NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "55555" }] } }, HostConfig: { PortBindings: {} } };
  expect(() => assertOidcOwned(container, runId, project, id)).not.toThrow();
  expect(() => assertOidcOwned(container, "foreign-run", project, id)).toThrow();
  expect(() => assertOidcOwned(container, runId, project, `sha256:${"2".repeat(64)}`)).toThrow();
  container.NetworkSettings.Ports["8080/tcp"][0].HostIp = "0.0.0.0";
  expect(() => assertOidcOwned(container, runId, project, id)).toThrow();
});
it("rp_session_end_clears_cookie_and_blocks_late_refresh_and_callback_replay", async () => {
  let handle!: (req: unknown, res: unknown) => void;
  vi.doMock("node:http", () => ({ createServer: (handler: typeof handle) => {
    handle = handler; return { once() {}, listen(_port: number, _host: string, done: () => void) { done(); }, address: () => ({ port: 45454 }), close: (done: () => void) => done() };
  } }));
  const pair = await jose.generateKeyPair("RS256");
  vi.doMock("jose", async () => ({ ...await vi.importActual<typeof jose>("jose"), createRemoteJWKSet: () => async () => pair.publicKey }));
  let nonce = "", challenge = "", wrongNonce = false;
  const { createHash } = await import("node:crypto");
  const issuer = "https://issuer.example.com/realm";
  vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
    const body = init.body as URLSearchParams;
    if (body.get("grant_type") === "authorization_code") expect(createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url")).toBe(challenge);
    const idToken = await new jose.SignJWT({ nonce: wrongNonce ? "wrong" : nonce }).setProtectedHeader({ alg: "RS256", kid: "key" }).setIssuer(issuer).setAudience("synthetic-rp").setIssuedAt().setExpirationTime("5m").sign(pair.privateKey);
    return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", id_token: idToken });
  }));
  const { createOidcReferenceRp } = await import("../../../tests/postgres/oidcReferenceRp.js");
  const rp = await createOidcReferenceRp();
  const request = (url: string, method = "GET", headers: Record<string, string> = {}) => new Promise<Response>(done => {
    let status = 200, outputHeaders = {};
    const res = { writeHead(code: number, values = {}) { status = code; outputHeaders = values; return res; }, end(body?: string) { done(new Response(body, { status, headers: outputHeaders })); return res; } };
    handle({ url, method, headers: { host: new URL(rp.origin).host, ...headers } }, res);
  });
  try {
    const authorization = new URL(rp.loginUrl(issuer, "synthetic-rp")); nonce = authorization.searchParams.get("nonce")!; challenge = authorization.searchParams.get("code_challenge")!;
    const callback = `/callback?code=synthetic-code&state=${authorization.searchParams.get("state")}`;
    expect((await request("/callback?code=synthetic-code&state=foreign")).status).toBe(400);
    const login = await request(callback); expect(login.status).toBe(200); const cookie = login.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("SameSite=Lax"); const id = cookie.split(";", 1)[0].split("=")[1];
    expect(rp.tokens(id)?.access_token).toBe("synthetic-access"); expect((await request(callback)).status).toBe(400);
    let release!: () => void, received!: () => void;
    const held = new Promise<void>(done => { release = done; }), arrived = new Promise<void>(done => { received = done; });
    const late = rp.refresh(id, async response => { received(); await held; return response; }); await arrived;
    const logout = await request("/logout", "POST", { origin: rp.origin, cookie });
    expect(logout.status).toBe(200); expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    release(); expect(await late).toBe(null); expect(rp.tokens(id)).toBe(null); expect(await rp.refresh(id)).toBe(null);
    wrongNonce = true;
    const invalid = new URL(rp.loginUrl(issuer, "synthetic-rp")); nonce = invalid.searchParams.get("nonce")!; challenge = invalid.searchParams.get("code_challenge")!;
    expect((await request(`/callback?code=synthetic-code&state=${invalid.searchParams.get("state")}`)).status).toBe(400);
  } finally { await rp.close(); vi.doUnmock("node:http"); vi.doUnmock("jose"); vi.unstubAllGlobals(); }
});
