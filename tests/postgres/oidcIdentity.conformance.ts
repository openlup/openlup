/** Opt-in real issuer + full canonical PostgreSQL catalogue. No locally minted identity tokens. */
import assert from "node:assert/strict";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { chromium } from "@playwright/test";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { createPostgresDataGateway, type PgGatewayClient } from "@openlup/platform/data";
import { createOidcIdentityVerifier, createDirectOperatorInvitationStore, deriveOidcPrincipalId } from "@openlup/platform/identity";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { buildIdentityReferenceRuntime } from "../identity/acceptance.conformance.js";
import { createOidcIssuerFixture } from "./oidcIssuerFixture.js";
import { createOidcReferenceRp } from "./oidcReferenceRp.js";
import type { createOidcComposition } from "../../server/runtime/auth/oidcComposition.js";
import type { withIdentityReferencePolicy } from "../../server/runtime/auth/referenceIdentityPolicy.js";
import type { HttpRequest, HttpResponse } from "@openlup/platform/http";
const A = "11111111-1111-4111-8111-111111111111", C = "22222222-2222-4222-8222-222222222222", S = "33333333-3333-4333-8333-333333333333", M = "44444444-4444-4444-8444-444444444444";
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
async function untilExpired(token: string) {
  const exp = decodeJwt(token).exp; assert(typeof exp === "number");
  const delay = exp * 1000 - Date.now() + 100;
  assert(delay < 15000, "Real issuer test requires its short access-token profile");
  if (delay > 0) await sleep(delay);
}
export async function runOidcIdentityConformance(setup: { issuerOrigin: string; database: string; adminPassword: string; directory: string; runId: string; assertOwned(): unknown; hosted?: boolean }) {
  const pool = new Pool({ connectionString: setup.database });
  let poolFailed = false; pool.on("error", () => { poolFailed = true; });
  let closeIssuer: (() => Promise<void>) | undefined;
  let closeRp: (() => Promise<void>) | undefined;
  let binding: ReturnType<typeof createOidcComposition> | undefined;
  const invitations = createDirectOperatorInvitationStore({ connectionString: setup.database });
  const browser = await chromium.launch({ headless: true });
  let stage = "fresh_install";
  try {
    const rp = await createOidcReferenceRp(); closeRp = rp.close;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) { try { await pool.query("SELECT 1"); ready = true; break; } catch { await sleep(250); } }
    assert(ready, "Owned database startup deadline exceeded"); setup.assertOwned();
    const manifestBytes = readFileSync("config/platform-migration-manifest.json", "utf8");
    const manifest = JSON.parse(manifestBytes);
    const runner = createPostgresMigrationRunner({ connectionString: setup.database }, { root: process.cwd(), poolFactory: async () => pool });
    await runner.apply();
    const ledger = (await pool.query("SELECT * FROM public.platform_schema_migrations ORDER BY position")).rows;
    assert.deepEqual(ledger.map(row => ({ file: row.catalog_path, sha256: row.sha256 })), [manifest.baseline, ...manifest.forward]);
    // State installed before this adapter's first use is retained across reconciliation/refusals/replay.
    await pool.query("INSERT INTO public.platform_human_principals (principal_id,email) VALUES ($1,'administrator@example.com')", [A]);
    await pool.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES ($1,'admin','active','legacy',now())", [A]);
    await pool.query("INSERT INTO public.platform_control_operators(principal_id,active) VALUES ($1,true)", [M]);
    await pool.query("INSERT INTO public.clients(id,email,principal_id) VALUES ($1,'legacy@example.com',$2)", [C, A]);
    await pool.query("INSERT INTO public.subscriptions(id,client_id,status,cadence_days) VALUES ($1,$2,'active',28)", [S, C]);
    const preserved = async () => ({ contacts: (await pool.query("SELECT * FROM public.clients WHERE id = $1", [C])).rows,
      subscriptions: (await pool.query("SELECT * FROM public.subscriptions WHERE id = $1", [S])).rows,
      machine: (await pool.query("SELECT * FROM public.platform_control_operators WHERE principal_id = $1", [M])).rows,
      administrator: (await pool.query("SELECT * FROM public.platform_human_memberships WHERE principal_id = $1", [A])).rows });
    const before = await preserved();
    const issuer = await createOidcIssuerFixture(setup.issuerOrigin, setup.adminPassword, rp.redirectUri, setup.hosted ? `m14-${setup.runId}-` : "");
    closeIssuer = issuer.close;
    const login = async (realm = "reference", client = "customer-rp", username = "customer") => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage(); await page.goto(rp.loginUrl(issuer.issuerFor(realm), client));
        await page.locator('input[name="username"]').fill(username);
        await page.locator('input[name="password"]').fill(issuer.password);
        await page.locator('#kc-login').click(); await page.waitForURL(rp.redirectUri + "?**");
        assert.equal(await page.textContent("body"), "Authenticated", "Real authorization-code login refused");
        const cookie = (await context.cookies(rp.origin)).find(value => value.name === rp.cookieName);
        assert(cookie?.httpOnly && cookie.sameSite === "Lax", "RP session cookie missing or unsafe");
        return { id: cookie.value, context };
      } catch { await context.close(); throw new Error("Real issuer browser login failed; credential-bearing output suppressed"); }
    };
    // Use the existing profile policy alias and observed route wrapper, without changing that profile.
    symlinkSync(resolve("node_modules"), join(setup.directory, "node_modules"), "dir");
    const entry = join(setup.directory, "oidc-runtime.ts");
    writeFileSync(entry, `export { createOidcComposition } from ${JSON.stringify(resolve("server/runtime/auth/oidcComposition.ts"))};\nexport { withIdentityReferencePolicy } from ${JSON.stringify(resolve("server/runtime/auth/referenceIdentityPolicy.ts"))};\n`);
    await buildIdentityReferenceRuntime(entry, join(setup.directory, "runtime"));
    const loaded = await import(pathToFileURL(join(setup.directory, "runtime/runtime.mjs")).href) as { createOidcComposition: typeof createOidcComposition; withIdentityReferencePolicy: typeof withIdentityReferencePolicy };
    const transportCounts = { keys: 0 };
    const customerGateway = createPostgresDataGateway({ connectionString: setup.database }, { poolFactory: () => pool });
    binding = loaded.createOidcComposition({ PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: setup.database,
      IDENTITY_OIDC_ISSUER: issuer.issuer, IDENTITY_OIDC_CUSTOMER_AUDIENCE: "customer-api", IDENTITY_OIDC_OPERATOR_AUDIENCE: "operator-api" }, {
      allowLoopbackHttp: !setup.hosted, customerGateway,
      fetch: async (url, init) => { if (String(url).endsWith("/certs")) transportCounts.keys++; return fetch(url, init); },
    });
    const selected = binding;
    assert.deepEqual(await selected.readiness(), []);
    const invokeReconcile = async (token: string) => {
      let status = 200, body: { ok?: boolean; data?: { accountId: string }; error?: { code: string } } = {};
      const response = { status(value: number) { status = value; return this; }, json(value: typeof body) { body = value; return this; }, setHeader() { return this; }, end() { return this; } };
      const request = { method: "POST", url: "/api/bff/customers/reconcile-account", headers: { host: new URL(rp.origin).host, origin: rp.origin, "content-type": "application/json", authorization: `Bearer ${token}` }, body: {}, query: {} };
      await loaded.withIdentityReferencePolicy({ origin: rp.origin, directory: setup.directory, runId: setup.runId, bundle: "node-postgres", assertOwned: async () => { setup.assertOwned(); } }, async () => {
        await selected.routes[0]!.handler(request as unknown as HttpRequest, response as unknown as HttpResponse);
      });
      return { status, body };
    };
    stage = "real_login_and_customer_reconcile";
    const session = await login();
    let tokens = rp.tokens(session.id)!;
    const verified = await selected.customerVerifier.verifyToken(tokens.access_token); assert(verified.ok, "Real access token refused");
    const principal = verified.principal.principalId;
    const reconcile = await invokeReconcile(tokens.access_token); assert.equal(reconcile.status, 200); assert(reconcile.body.ok);
    assert.equal((await pool.query("SELECT principal_id FROM public.clients WHERE id=$1", [reconcile.body.data!.accountId])).rows[0].principal_id, principal);
    const ownProfile = await selected.customerProfile.getCustomerMe(principal); assert.equal(ownProfile?.clientId, reconcile.body.data!.accountId);
    stage = "customer_actor_cannot_read_other_customer";
    await customerGateway.asActor({ role: "authenticated", sub: principal }, async db => {
      const result = await (db as PgGatewayClient).from("clients").select("id");
      assert(Array.isArray(result.data) && result.data.every((row: { id: string }) => row.id !== C), "Customer actor read another contact");
      assert(!result.error); assert.equal(result.data?.length, 1);
    });
    stage = "expired_access_token_refreshes_to_same_principal";
    await untilExpired(tokens.access_token); assert.deepEqual(await selected.customerVerifier.verifyToken(tokens.access_token), { ok: false, code: "OIDC_TOKEN_EXPIRED" });
    tokens = (await rp.refresh(session.id))!; assert(tokens, "Real refresh refused");
    const refreshed = await selected.customerVerifier.verifyToken(tokens.access_token); assert(refreshed.ok && refreshed.principal.principalId === principal, "Refresh changed principal");
    stage = "new_signing_kid_is_accepted_after_bounded_refresh";
    const oldToken = tokens.access_token;
    const oldKid = decodeProtectedHeader(oldToken).kid;
    const removalProbe = createOidcIdentityVerifier({ issuer: issuer.issuer, audience: "customer-api", algorithms: ["RS256"], maxTokenLifetimeSeconds: 3600, allowLoopbackHttp: !setup.hosted }, { loadJwt: () => import("jose") });
    const removalCacheStarted = performance.now();
    assert((await removalProbe.verifyToken(oldToken)).ok);
    await issuer.rotate();
    const rotated = (await rp.refresh(session.id))!; assert(rotated);
    const newKid = decodeProtectedHeader(rotated.access_token).kid; assert(newKid && newKid !== oldKid, "Issuer did not rotate its signing kid");
    // A miss after the real initial-attempt window uses the production bounded refresh.
    await sleep(31000);
    tokens = (await rp.refresh(session.id))!; assert(tokens);
    assert((await selected.customerVerifier.verifyToken(tokens.access_token)).ok, "Rotated issuer key refused after refresh window");
    const unknown = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "unknown" })).toString("base64url")}.${tokens.access_token.split(".")[1]}.${tokens.access_token.split(".")[2]}`;
    const count = transportCounts.keys;
    for (let attempt = 0; attempt < 3; attempt++) assert.deepEqual(await selected.customerVerifier.verifyToken(unknown), { ok: false, code: "OIDC_JWKS_REFRESH_RATE_LIMITED" });
    assert.equal(transportCounts.keys, count, "Unknown kid bypassed refresh rate limit");
    stage = "removed_key_is_refused_after_cache_expiry";
    await issuer.removePreviousKeys();
    const publishedKeys = await (await fetch(`${issuer.issuer}/protocol/openid-connect/certs`)).json();
    assert(!publishedKeys.keys.some((key: { kid: string }) => key.kid === oldKid), "Issuer retained the removed signing key");
    // Observe the production five-minute upper cache bound with real elapsed time.
    // The old real token will also expire; the exact refusal below distinguishes
    // removal of its signing key from merely rejecting an expired token.
    await sleep(Math.max(0, 301000 - (performance.now() - removalCacheStarted)));
    assert(performance.now() - removalCacheStarted >= 300000);
    assert.equal((await removalProbe.readiness()).state, "ready");
    // This is the original real issuer token. Retaining the removed key yields EXPIRED instead.
    assert.deepEqual(await removalProbe.verifyToken(oldToken), { ok: false, code: "OIDC_JWKS_REFRESH_RATE_LIMITED" });
    tokens = (await rp.refresh(session.id))!; assert(tokens);
    assert((await selected.customerVerifier.verifyToken(tokens.access_token)).ok);
    const snapshots = async () => ({ contacts: (await pool.query("SELECT * FROM public.clients ORDER BY id")).rows,
      principals: (await pool.query("SELECT * FROM public.platform_human_principals ORDER BY principal_id")).rows });
    stage = "foreign_realm_wrong_audience_and_unverified_email_refuse_without_writes";
    const noWrite = await snapshots();
    for (const [realm, client, user, code] of [
      ["foreign", "customer-rp", "customer", "OIDC_ISSUER_MISMATCH"], ["reference", "foreign-rp", "customer", "OIDC_AUDIENCE_MISMATCH"], ["reference", "customer-rp", "unverified", "OIDC_EMAIL_UNVERIFIED"],
    ]) {
      const denied = await login(realm, client, user); const token = rp.tokens(denied.id)!.access_token;
      const result = await selected.customerVerifier.verifyToken(token);
      // A foreign realm has its own signing key; no foreign URL is followed for an unknown kid.
      if (code === "OIDC_ISSUER_MISMATCH") assert(!result.ok, "Foreign realm accepted"); else assert.deepEqual(result, { ok: false, code });
      assert.equal((await invokeReconcile(token)).status, 401); await denied.context.close();
    }
    assert.deepEqual(await snapshots(), noWrite);
    stage = "operator_uses_live_membership_and_acl";
    const operator = await login("reference", "operator-rp"); const operatorTokens = rp.tokens(operator.id)!;
    const operatorPrincipal = deriveOidcPrincipalId(issuer.issuer, String(decodeJwt(operatorTokens.access_token).sub));
    assert.equal((await selected.operatorAuthorization.authorize(operatorTokens.access_token)).ok, false, "Non-member token authorized");
    // The same external subject can be a customer and an operator; membership is never created by login.
    await pool.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES ($1,'customer@example.com')", [operatorPrincipal]);
    assert.equal((await invitations.issue({ actorPrincipalId: A, targetPrincipalId: operatorPrincipal, email: "customer@example.com", role: "distributor", ttlSeconds: 3600 })).code, "INVITATION_CREATED");
    assert.equal((await selected.operatorAuthorization.authorize(operatorTokens.access_token)).ok, false, "Pending membership authorized");
    assert.equal((await invitations.acceptOperatorInvitation(operatorPrincipal)).code, "ACTIVATED");
    assert.equal((await selected.operatorAuthorization.authorize(operatorTokens.access_token)).ok, true);
    assert.equal((await selected.operatorAuthorization.authorize(operatorTokens.access_token, { allowedRoles: ["admin"] })).ok, false);
    assert.equal((await selected.operatorAuthorization.authorize(tokens.access_token)).ok, false, "Customer audience authorized operator");
    await invitations.remove({ actorPrincipalId: A, targetPrincipalId: operatorPrincipal, reason: "Synthetic conformance revocation" });
    assert.equal((await selected.operatorAuthorization.authorize(operatorTokens.access_token)).ok, false, "Revoked membership remained authorized");
    // Hold a real refresh response in flight while the RP ends its local session/cookie.
    stage = "rp_session_end_clears_cookie_and_blocks_late_refresh";
    let release!: () => void, received!: () => void;
    const held = new Promise<void>(done => { release = done; }); const arrived = new Promise<void>(done => { received = done; });
    const late = rp.refresh(session.id, async response => { received(); await held; return response; }); await arrived;
    const logoutResponse = await session.context.request.post(`${rp.origin}/logout`, { headers: { origin: rp.origin } }); assert.equal(logoutResponse.status(), 200);
    assert((await logoutResponse.headers())["set-cookie"].includes("Max-Age=0"));
    assert(!(await session.context.cookies(rp.origin)).some(cookie => cookie.name === rp.cookieName));
    release(); assert.equal(await late, null); assert.equal(rp.tokens(session.id), null); assert.equal(await rp.refresh(session.id), null);
    stage = "issuer_logout_blocks_refresh_and_access_eventually_expires";
    const ended = await login(); const endedTokens = rp.tokens(ended.id)!;
    await issuer.logout(endedTokens.refresh_token, "customer-rp");
    assert.equal(await issuer.refresh(endedTokens.refresh_token, "customer-rp"), null, "Issuer logout allowed refresh");
    // Stateless access tokens remain usable until expiry; logout is not immediate JWT revocation.
    assert((await selected.customerVerifier.verifyToken(endedTokens.access_token)).ok);
    await untilExpired(endedTokens.access_token); assert.deepEqual(await selected.customerVerifier.verifyToken(endedTokens.access_token), { ok: false, code: "OIDC_TOKEN_EXPIRED" });
    for (const context of [session.context, operator.context, ended.context]) await context.close();
    stage = "legacy_links_subscriptions_and_ledger_survive_replay";
    assert.deepEqual(await preserved(), before, "Existing identity/subscription/machine state changed");
    assert.deepEqual((await runner.apply()).applied, []);
    assert.deepEqual((await pool.query("SELECT * FROM public.platform_schema_migrations ORDER BY position")).rows, ledger);
    assert.equal(readFileSync("config/platform-migration-manifest.json", "utf8"), manifestBytes);
    assert(!poolFailed, "Database emitted an error during conformance"); setup.assertOwned();
    return { status: "PASS", issuer: setup.hosted ? "hosted test Keycloak" : "local Keycloak", loginSessionLogout: true,
      realRefreshAndExpiry: true, customerOperatorSeparation: true, membershipDenial: true,
      signingKeyRotation: true, retiredKeyRefusal: "OIDC_JWKS_REFRESH_RATE_LIMITED",
      cacheExpiryClock: "wall", cacheElapsedSeconds: (performance.now() - removalCacheStarted) / 1000,
      hostedQualification: false };
  } catch { throw new Error(`OIDC conformance failed at stage: ${stage}`); }
  finally {
    try { await closeIssuer?.(); }
    finally { await browser.close(); await closeRp?.(); await binding?.close(); await invitations.close(); await pool.end(); }
  }
}
