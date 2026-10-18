import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  createManagedEmailTrustPolicy, createReconcileAccountHandler, createSupabaseAccountLinkStore,
  createSupabaseIdentityVerifier, createSupabaseClientAuthLinkStore, linkClientAuthUser,
} from "@openlup/platform/identity";
import { createReferenceAccountHandlers } from "../../server/runtime/public-reference/subscriptionAccount.js";
import { bindIdentityEmailTrust } from "../../server/runtime/auth/emailTrustBinding.js";
import { assessIdentityReadiness } from "../../server/runtime/auth/identityReadiness.js";
import { createEnvelopeClients, createEnvelopeCustomerMagicLink } from "./identityEnvelopeManagedAdapter.ts";
import { identityStatePreservation } from "./identityStatePreservation.conformance.ts";

type Setup = { phase?: "email-trust" | "joint"; scenario: string; url: string; anonKey: string; serviceRoleKey: string; mail: string; origin: string;
  externalProvider: string; sql: (source: string) => string };
function response() {
  return { statusCode: 200, body: undefined as unknown, setHeader() {},
    status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; } };
}
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
async function capturedSession(s: Setup, email: string, customerSignIn?: ReturnType<typeof createEnvelopeCustomerMagicLink>) {
  const res = response();
  const requestSignIn = customerSignIn ?? createReferenceAccountHandlers(s, s.origin).requestSignIn;
  await requestSignIn({ method: "POST", headers: customerSignIn ? { "x-forwarded-for": "192.0.2.21" } : {},
    body: customerSignIn ? { email, locale: "en" } : { email } } as never, res as never);
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
      return { access_token, refresh_token, verificationLink: link };
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
    const softEmail = "automatic-soft@example.com";
    const account = "00000000-0000-4000-8000-000000000021";
    s.sql(`INSERT INTO public.clients(id,email) VALUES ('${account}',${quote(softEmail)});`);
    const softStore = createSupabaseClientAuthLinkStore(clients.service, policy);
    const refused = await linkClientAuthUser(softStore, softEmail);
    assert.equal(refused.ok, false, "automatic confirmation admitted soft provisioning");
    assert.ok(!refused.ok && refused.code === "EMAIL_TRUST_ENVELOPE_REFUSED");
    assert.equal(s.sql(`SELECT count(*) FROM auth.users WHERE lower(email)=${quote(softEmail)};`), "0", "refused provisioning created an identity");
    const signup = await clients.actor.auth.signUp({ email: softEmail, password: "Synthetic-local-password-123!" });
    assert.equal(signup.error, null);
    // Automatic signup may mint its own session, but cannot acquire a commerce-linked identity.
    assert.equal(s.sql(`SELECT auth_user_id IS NULL FROM public.clients WHERE id='${account}';`), "t", "anonymous signup acquired the soft account");
    assert.deepEqual(await linkClientAuthUser(softStore, softEmail), refused, "existing-email linking bypassed the envelope");
    assert.equal(s.sql(`SELECT auth_user_id IS NULL FROM public.clients WHERE id='${account}';`), "t");
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
  if (s.phase === "joint" && s.scenario === "confirmed") await softAccountFirstLogin(s);
  assert.equal(publicCatalogueFingerprint(), beforePublicCatalogue, "proof changed the public-catalogue fingerprint");
}


