import { authReconcileErrorCodeSchema } from "../../../src/domains/auth/contracts.js";
import { afterEach, expect, it, vi } from "vitest";
import { bindIdentityEmailTrust } from "./emailTrustBinding.js";
import { assessIdentityReadiness } from "./identityReadiness.js";

const route = vi.hoisted(() => ({
  store: { isReservedPrincipal: vi.fn(), findAccountByPrincipalId: vi.fn(), findAccountByEmail: vi.fn(),
    createAccount: vi.fn(), linkPrincipalToAccount: vi.fn() },
}));
vi.mock("@openlup/platform/identity", async importOriginal => ({
  ...await importOriginal<typeof import("@openlup/platform/identity")>(),
  createSupabaseAccountLinkStore: () => route.store,
}));
vi.mock("../../_lib/config/featureFlags.js", () => ({ customerAuthUiEnabled: () => true }));
vi.mock("../../_lib/observability/route.js", () => ({ withObservedRoute: (_options: unknown, handler: unknown) => handler }));
vi.mock("../../bff/customers/shared.js", () => ({
  readCustomerRouteEnv: () => ({ PLATFORM_BUNDLE: "node-postgres" }),
  readCustomerSelfServiceEnv: () => ({ url: "https://managed-route.invalid", anonKey: "public-test-key" }),
  readBearerToken: () => "synthetic-token",
  createCustomerClients: () => ({ serviceClient: {}, customerClient: { auth: { getUser: async () => ({
    data: { user: { id: "81000000-0000-4000-8000-000000000001", email: "route@example.com", email_confirmed_at: "2026-01-01" } }, error: null,
  }) } } }),
}));

afterEach(() => vi.unstubAllGlobals());
it("direct_bundle_does_not_load_managed_adapter or fetch settings", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const policy = bindIdentityEmailTrust({ PLATFORM_BUNDLE: "node-postgres", IDENTITY_EMAIL_VERIFYING_PROVIDERS: "*" });
  expect(await policy.assess()).toEqual({ trusted: true }); expect(fetch).not.toHaveBeenCalled();
});
it("managed bindings normalize declarations, reuse cache and replace changed configuration", async () => {
  const fetch = vi.fn().mockImplementation(async () => Response.json({ mailer_autoconfirm: false, external: { email: true, opaque: true } })); vi.stubGlobal("fetch", fetch);
  const managed = { url: "https://binding.invalid", anonKey: "public-test-key" };
  const policy = bindIdentityEmailTrust({ IDENTITY_EMAIL_VERIFYING_PROVIDERS: " Opaque " }, managed);
  expect(bindIdentityEmailTrust({ IDENTITY_EMAIL_VERIFYING_PROVIDERS: "opaque" }, managed)).toBe(policy);
  expect(await policy.assess()).toEqual({ trusted: true });
  expect(await bindIdentityEmailTrust({}, managed).assess()).toEqual({ trusted: false, code: "EMAIL_TRUST_ENVELOPE_REFUSED" });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(() => bindIdentityEmailTrust({ IDENTITY_EMAIL_VERIFYING_PROVIDERS: "*" }, managed)).toThrow();
});
it("managed reconcile route reads settings even when the bundle environment selects node-postgres", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ mailer_autoconfirm: true, external: { email: true } }));
  vi.stubGlobal("fetch", fetch);
  route.store.isReservedPrincipal.mockResolvedValue(false);
  route.store.findAccountByPrincipalId.mockResolvedValue(null);
  route.store.findAccountByEmail.mockResolvedValue(null);
  route.store.createAccount.mockResolvedValue({ id: "81000000-0000-4000-8000-000000000002" });
  const { default: handler } = await import("../../bff/customers/reconcile-account.js");
  const res = { statusCode: 200, setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  await handler({ method: "POST", headers: { authorization: "Bearer synthetic-token" } } as never, res as never);
  expect(fetch).toHaveBeenCalledWith(new URL("https://managed-route.invalid/auth/v1/settings"), expect.anything());
  expect(res.status).toHaveBeenCalledWith(403);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ details: { code: "EMAIL_TRUST_ENVELOPE_REFUSED" } }) }));
  expect(route.store.findAccountByEmail).not.toHaveBeenCalled();
  expect(route.store.createAccount).not.toHaveBeenCalled();
  expect(route.store.linkPrincipalToAccount).not.toHaveBeenCalled();
});
it("readiness distinguishes unsafe, unknown and invalid host configuration", async () => {
  expect((await assessIdentityReadiness(() => ({ assess: async () => ({ trusted: false, code: "EMAIL_TRUST_ENVELOPE_REFUSED" }) }))).state).toBe("unsatisfied");
  expect((await assessIdentityReadiness(() => ({ assess: async () => { throw new Error("offline"); } }))).state).toBe("unknown");
  expect(await assessIdentityReadiness(() => bindIdentityEmailTrust({}))).toMatchObject({ state: "unsatisfied", issues: [{ code: "OPENLUP_E_ENV_MISSING", module: "identity" }] });
});

it.each(["EMAIL_TRUST_ENVELOPE_REFUSED", "EMAIL_TRUST_SETTINGS_UNAVAILABLE"])("browser reconcile schema admits %s", code => {
  expect(authReconcileErrorCodeSchema.parse(code)).toBe(code);
});

