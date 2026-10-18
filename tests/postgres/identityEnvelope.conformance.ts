import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  createManagedEmailTrustPolicy, createReconcileAccountHandler, createSupabaseAccountLinkStore,
  createSupabaseIdentityVerifier, type EmailTrustPolicy,
} from "@openlup/platform/identity";
import { createReferenceAccountHandlers } from "../../server/runtime/public-reference/subscriptionAccount.js";
import { bindIdentityEmailTrust } from "../../server/runtime/auth/emailTrustBinding.js";
import { assessIdentityReadiness } from "../../server/runtime/auth/identityReadiness.js";
import { createEnvelopeClients } from "./identityEnvelopeManagedAdapter.ts";
import { identityStatePreservation } from "./identityStatePreservation.conformance.ts";

type Setup = { scenario: string; url: string; anonKey: string; serviceRoleKey: string; mail: string; origin: string;
  externalProvider: string; sql: (source: string) => string };
function response() {
  return { statusCode: 200, body: undefined as unknown, setHeader() {},
    status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; } };
}
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
async function capturedSession(s: Setup, email: string) {
  const res = response();
  await createReferenceAccountHandlers(s, s.origin).requestSignIn({ method: "POST", headers: {}, body: { email } } as never, res as never);
  assert.equal(res.statusCode, 200, "reference sign-in failed");
  for (let attempt = 0; attempt < 30; attempt++) {
    const list = await fetch(`${s.mail}/api/v1/messages`, { signal: AbortSignal.timeout(3000) });
    assert.equal(list.status, 200);
    const messages = await list.json() as { messages: { ID: string; To: { Address: string }[] }[] };
    const item = messages.messages.find(m => m.To.some(to => to.Address.toLowerCase() === email));
    if (item) {
      const detail = await fetch(`${s.mail}/api/v1/message/${encodeURIComponent(item.ID)}`, { signal: AbortSignal.timeout(3000) });
      assert.equal(detail.status, 200);
      const body = await detail.json() as { HTML?: string; Text?: string };
      const links = `${body.HTML ?? ""}\n${body.Text ?? ""}`.replaceAll("&amp;", "&").match(/https?:\/\/[^\s"'<>]+/g) ?? [];
      const link = links.map(value => new URL(value)).find(url => url.origin === s.url && url.pathname === "/auth/v1/verify" && url.searchParams.has("token"));
      assert.ok(link, "no captured verification link");
      const verified = await fetch(link, { redirect: "manual", signal: AbortSignal.timeout(3000) });
      assert.ok([302, 303].includes(verified.status));
      const target = new URL(verified.headers.get("location") ?? "", s.origin);
      assert.equal(target.origin, s.origin); assert.equal(target.pathname, "/account/auth/callback");
      const fragment = new URLSearchParams(target.hash.slice(1));
      const access_token = fragment.get("access_token"), refresh_token = fragment.get("refresh_token");
      assert.ok(access_token && refresh_token, "captured mailbox proof did not establish a session");
      return { access_token, refresh_token };
    }
    await delay(1000);
  }
  throw new Error("captured local mailbox proof unavailable");
}
export async function runIdentityEnvelopeConformance(s: Setup) {
  const clients = createEnvelopeClients(s);
  const verifier = createSupabaseIdentityVerifier(clients.actor);
  const store = createSupabaseAccountLinkStore(clients.service);
  const policy = bindIdentityEmailTrust({ PLATFORM_BUNDLE: "node-supabase" }, s);
  // The owned stack replays the committed chain with psql, so there is no CLI ledger;
  // the public-catalogue fingerprint covers only public relation names and kinds.
  const publicCatalogueFingerprint = () => s.sql("SELECT md5(coalesce(string_agg(c.relname::text || ':' || c.relkind::text, ',' ORDER BY c.relname), '')) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public';");
  const beforePublicCatalogue = publicCatalogueFingerprint();
  const contacts = () => s.sql("SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM public.clients c;");
  function assertAssociated(res: ReturnType<typeof response>, principal: { principalId: string; email: string | null }) {
    const body = res.body as { data: { accountId: string } };
    assert.ok(body.data?.accountId, "successful reconcile omitted account ID");
    const row = JSON.parse(s.sql(`SELECT jsonb_build_object('email', email, 'auth_user_id', auth_user_id) FROM public.clients WHERE id=${quote(body.data.accountId)};`));
    assert.deepEqual(row, { email: principal.email?.trim().toLowerCase(), auth_user_id: principal.principalId }, "successful reconcile did not persist the principal association");
  }
  async function reconcile(token: string, chosen = policy, expected = 200) {
    const before = contacts();
    const res = response();
    const principal = expected === 200 ? await verifier.verifyAccessToken(token) : null;
    if (expected === 200) assert.ok(principal, "successful reconcile has no principal");
    await createReconcileAccountHandler({ verifier, store, emailTrustPolicy: chosen })({ method: "POST", headers: { authorization: `Bearer ${token}` } } as never, res as never);
    assert.equal(res.statusCode, expected, "package reconcile status differs");
    if (principal) assertAssociated(res, principal);
    if (expected !== 200) assert.equal(contacts(), before, "refusal changed contact state");
    if (chosen === policy) {
      const reference = response();
      await createReferenceAccountHandlers(s, s.origin).reconcile({ method: "POST", headers: { authorization: `Bearer ${token}` } } as never, reference as never);
      // The reference keeps its existing refusal mapping and default policy.
      assert.equal(reference.statusCode, expected === 200 ? 200 : 403, "reference policy mapping differs");
      if (principal) assertAssociated(reference, principal);
      if (expected !== 200) assert.equal(contacts(), before, "reference refusal changed contact state");
    }
    return res;
  }
  if (s.scenario === "automatic") {
    const { data, error } = await clients.actor.auth.signUp({ email: "automatic@example.com", password: "Synthetic-local-password-123!" });
    assert.equal(error, null); assert.ok(data.session);
    const principal = await verifier.verifyAccessToken(data.session.access_token);
    assert.equal(principal?.emailVerified, true);
    const res = await reconcile(data.session.access_token, policy, 403);
    assert.match(JSON.stringify(res.body), /EMAIL_TRUST_ENVELOPE_REFUSED/);
    assert.equal((await assessIdentityReadiness(() => policy)).state, "unsatisfied");
  } else {
    const email = s.scenario === "external" ? "external@example.com" : "metadata@example.com";
    const session = await capturedSession(s, email);
    const principal = await verifier.verifyAccessToken(session.access_token);
    assert.ok(principal?.emailVerified);
    let positivePolicy = policy;
    if (s.scenario === "external") {
      const res = await reconcile(session.access_token, policy, 403);
      assert.match(JSON.stringify(res.body), /EMAIL_TRUST_ENVELOPE_REFUSED/);
      const declared = bindIdentityEmailTrust({ PLATFORM_BUNDLE: "node-supabase", IDENTITY_EMAIL_VERIFYING_PROVIDERS: s.externalProvider }, s);
      await reconcile(session.access_token, declared);
      positivePolicy = declared;
    } else {
      assert.equal((await assessIdentityReadiness(() => policy)).state, "ready");
      assert.equal((await clients.actor.auth.setSession(session)).error, null);
      assert.equal((await clients.actor.auth.updateUser({ data: { email_verified: true } })).error, null);
      s.sql(`INSERT INTO public.clients(email) VALUES (${quote(email)}); UPDATE auth.users SET email_confirmed_at = NULL WHERE id=${quote(principal.principalId)};`);
      assert.equal((await verifier.verifyAccessToken(session.access_token))?.emailVerified, false);
      await reconcile(session.access_token, policy, 400);
      // Separate actual mailbox proof supplies the positive association case.
      const positive = await capturedSession(s, "positive@example.com");
      await reconcile(positive.access_token);
      const unlinked = await capturedSession(s, "unavailable@example.com");
      const nativeFetch = globalThis.fetch;
      let failSettings = false, time = 0;
      // Fault only /settings. Token verification and the database stay on the real stack.
      const fault = createServer(async (_req, res) => {
        if (failSettings) { res.writeHead(503); res.end(); return; }
        try {
          const result = await nativeFetch(`${s.url}/auth/v1/settings`, { headers: { apikey: s.anonKey }, signal: AbortSignal.timeout(3000) });
          res.writeHead(result.status); res.end(await result.text());
        } catch { res.writeHead(503); res.end(); }
      });
      await new Promise<void>((done, reject) => { fault.once("error", reject); fault.listen(0, "127.0.0.1", done); });
      try {
        const faultOrigin = `http://127.0.0.1:${(fault.address() as AddressInfo).port}`;
        const observed = createManagedEmailTrustPolicy({ authBaseUrl: s.url, publicKey: s.anonKey, now: () => time,
          fetch: (_url, init) => nativeFetch(`${faultOrigin}/auth/v1/settings`, init) });
        const subscriber = await capturedSession(s, "subscriber@example.com");
        const subscriberPrincipal = await verifier.verifyAccessToken(subscriber.access_token);
        assert.ok(subscriberPrincipal);
        await identityStatePreservation({ sql: s.sql, service: clients.service, principal: subscriberPrincipal, policy: observed,
          exercise: async () => {
            assert.deepEqual(await observed.assess(), { trusted: true });
            failSettings = true; time = 60000;
            const res = await reconcile(unlinked.access_token, observed, 503);
            assert.match(JSON.stringify(res.body), /EMAIL_TRUST_SETTINGS_UNAVAILABLE/);
            assert.equal((await assessIdentityReadiness(() => observed)).state, "unknown");
          } });
      } finally { await new Promise<void>((done, reject) => fault.close(error => error ? reject(error) : done())); }
    }
    const existingEmail = "existing@example.com";
    const existing = await capturedSession(s, existingEmail);
    const accountId = "72000000-0000-4000-8000-000000000001";
    s.sql(`INSERT INTO public.clients(id,email) VALUES (${quote(accountId)},${quote(existingEmail)});`);
    assert.equal(s.sql(`SELECT auth_user_id IS NULL FROM public.clients WHERE id=${quote(accountId)};`), "t", "existing contact must start unlinked");
    const linked = await reconcile(existing.access_token, positivePolicy);
    assert.deepEqual((linked.body as { data: unknown }).data, { accountId, created: false, linked: true });
  }
  assert.equal(publicCatalogueFingerprint(), beforePublicCatalogue, "proof changed the public-catalogue fingerprint");
}