/** Real first login must confirm the provisioned user, without minting a replacement. */
async function softAccountFirstLogin(s: Setup) {
  const { service, actor } = createEnvelopeClients(s);
  const store = createSupabaseClientAuthLinkStore(service, bindIdentityEmailTrust({ PLATFORM_BUNDLE: "node-supabase" }, s));
  const email = "soft-account@example.com";
  const account = "00000000-0000-4000-8000-000000000011";
  const subscription = "00000000-0000-4000-8000-000000000012";
  s.sql(`INSERT INTO public.clients(id,email) VALUES ('${account}',${quote(email)});
    INSERT INTO public.subscriptions(id,client_id,cadence_days,currency,region_code,timezone,status)
      VALUES ('${subscription}','${account}',30,'USD','ZZ','UTC','paused');`);
  const linked = await linkClientAuthUser(store, "  SOFT-ACCOUNT@Example.COM ");
  assert.ok(linked.ok, "soft-account link refused");
  assert.equal(linked.created, true);
  assert.equal(linked.clientId, account);
  const id = linked.authUserId;
  assert.equal(s.sql(`SELECT auth_user_id FROM public.clients WHERE id='${account}';`), id,
    "provisioned identity was not linked to the contact");
  const authState = () => JSON.parse(s.sql(`SELECT json_build_object('id',id,'confirmed',email_confirmed_at)
    FROM auth.users WHERE id=${quote(id)};`)) as { id: string; confirmed: string | null };
  const userCount = (address: string) => s.sql(`SELECT count(*) FROM auth.users WHERE lower(email)=${quote(address)};`);
  assert.deepEqual(authState(), { id, confirmed: null }, "soft-account creation confirmed a typed address");
  assert.equal(userCount(email), "1");
  const contactAndSubscription = () => s.sql(`SELECT jsonb_build_object(
    'client',(SELECT to_jsonb(c) FROM public.clients c WHERE id='${account}'),
    'subscription',(SELECT to_jsonb(t) FROM public.subscriptions t WHERE id='${subscription}'));`);
  const before = contactAndSubscription();
  for (let attempt = 0; attempt < 2; attempt++) {
    const replay = await linkClientAuthUser(store, email);
    assert.ok(replay.ok);
    assert.equal(replay.authUserId, id); assert.equal(replay.clientId, account);
    assert.equal(replay.created, false); assert.equal(replay.alreadyLinked, true);
  }
  assert.deepEqual(authState(), { id, confirmed: null }, "provisioning replay confirmed the user");

  const requestSignIn = createEnvelopeCustomerMagicLink(s);
  const session = await capturedSession(s, email, requestSignIn);
  const { data, error } = await actor.auth.getUser(session.access_token);
  assert.equal(error, null);
  assert.equal(data.user?.id, id, "first login replaced the provisioned identity");
  assert.ok(data.user?.email_confirmed_at, "captured mailbox proof did not confirm the user");
  assert.ok(authState().confirmed);
  assert.equal(userCount(email), "1");
  const replay = await linkClientAuthUser(store, email);
  assert.ok(replay.ok);
  assert.equal(replay.authUserId, id); assert.equal(replay.clientId, account);
  assert.equal(replay.created, false); assert.equal(replay.alreadyLinked, true);
  assert.equal(contactAndSubscription(), before, "first login or replay changed commerce state");

  // Consume the captured link again, then malformed material: neither may yield a session.
  const invalidLink = new URL(session.verificationLink);
  invalidLink.searchParams.set("token", "0".repeat(64));
  for (const link of [session.verificationLink, invalidLink]) {
    const rejected = await fetch(link, { redirect: "manual", signal: AbortSignal.timeout(3000) });
    if ([302, 303].includes(rejected.status)) {
      const target = new URL(rejected.headers.get("location") ?? "", s.origin);
      const fragment = new URLSearchParams(target.hash.slice(1));
      assert.ok(fragment.has("error") || target.searchParams.has("error"), "invalid/replayed proof was not refused");
      assert.equal(target.origin, s.origin); assert.equal(target.pathname, "/account/auth/callback");
      for (const parameters of [fragment, target.searchParams]) {
        assert.equal(parameters.has("access_token"), false); assert.equal(parameters.has("refresh_token"), false);
      }
    } else assert.ok([400, 401, 403, 422].includes(rejected.status), "invalid/replayed proof did not receive an Auth refusal");
  }
  const unknown = "unknown-login@example.com";
  assert.equal(userCount(unknown), "0");
  const res = response();
  await requestSignIn({ method: "POST", headers: { "x-forwarded-for": "192.0.2.21" },
    body: { email: unknown, locale: "en" } } as never, res as never);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, data: { accepted: true } });
  const mail = await fetch(`${s.mail}/api/v1/messages`, { signal: AbortSignal.timeout(3000) });
  assert.equal(mail.status, 200);
  const messages = await mail.json() as { messages: { To: { Address: string }[] }[] };
  assert.equal(messages.messages.some(message => message.To.some(to => to.Address.toLowerCase() === unknown)), false,
    "unknown-address login sent mail");
  assert.equal(userCount(unknown), "0", "unknown-address login created an auth user");
  assert.equal(s.sql(`SELECT count(*) FROM public.clients WHERE lower(email)=${quote(unknown)};`), "0");
  assert.equal(contactAndSubscription(), before);
}