it("observes persisted creation and existing-contact linking in the declared-provider scenario", async () => {
  vi.resetModules();
  type Contact = { id: string; email: string; auth_user_id: string | null };
  const fixture = {
    email: "", rows: new Map<string, Contact>(), observations: [] as Contact[], referenceCalls: 0,
  };
  const createdId = "73000000-0000-4000-8000-000000000001";
  const existingId = "72000000-0000-4000-8000-000000000001";
  function principal(email: string) {
    return { principalId: email === "existing@example.com"
      ? "73000000-0000-4000-8000-000000000002" : "73000000-0000-4000-8000-000000000003", email, emailVerified: true };
  }
  vi.doMock("../../../tests/postgres/identityEnvelopeManagedAdapter.ts", () => ({ createEnvelopeClients: () => ({ actor: {}, service: {} }) }));
  vi.doMock("@openlup/platform/identity", async () => ({
    ...await vi.importActual<typeof import("@openlup/platform/identity")>("@openlup/platform/identity"),
    createSupabaseIdentityVerifier: () => ({ verifyAccessToken: async (token: string) => principal(token) }),
    createSupabaseAccountLinkStore: () => ({
      isReservedPrincipal: async () => false,
      findAccountByPrincipalId: async (id: string) => {
        const row = [...fixture.rows.values()].find(row => row.auth_user_id === id);
        return row ? { id: row.id, email: row.email, principalId: row.auth_user_id } : null;
      },
      findAccountByEmail: async (email: string) => {
        const row = [...fixture.rows.values()].find(row => row.email === email);
        return row ? { id: row.id, email, principalId: row.auth_user_id } : null;
      },
      createAccount: async (input: { email: string; principalId: string }) => {
        fixture.rows.set(createdId, { id: createdId, email: input.email, auth_user_id: input.principalId });
        return { id: createdId };
      },
      linkPrincipalToAccount: async (id: string, principalId: string) => {
        fixture.rows.get(id)!.auth_user_id = principalId;
        return { ok: true, alreadyLinked: false };
      },
    }),
  }));
  vi.doMock("../public-reference/subscriptionAccount.js", () => ({
    createReferenceAccountHandlers: () => ({
      requestSignIn: async (req: { body: { email: string } }, res: { status: (code: number) => void }) => {
        fixture.email = req.body.email; res.status(200);
      },
      reconcile: async (_req: unknown, res: { status: (code: number) => void }) => {
        fixture.referenceCalls++; res.status(403);
      },
    }),
  }));
  try {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      if (url.pathname === "/auth/v1/settings") return Response.json({ mailer_autoconfirm: false, external: { email: true, opaque: true } });
      if (url.pathname === "/api/v1/messages") return Response.json({ messages: [{ ID: "message", To: [{ Address: fixture.email }] }] });
      if (url.pathname === "/api/v1/message/message") return Response.json({ Text: "https://envelope.invalid/auth/v1/verify?token=synthetic" });
      if (url.pathname === "/auth/v1/verify") return new Response(null, { status: 302, headers: {
        location: `https://reference.invalid/account/auth/callback#access_token=${encodeURIComponent(fixture.email)}&refresh_token=synthetic`,
      } });
      throw new Error(`Unexpected request: ${url.pathname}`);
    }));
    const sql = (source: string) => {
      if (source.includes("pg_catalog.pg_class")) return "unchanged-catalogue";
      if (source.includes("jsonb_agg")) return JSON.stringify([...fixture.rows.values()]);
      if (source.startsWith("INSERT INTO public.clients(id,email)")) {
        fixture.rows.set(existingId, { id: existingId, email: "existing@example.com", auth_user_id: null }); return "";
      }
      if (source.startsWith("SELECT auth_user_id IS NULL")) return fixture.rows.get(existingId)?.auth_user_id === null ? "t" : "f";
      if (source.startsWith("SELECT jsonb_build_object('email'")) {
        const id = source.match(/WHERE id='([^']+)'/)?.[1];
        const row = fixture.rows.get(id ?? "");
        if (!row) return "null";
        fixture.observations.push({ ...row });
        return JSON.stringify({ email: row.email, auth_user_id: row.auth_user_id });
      }
      throw new Error("Unexpected conformance SQL");
    };
    const { runIdentityEnvelopeConformance } = await import("../../../tests/postgres/identityEnvelope.conformance.ts");
    await runIdentityEnvelopeConformance({ scenario: "external", url: "https://envelope.invalid", anonKey: "public-test-key",
      serviceRoleKey: "synthetic-service-key", mail: "https://mail.invalid", origin: "https://reference.invalid", externalProvider: "opaque", sql });
    expect(fixture.observations).toEqual([
      { id: createdId, email: "external@example.com", auth_user_id: principal("external@example.com").principalId },
      { id: existingId, email: "existing@example.com", auth_user_id: principal("existing@example.com").principalId },
    ]);
    expect(fixture.referenceCalls).toBe(1);
  } finally {
    vi.doUnmock("@openlup/platform/identity");
    vi.doUnmock("../../../tests/postgres/identityEnvelopeManagedAdapter.ts");
    vi.doUnmock("../public-reference/subscriptionAccount.js");
    vi.resetModules();
  }
});
