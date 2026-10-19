import { afterEach, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "@openlup/platform/http";
import mountedReconcile from "../../bff/customers/reconcile-account.js";
import * as customerBindings from "../customers/customerIdentityBinding.js";
import * as customerShared from "../../bff/customers/shared.js";
import { createDirectCustomerReconcileHandler } from "../customers/customerReconcileBinding.js";
import { createCustomerIdentityBinding } from "../customers/customerIdentityBinding.js";
import { createDirectOperatorActionsBinding } from "./operatorActionsBinding.js";
import { createInviteHandler } from "../../bff/admin/platform/admin-users/invite.js";
import { createRemoveHandler } from "../../bff/admin/platform/admin-users/remove.js";
import type { DirectOperatorActionOptions } from "./operatorActionsBinding.js";
import { createReferenceBffDispatcher } from "../bffDispatch.js";
const policy = vi.hoisted(() => ({ allow: false }));
vi.mock("#deployment-route-policy", async importOriginal => {
  const original = await importOriginal<typeof import("../../_lib/publicDeploymentPolicies.js")>();
  return { ...original, enforceDeploymentRoutePolicy: (...args: Parameters<typeof original.enforceDeploymentRoutePolicy>) => policy.allow || original.enforceDeploymentRoutePolicy(...args) };
});
const managed = vi.hoisted(() => ({ invite: vi.fn(), remove: vi.fn() }));
vi.mock("../../adapters/supabase/adminUserActionPort.js", () => ({ createSupabaseAdminUserInvitePort: managed.invite, createSupabaseAdminUserRemovePort: managed.remove }));
const principalId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const contactId = "33333333-3333-4333-8333-333333333333";
const env = { PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: "postgresql://unused.invalid/test", APP_BASE_URL: "https://example.invalid" };
function bindingResponse() {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() }; res.status.mockReturnValue(res); return res;
}
function request(body?: unknown): HttpRequest { return { method: "POST", headers: { authorization: "Bearer synthetic" }, body } as HttpRequest; }
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); vi.restoreAllMocks(); policy.allow = false; });
it.each(["node-postgres", "node-supabase"])("dispatches the selected %s preflight once before the supplied admin handler", async bundle => {
  for (const route of ["/api/bff/admin/platform/admin-users/invite", "/api/bff/admin/identity/privacy/export"]) {
    for (const admitted of [false, true]) {
      let settle!: (allowed: boolean) => void;
      const preflight = vi.fn(() => new Promise<boolean>(resolve => { settle = resolve; }));
      const handler = vi.fn(), req = request(), res = response();
      req.url = route;
      const dispatch = createReferenceBffDispatcher(() => ({ PLATFORM_BUNDLE: bundle }), preflight);
      const pending = dispatch([{ route, pattern: new RegExp(`^${route}$`), params: [], handler }], req, res as unknown as HttpResponse);
      expect(preflight).toHaveBeenCalledExactlyOnceWith(req, res, route);
      expect(handler).not.toHaveBeenCalled();
      settle(admitted);
      await pending;
      if (admitted) expect(handler).toHaveBeenCalledExactlyOnceWith(req, res);
      else expect(handler).not.toHaveBeenCalled();
    }
  }
});
it("direct reconcile reads only the verified actor's existing link and never request email", async () => {
  const asActor = vi.fn(async (_claims, work) => work({}));
  const read = vi.fn(async () => ({ clientId: contactId, email: "customer@example.invalid", firstName: null, lastName: null, lifecycleStage: "lead" as const }));
  const bind: typeof createCustomerIdentityBinding = (req, environment) => createCustomerIdentityBinding(req, environment, {
    createVerifier: () => ({ verifyAccessToken: async () => ({ principalId, email: "other@example.invalid", emailVerified: false }) }),
    createPostgresGateway: () => ({ asActor }), createPostgresPort: () => ({ getCustomerMe: read }),
  });
  const req = request(); Object.defineProperty(req, "body", { get: () => { throw new Error("must not read email"); } });
  const res = bindingResponse(); await createDirectCustomerReconcileHandler(env, bind)(req, res as unknown as HttpResponse);
  expect(asActor).toHaveBeenCalledWith({ role: "authenticated", sub: principalId }, expect.any(Function));
  expect(read).toHaveBeenCalledWith(principalId);
  expect(res.json).toHaveBeenCalledWith({ ok: true, data: { accountId: contactId, created: false, linked: false } });
});
it.each(["unauthenticated", "unlinked"] as const)("direct reconcile refuses %s without creating or associating a contact", async failure => {
  const read = vi.fn(async () => null), res = bindingResponse();
  const bind: typeof createCustomerIdentityBinding = () => ({ authenticateUser: async () => failure === "unauthenticated"
    ? { ok: false, code: "UNAUTHORIZED", message: "Session required" } : { ok: true, userId: principalId }, mePort: { getCustomerMe: read } });
  await createDirectCustomerReconcileHandler(env, bind)(request({ email: "other@example.invalid" }), res as unknown as HttpResponse);
  expect(res.status).toHaveBeenCalledWith(failure === "unauthenticated" ? 401 : 409);
  if (failure === "unauthenticated") expect(read).not.toHaveBeenCalled();
  else expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ details: { code: "ACCOUNT_LINK_CONFLICT" } }) }));
});
function directOptions() {
  const close = vi.fn(async () => {}), authorize = vi.fn(async () => ({ ok: true as const, principalId, role: "admin" as const, isMachineActor: false }));
  const issue = vi.fn(async () => ({ code: "INVITATION_CREATED" as const, principalId: targetId, role: "distributor" as const, membershipState: "invited" as const,
    invitationId: "44444444-4444-4444-8444-444444444444", invitedAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-08T00:00:00Z" }));
  const remove = vi.fn(async () => ({ revoked: true as const }));
  const read = vi.fn(async () => ({ principalId, role: "admin" as const, membershipState: "active" as const }));
  const ensurePrincipal = vi.fn(async () => ({ principalId: targetId, created: false }));
  const sendRoleGranted = vi.fn(async () => ({ ok: true, providerMessageId: "synthetic", providerError: null, skipped: false, skipReason: null }));
  const options: DirectOperatorActionOptions = { createAuth: () => ({ authorize, close }), createDirectory: () => ({ ensurePrincipal, close }),
    createStore: () => ({ issue, read, remove, acceptOperatorInvitation: vi.fn(), close }), notification: { sendRoleGranted } };
  return { options, close, authorize, issue, remove, read, ensurePrincipal, sendRoleGranted };
}
it.each(["invite", "remove"] as const)("public %s policy precedes input and binding construction", async operation => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const f = directOptions(), factory = vi.spyOn(f.options, "createAuth"), res = response(), req = request();
  Object.defineProperty(req, "body", { get: () => { throw new Error("must stay unread"); } });
  await (operation === "invite" ? createInviteHandler(f.options) : createRemoveHandler(f.options))(req, res as never);
  expect(res.status).toHaveBeenCalledWith(503); expect(factory).not.toHaveBeenCalled();
  expect(managed.invite).not.toHaveBeenCalled(); expect(managed.remove).not.toHaveBeenCalled();
});
it("direct routes compose the direct directory, invitation store and removal under policy", async () => {
  policy.allow = true; for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const f = directOptions(), invite = bindingResponse();
  await createInviteHandler(f.options)(request({ email: "new@example.invalid", role: "distributor" }), invite as never);
  expect(invite.status).toHaveBeenCalledWith(200);
  expect(f.ensurePrincipal).toHaveBeenCalledWith(expect.objectContaining({ email: "new@example.invalid" }));
  expect(f.issue).toHaveBeenCalledWith({ actorPrincipalId: principalId, targetPrincipalId: targetId, email: "new@example.invalid", role: "distributor", ttlSeconds: 604800 });
  expect(f.sendRoleGranted).toHaveBeenCalledOnce();
  const remove = bindingResponse(); await createRemoveHandler(f.options)(request({ userId: targetId }), remove as never);
  expect(remove.status).toHaveBeenCalledWith(200);
  expect(f.remove).toHaveBeenCalledWith({ actorPrincipalId: principalId, targetPrincipalId: targetId });
  expect(f.close).toHaveBeenCalledTimes(6);
  expect(managed.invite).not.toHaveBeenCalled(); expect(managed.remove).not.toHaveBeenCalled();
});
it("notification failure preserves the pending invitation and closes direct bindings", async () => {
  const f = directOptions(); f.sendRoleGranted.mockRejectedValue(new Error("synthetic"));
  const binding = createDirectOperatorActionsBinding(env, "synthetic", f.options);
  try { await expect(binding.invitePort.inviteAdminUser({ email: "new@example.invalid", role: "distributor" })).rejects.toMatchObject({ bffCode: "UPSTREAM_UNAVAILABLE", inviteDetails: { identityCode: "INVITATION_NOTIFICATION_FAILED" } }); }
  finally { await binding.close(); }
  expect(f.issue).toHaveBeenCalledOnce(); expect(f.remove).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledTimes(3);
});

it.each([true, false])("mounted direct reconcile reads the actor link (linked=%s) without managed composition", async linked => {
  policy.allow = true;
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubEnv("COMMERCE_V2_W12_CUSTOMER_AUTH_UI", "true");
  const asActor = vi.fn(async (_claims, work) => work({}));
  const read = vi.fn(async () => linked ? { clientId: contactId, email: "customer@example.invalid", firstName: null, lastName: null, lifecycleStage: "lead" as const } : null);
  const managedEnvironment = vi.spyOn(customerShared, "readCustomerSelfServiceEnv").mockImplementation(() => { throw new Error("managed environment must not be constructed"); });
  const managedClients = vi.spyOn(customerShared, "createCustomerClients").mockImplementation(() => { throw new Error("email association must not be constructed"); });
  const actual = customerBindings.createCustomerIdentityBinding;
  vi.spyOn(customerBindings, "createCustomerIdentityBinding").mockImplementation((req, environment) => actual(req, environment, {
    createVerifier: () => ({ verifyAccessToken: async () => ({ principalId, email: "other@example.invalid", emailVerified: false }) }),
    createPostgresGateway: () => ({ asActor }), createPostgresPort: () => ({ getCustomerMe: read }),
    createManagedClient: () => { throw new Error("managed binding forbidden"); },
  }));
  const req = request(); Object.defineProperty(req, "body", { get: () => { throw new Error("email must stay unread"); } });
  const res = bindingResponse(); await mountedReconcile(req, res as never);
  expect(asActor).toHaveBeenCalledWith({ role: "authenticated", sub: principalId }, expect.any(Function));
  expect(read).toHaveBeenCalledWith(principalId);
  if (linked) expect(res.json).toHaveBeenCalledWith({ ok: true, data: { accountId: contactId, created: false, linked: false } });
  else {
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ details: { code: "ACCOUNT_LINK_CONFLICT" } }) }));
  }
  expect(managedEnvironment).not.toHaveBeenCalled(); expect(managedClients).not.toHaveBeenCalled();
});

import { env as processEnvironment } from "node:process";
import { chmodSync, mkdtempSync, realpathSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { buildIdentityReferenceRuntime, createIdentityAcceptanceDatabase, identityReferenceJwks, writeIdentityReferenceEntry } from "../../../tests/identity/acceptance.conformance.js";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import type { Pool } from "pg";
import { acceptanceBundle, assertContainerOwnership, assertPortBindings, managedAcceptanceEmailFrequencyMs, managedEmailWaitMs, renderManagedAcceptanceConfig } from "../../../tests/identity/runAcceptance.mjs";
import { build, type Plugin } from "vite";
import { enforceDeploymentRoutePolicy, validateIdentityReferenceProfile, withIdentityReferencePolicy, IDENTITY_ROUTES } from "./referenceIdentityPolicy.js";
import { enforceDeploymentRoutePolicy as publicPolicy } from "../../_lib/publicDeploymentPolicies.js";
import { createReferenceIdentity } from "./referenceIdentity.js";
import { createVerifierResultOnlyEmailTrustPolicy } from "@openlup/platform/identity";
import { startPublicReferenceServer } from "../public-reference/serve.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
const listener = vi.hoisted(() => vi.fn(() => { throw new Error("Listener constructed before admission"); }));
vi.mock("node:http", async original => ({ ...await original<object>(), createServer: listener }));
const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const origin = "http://127.0.0.1:58421", runId = "11111111-1111-4111-8111-111111111111";
function setup(bundle: "node-postgres" | "node-supabase" = "node-postgres") {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "identity-profile-"))); directories.push(directory);
  const env = { OPENLUP_REFERENCE_PROFILE: "identity", OPENLUP_REFERENCE_DISPOSABLE: "1", PLATFORM_BUNDLE: bundle, OPENLUP_IDENTITY_RUN_DIR: directory, OPENLUP_IDENTITY_RUN_ID: runId, APP_BASE_URL: origin };
  const marker = { version: 1, runId, origin, bundle: env.PLATFORM_BUNDLE, containerId: "a".repeat(64) };
  writeFileSync(join(directory, "identity-owner.json"), JSON.stringify(marker), { mode: 0o600 });
  const observe = vi.fn(async () => {});
  return { env, marker, observe, profile: validateIdentityReferenceProfile(env, observe) };
}
const route = { route: "/api/bff/customers/magic-link", domain: "auth", surface: "customer" as const, risk: "mutation" as const };
function response() { const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() }; res.status.mockReturnValue(res); return res as unknown as VercelResponse; }
const req = { method: "POST", headers: { host: "127.0.0.1:58421", origin, "content-type": "application/json" } } as VercelRequest;
it("public_policy_precedes_body_auth_and_binding", async () => {
  const request = { ...req, get body() { throw new Error("body must not be read"); } };
  const res = response(), bind = vi.fn();
  if (enforceDeploymentRoutePolicy(route, request, res)) bind();
  expect(bind).not.toHaveBeenCalled(); expect(res.status).toHaveBeenCalledWith(503);
  expect(publicPolicy(route, request, response())).toBe(false);
  const { profile } = setup();
  await withIdentityReferencePolicy(profile, async () => { expect(enforceDeploymentRoutePolicy(route, request, response())).toBe(true); });
  expect(enforceDeploymentRoutePolicy(route, request, response())).toBe(false);
});
it("local_policy_requires_owned_installation", async () => {
  const { env, marker, observe, profile } = setup();
  for (const change of [{ OPENLUP_REFERENCE_DISPOSABLE: "0" }, { NODE_ENV: "production" }, { APP_BASE_URL: "https://example.com" }, { OPENLUP_IDENTITY_RUN_ID: "22222222-2222-4222-8222-222222222222" }]) expect(() => validateIdentityReferenceProfile({ ...env, ...change }, observe)).toThrow();
  const enter = vi.fn(async () => {});
  observe.mockRejectedValueOnce(new Error("live installation mismatch"));
  await expect(withIdentityReferencePolicy(profile, enter)).rejects.toThrow("live installation mismatch");
  expect(enter).not.toHaveBeenCalled();
  writeFileSync(join(profile.directory, "identity-owner.json"), JSON.stringify({ ...marker, containerId: "invalid" }));
  await expect(profile.assertOwned()).rejects.toThrow("installation mismatch");
  chmodSync(profile.directory, 0o755);
  await expect(profile.assertOwned()).rejects.toThrow("private and canonical");
});
it("local policy admits only identity routes and same-origin JSON within its request scope", async () => {
  const { profile } = setup();
  await withIdentityReferencePolicy(profile, async () => {
    for (const [path, method] of IDENTITY_ROUTES) expect(enforceDeploymentRoutePolicy({ ...route, route: path }, { ...req, method }, response())).toBe(true);
    for (const request of [{ ...req, method: "DELETE" }, { ...req, headers: { ...req.headers, origin: "http://localhost:58421" } }, { ...req, headers: { ...req.headers, "content-type": "text/plain" } }]) expect(enforceDeploymentRoutePolicy(route, request, response())).toBe(false);
    expect(enforceDeploymentRoutePolicy({ ...route, route: "/api/bff/commerce/checkouts" }, req, response())).toBe(false);
    // The public default in the same process remains closed, even during a local scope.
    expect(publicPolicy(route, req, response())).toBe(false);
  });
});
it("identity listener refuses missing composition and unsuccessful admission", async () => {
  const { env, profile } = setup();
  listener.mockClear();
  await expect(startPublicReferenceServer({ env })).rejects.toThrow("composition required");
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const candidate = { artifact: "synthetic", configuration: "synthetic", environment: "test", database: runId, schema: "complete" };
  const identity = { profile, candidate, currentIdentity: () => candidate,
    runtime: createReferenceIdentity({ bundle: "node-postgres", env: { ...processEnvironment, ...env }, migrationIdentity: "complete", createRoutes: () => [],
      ports: { customerSession: { verifyAccessToken: async () => null }, customerProfile: { getCustomerMe: async () => null }, operatorAuthorization: { authorize: vi.fn() }, operatorActions: { inviteAdminUser: vi.fn(), removeAdminUser: vi.fn() }, delivery: { deliver: vi.fn() }, privacy: { export: vi.fn(), erase: vi.fn() }, emailTrustPolicy: createVerifierResultOnlyEmailTrustPolicy() } }),
    schemaProbe: { observe: async () => { throw new Error("schema unavailable"); } } };
  await expect(startPublicReferenceServer({ env: { ...processEnvironment }, identity })).rejects.toThrow("identity candidate refused");
  await expect(startPublicReferenceServer({ env, host: "0.0.0.0", identity })).rejects.toThrow("must be loopback");
  await expect(startPublicReferenceServer({ env, port: 58422, identity })).rejects.toThrow("match its owned origin");
  expect(listener).not.toHaveBeenCalled();
});
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});
it.each([
  ["", "postgres"], ["subscription", "postgres"], ["unrecognized", "postgres"],
  ["identity", "postgres"], ["identity", "supabase"],
])("builds a separate closed profile only by explicit selection (profile=%s, provider=%s)", async (profile, provider) => {
  vi.resetModules(); vi.stubEnv("OPENLUP_REFERENCE_PROFILE", profile); vi.stubEnv("OPENLUP_BUILD_TARGET", "public-reference");
  vi.stubEnv("VITE_COMMERCE_AUTH_PROVIDER_KIND", provider);
  vi.mocked(readFileSync).mockClear();
  const { publicReferenceViteConfig } = await import("../../../vite.public-reference.config.ts");
  const config = publicReferenceViteConfig();
  const configurationInputs = vi.mocked(readFileSync).mock.calls.map(([file]) => relative(process.cwd(), resolve(String(file))));
  const identity = profile === "identity", subscription = profile === "subscription";
  const entry = `src/public-reference/${identity ? "identity-main" : subscription ? "subscription-main" : "main"}.tsx`;
  const document = (config.plugins as Plugin[]).find(plugin => plugin.name === "public-reference-document")!.transformIndexHtml as { handler: () => string };
  expect(document.handler()).toContain(`src="/${entry}"`);
  expect(document.handler().includes('data-openlup-profile="identity"')).toBe(identity);
  const modules = new Set<string>();
  const collect: Plugin = {
    name: "identity-test-modules",
    async buildStart() {
      if (!identity) {
        const policy = await this.resolve("#deployment-route-policy", resolve(entry));
        expect(policy?.id).toBe(resolve("server/_lib/publicDeploymentPolicies.ts"));
      }
    },
    load(id) { modules.add(id); }, moduleParsed(info) { modules.add(info.id); },
  };
  await build({ ...config, configFile: false, logLevel: "silent", plugins: [...(config.plugins ?? []), collect], build: { ...config.build, write: false } });
  const inputs = new Set(["index.html", ...configurationInputs, ...[...modules].map(id => id.replace(/\?.*$/, "")).filter(isAbsolute).map(id => relative(process.cwd(), id))]);
  expect(inputs.has(entry)).toBe(true);
  expect([...modules].some(id => id.endsWith("/identity-main.tsx"))).toBe(identity);
  expect([...modules].some(id => id.endsWith("/subscription-main.tsx"))).toBe(subscription);
  if (!identity) {
    const identityFiles = ["src/public-reference/identity-main.tsx", "src/public-reference/IdentityAccount.tsx", "src/public-reference/IdentityAdmin.tsx", "config/public-reference-identity-imports.json", "server/runtime/auth/referenceIdentityPolicy.ts"];
    expect([...inputs].filter(file => identityFiles.includes(file))).toEqual([]);
    expect(configurationInputs).toEqual(subscription ? ["config/public-reference-subscription-imports.json"] : []);
    if (subscription) {
      const inventory = JSON.parse(readFileSync("config/public-reference-subscription-imports.json", "utf8")).files as string[];
      expect(inventory.length).toBeGreaterThan(0);
      expect([...inventory, "index.html"].filter(file => identityFiles.includes(file))).toEqual([]);
    } else expect([...modules].some(id => id.includes("/src/pages/"))).toBe(false);
  } else {
    expect(configurationInputs).toEqual(["config/public-reference-identity-imports.json"]);
    expect(document.handler()).toContain(`data-identity-auth="${provider === "postgres" ? "direct" : "managed"}"`);
    for (const page of ["/src/pages/account/LoginPage.tsx", "/src/pages/admin/LoginPage.tsx", "/src/pages/admin/IdentityPrivacyPanel.tsx"]) expect([...modules].some(id => id.endsWith(page))).toBe(true);
    const guard = (config.plugins as Plugin[]).find(plugin => plugin.name === "public-reference-import-closure")!;
    expect(() => (guard.load as (id: string) => void)(resolve("src/public-reference/SubscriptionAccount.tsx"))).toThrow("closed inventory");
  }
}, 60000);

it("reference landing pages require the linked profile and live recognized operator role", async () => {
  const { profile } = setup();
  const entry = join(profile.directory, "landing.ts"), output = join(profile.directory, "build");
  symlinkSync(resolve("node_modules"), join(profile.directory, "node_modules"), "dir");
  writeFileSync(entry, [
    ["IdentityAdmin", "src/public-reference/IdentityAdmin.tsx"], ["IdentityAccount", "src/public-reference/IdentityAccount.tsx"],
    ["AuthContext", "src/lib/authContext.ts"], ["CustomerAuthContext", "src/lib/customerAuthContext.ts"],
  ].map(([name, file]) => `export { ${name} } from ${JSON.stringify(resolve(file))};`).join("\n"));
  await buildIdentityReferenceRuntime(entry, output);
  const { IdentityAdmin, IdentityAccount, AuthContext, CustomerAuthContext } = await import(pathToFileURL(join(output, "runtime.mjs")).href);
  const noop = async () => {};
  for (const role of [null, "unknown", "distributor", "admin"]) {
    const value = { loading: false, session: { access_token: "synthetic-session", user: { id: runId } }, isAdmin: true, role, signOut: noop } as never;
    const html = renderToString(createElement(MemoryRouter, null, createElement(AuthContext.Provider, { value }, createElement(IdentityAdmin))));
    expect(html.includes("Identity administration")).toBe(role === "admin" || role === "distributor");
    expect(html.includes('aria-label="Identity privacy"')).toBe(role === "admin");
  }
  const value = { loading: false, session: { accessToken: "synthetic-session" }, profile: null, signOut: noop } as never;
  const html = renderToString(createElement(CustomerAuthContext.Provider, { value }, createElement(IdentityAccount)));
  expect(html).toContain("Linked customer profile unavailable");
  expect(html).not.toContain("Your identity account");
});
it("acceptance refuses missing selectors and cleanup identity mismatches", () => {
  for (const args of [[], ["--bundle", "unknown"], ["--bundle", "node-postgres", "--skip"]]) expect(() => acceptanceBundle(args)).toThrow("Usage:");
  expect(acceptanceBundle(["--bundle", "node-postgres"])).toBe("node-postgres");
  const containerId = "a".repeat(64), expected = { containerId, label: "com.openlup.identity.run", value: runId };
  const container = { Id: containerId, Config: { Labels: { [expected.label]: runId } } };
  expect(() => assertContainerOwnership(container, expected)).not.toThrow();
  expect(() => assertContainerOwnership({ ...container, Id: "b".repeat(64) }, expected)).toThrow("ownership mismatch");
  expect(() => assertContainerOwnership({ ...container, Config: { Labels: { [expected.label]: "another-run" } } }, expected)).toThrow("ownership mismatch");
});
it("acceptance permits unpublished ports and explicit IPv4/IPv6 loopback bindings", () => {
  const Ports = { "80/tcp": null, "443/tcp": [{ HostIp: "127.0.0.1", HostPort: "58421" }, { HostIp: "::1", HostPort: "58421" }] };
  expect(() => assertPortBindings({ NetworkSettings: { Ports }, HostConfig: { PortBindings: Ports } })).not.toThrow();
  expect(() => assertPortBindings({ NetworkSettings: { Ports: {} }, HostConfig: { PortBindings: null } })).not.toThrow();
});
it.each(["0.0.0.0", "::", "", "192.0.2.1", undefined])("acceptance refuses every wildcard or non-loopback publication (%s) in either inspect view", HostIp => {
  for (const view of ["NetworkSettings", "HostConfig"]) {
    const container = { NetworkSettings: { Ports: {} }, HostConfig: { PortBindings: {} } };
    const ports = view === "NetworkSettings" ? container.NetworkSettings.Ports : container.HostConfig.PortBindings;
    Object.assign(ports, { "5432/tcp": [{ HostIp: "127.0.0.1" }], "8025/tcp": [{ HostIp: "::1" }, { HostIp }] });
    expect(() => assertPortBindings(container)).toThrow("loopback only");
  }
});
it("acceptance refuses missing port inspection data", () => {
  expect(() => assertPortBindings({ NetworkSettings: { Ports: {} } })).toThrow("bindings unavailable");
  expect(() => assertPortBindings({ HostConfig: { PortBindings: {} } })).toThrow("bindings unavailable");
});
const sent = Date.parse("2026-01-01T00:00:00.000Z");
const mail = (Created: string, address = "customer@example.com") => ({ Created, To: [{ Address: address }] });
it.each([
  { label: "first message", messages: [], frequency: 1000, elapsed: 0, wait: 0 },
  { label: "unrelated address", messages: [mail(new Date(sent).toISOString(), "other@example.com")], frequency: 1000, elapsed: 0, wait: 0 },
  { label: "remaining default window", messages: [mail(new Date(sent).toISOString())], frequency: 1000, elapsed: 400, wait: 700 },
  { label: "configured window", messages: [mail(new Date(sent).toISOString())], frequency: 3000, elapsed: 400, wait: 2700 },
  { label: "margin at window boundary", messages: [mail(new Date(sent).toISOString())], frequency: 1000, elapsed: 1000, wait: 100 },
  { label: "elapsed window", messages: [mail(new Date(sent).toISOString())], frequency: 1000, elapsed: 1200, wait: 0 },
  { label: "latest matching message regardless of order", messages: [mail(new Date(sent + 500).toISOString(), " CUSTOMER@example.com "), mail(new Date(sent).toISOString())], frequency: 1000, elapsed: 600, wait: 1000 },
  { label: "string recipient", messages: [{ Created: new Date(sent).toISOString(), To: ["customer@example.com"] }], frequency: 1000, elapsed: 0, wait: 1100 },
])("computes managed email wait: $label", ({ messages, frequency, elapsed, wait }) => {
  expect(managedEmailWaitMs(messages, "customer@example.com", frequency, sent + elapsed)).toBe(wait);
});
it("refuses matching captured mail without a valid send timestamp", () => {
  expect(() => managedEmailWaitMs([mail("invalid")], "customer@example.com", 1000, sent)).toThrow("send timestamp");
});
it("reads the rendered email frequency or the explicit local default", () => {
  expect(managedAcceptanceEmailFrequencyMs("[auth.email]\nenable_signup = true\n")).toBe(1000);
  expect(managedAcceptanceEmailFrequencyMs("[auth.email]\nmax_frequency = \"2.5s\"\n[auth.email.smtp]\n")).toBe(2500);
  expect(managedAcceptanceEmailFrequencyMs("[auth.email]\nmax_frequency = '1m2s' # local window\n")).toBe(62000);
  expect(() => managedAcceptanceEmailFrequencyMs("[auth.email]\nmax_frequency = \"invalid\"\n")).toThrow("email frequency");
});
it("managed acceptance renders an email budget without changing other configured settings", () => {
  const template = readFileSync("config/public-reference-subscription-supabase.toml", "utf8");
  const replacements = { PROJECT_ID: "synthetic-identity", SHADOW_PORT: 58420, API_PORT: 58421, DB_PORT: 58422, STUDIO_PORT: 58423, MAIL_PORT: 58424, POOLER_PORT: 58429, APP_PORT: 58430 };
  const expected = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: keyof typeof replacements) => String(replacements[key]))
    .replace('/account/auth/callback"]', '/account/auth/callback", "http://127.0.0.1:58430/admin/auth/callback"]');
  const rendered = renderManagedAcceptanceConfig(template, replacements);
  expect(rendered).toBe(`${expected}\n[auth.rate_limit]\nemail_sent = 20\n`);
  expect(renderManagedAcceptanceConfig(rendered, replacements)).toBe(rendered);
});
it.each(["", "email_sent = 2 # hourly budget\n", "email_sent = 20\n"])("managed acceptance overrides or inserts one email limit (%s)", setting => {
  const template = `[auth.rate_limit]\n${setting}sms_sent = 30\n[studio]\nenabled = false\n`;
  const rendered = renderManagedAcceptanceConfig(template, { APP_PORT: 58430 });
  expect(rendered).toBe(`[auth.rate_limit]\n${setting ? setting.replace(/= [0-9]+/, "= 20") : "email_sent = 20\n"}sms_sent = 30\n[studio]\nenabled = false\n`);
});
it.each([
  "[auth.rate_limit]\nemail_sent = 2\n[auth.rate_limit]\nemail_sent = 3\n",
  "[auth.rate_limit]\nemail_sent = 2\nemail_sent = 3\n",
  "[auth.rate_limit]\nemail_sent = \"2\"\n",
  "[auth.rate_limit]\n\"email_sent\" = 2\n",
  '[auth."rate_limit"]\nemail_sent = 2\n',
  "[auth]\nrate_limit.email_sent = 2\n",
])("managed acceptance refuses ambiguous email rate settings (%s)", template => {
  expect(() => renderManagedAcceptanceConfig(template, { APP_PORT: 58430 })).toThrow("Ambiguous managed acceptance email rate limit");
});
it("managed acceptance permits wildcard bindings only inside its allocated port block", () => {
  const Ports = { "80/tcp": null, "443/tcp": [
    { HostIp: "0.0.0.0", HostPort: "58420" }, { HostIp: "::", HostPort: "58430" },
    { HostIp: "", HostPort: "58424" },
  ] };
  expect(() => assertPortBindings({ NetworkSettings: { Ports }, HostConfig: { PortBindings: Ports } }, 58420)).not.toThrow();
});
it.each(["58419", "58431", "0", "", "not-a-port", "58424suffix", undefined])("managed acceptance refuses an unallocated or invalid published port (%s) in either inspect view", HostPort => {
  for (const view of ["NetworkSettings", "HostConfig"]) {
    const container = { NetworkSettings: { Ports: {} }, HostConfig: { PortBindings: {} } };
    const ports = view === "NetworkSettings" ? container.NetworkSettings.Ports : container.HostConfig.PortBindings;
    Object.assign(ports, { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "58422" }], "8025/tcp": [{ HostIp: "127.0.0.1", HostPort }] });
    expect(() => assertPortBindings(container, 58420)).toThrow("allocated port block");
  }
});
it("managed acceptance refuses missing or malformed port inspection data", () => {
  for (const container of [
    { NetworkSettings: { Ports: {} } }, { HostConfig: { PortBindings: {} } },
    { NetworkSettings: { Ports: { "80/tcp": {} } }, HostConfig: { PortBindings: {} } },
  ]) expect(() => assertPortBindings(container, 58420)).toThrow("bindings unavailable");
});
it("browser acceptance requests the operator challenge through its login form and observes the form after logout", async () => {
  const { profile } = setup();
  const { mkdirSync } = await import("node:fs");
  const mailbox = join(profile.directory, "mailbox"); mkdirSync(mailbox);
  const input = { bundle: "node-postgres", customerEmail: "customer@example.com", adminEmail: "administrator@example.com", contactId };
  writeFileSync(join(profile.directory, "browser-input.json"), JSON.stringify(input));
  vi.stubEnv("OPENLUP_IDENTITY_RUN_DIR", profile.directory); vi.stubEnv("OPENLUP_IDENTITY_RUN_ID", runId);
  let path = "", customer = false, operator = false, email = "", exported = false, loginObservations = 0;
  const formRequests = vi.fn(() => {
    expect(path).toBe("/admin/login"); expect(email).toBe(input.adminEmail);
    writeFileSync(join(mailbox, "operator.json"), JSON.stringify({ kind: "operator", challenge: { email }, callback: `${profile.origin}/admin/auth/callback#synthetic` }));
  });
  const loginField = () => ({
    fill: async (value: string) => { expect(path).toBe("/admin/login"); email = value; },
    visible: () => { loginObservations++; return path === "/admin/login" && !operator; },
  });
  // Replay the real spec with deterministic browser/mailbox doubles. This checks the
  // acceptance driver's interactions; installed browser/runtime proof stays opt-in.
  const page = {
    async goto(target: string) {
      path = new URL(target, profile.origin).pathname;
      if (path === "/admin/auth/callback") { operator = true; path = "/admin"; }
      if (path === "/admin" && !operator) path = "/admin/login";
      if (path === "/account" && !customer) path = "/sign-in";
    },
    async reload() {},
    getByLabel: () => ({ fill: async () => {} }),
    getByTestId: () => ({ textContent: async () => contactId }),
    locator(selector: string) {
      if (selector === 'form input[name="email"]') return loginField();
      expect(selector).toBe("#customer-otp-code");
      return { fill: async () => {}, press: async () => { customer = true; path = "/account"; } };
    },
    getByRole(role: string, options: { name: string | RegExp }) {
      return {
        visible: () => role === "heading" && options.name === "Your identity account" ? customer && path === "/account"
          : role === "heading" && options.name === "Export coverage and retained obligations" ? exported
          : operator && path === "/admin",
        async click() {
          if (options.name instanceof RegExp) {
            expect(role).toBe("button"); expect(options.name.test("link")).toBe(true); formRequests();
          }
          else if (options.name === "Request sign-in") writeFileSync(join(mailbox, "customer.json"), JSON.stringify({ kind: "customer", challenge: { email: input.customerEmail, token: "synthetic" } }));
          else if (options.name === "Export identity data") exported = true;
          else {
            expect(options.name).toBe("Sign out");
            if (path === "/admin") { operator = false; path = "/admin/login"; }
            else { customer = false; path = "/sign-in"; }
          }
        },
      };
    },
  };
  const driverExpect = Object.assign((value: unknown) => {
    if (value === page) return { toHaveURL: (url: string) => expect(`${profile.origin}${path}`).toBe(url) };
    if (value && typeof value === "object" && "visible" in value) return { toBeVisible: () => expect((value as { visible: () => boolean }).visible()).toBe(true) };
    return expect(value);
  }, { poll: expect.poll });
  const register = Object.assign(vi.fn<(name: string, journey: (fixtures: unknown) => Promise<void>) => void>(), { use: vi.fn() });
  const post = vi.fn(() => { throw new Error("Browser acceptance bypassed the login form"); });
  vi.doMock("@playwright/test", () => ({ test: register, expect: driverExpect }));
  try {
    await import("../../../tests/preview/account/identity-composition.spec.js");
    expect(register).toHaveBeenCalledOnce();
    await register.mock.calls[0][1]({ page, request: { post }, baseURL: profile.origin });
    expect(formRequests).toHaveBeenCalledOnce(); expect(post).not.toHaveBeenCalled();
    expect(loginObservations).toBe(2);
  } finally { vi.doUnmock("@playwright/test"); }
});
function acceptanceDatabase() {
  const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [{ id: contactId, email: "customer@example.invalid", first_name: null, last_name: null, lifecycle_stage: "lead" }] }));
  const release = vi.fn();
  const pool = Object.assign(new EventEmitter(), { connect: vi.fn(async () => ({ query, release })), end: vi.fn(async () => {}) });
  return { pool, query, release, owned: createIdentityAcceptanceDatabase(pool as unknown as Pool) };
}
it("acceptance customer reads use its owned pool and drain the server before ending it", async () => {
  const { pool, query, release, owned } = acceptanceDatabase();
  const binding = createCustomerIdentityBinding(request(), env, {
    createVerifier: () => ({ verifyAccessToken: async () => ({ principalId, email: null, emailVerified: false }) }),
    createPostgresGateway: () => owned.customerGateway,
  });
  expect(await binding!.authenticateUser(request())).toEqual({ ok: true, userId: principalId });
  expect(await binding!.mePort.getCustomerMe(principalId)).toMatchObject({ clientId: contactId });
  expect(pool.connect).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
  expect(query).toHaveBeenCalledWith("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: principalId, role: "authenticated" })]);
  expect(query).toHaveBeenCalledWith("SET LOCAL ROLE authenticated");
  let drained!: (error?: Error) => void;
  const server = { close: vi.fn(callback => { drained = callback; }) };
  const closing = owned.close(server as unknown as Server);
  expect(server.close).toHaveBeenCalledOnce(); expect(pool.end).not.toHaveBeenCalled();
  pool.emit("error", new Error("late disconnect"));
  drained(); await closing;
  expect(pool.end).toHaveBeenCalledOnce();
  expect(() => pool.emit("error", new Error("after pool end"))).not.toThrow();
});
it("acceptance idle pool errors during assertions fail the run after cleanup", async () => {
  const { pool, owned } = acceptanceDatabase();
  pool.emit("error", new Error("synthetic connection failure"));
  await expect(owned.close()).rejects.toThrow("database or request failed during assertions");
  expect(pool.end).toHaveBeenCalledOnce();
});
it("acceptance request database failures propagate and release the client before pool cleanup", async () => {
  const { pool, query, release, owned } = acceptanceDatabase();
  query.mockRejectedValueOnce(new Error("synthetic query failure"));
  await expect(owned.customerGateway.asActor({ sub: principalId }, async () => {})).rejects.toThrow("synthetic query failure");
  expect(release).toHaveBeenCalledOnce();
  await owned.close(); expect(pool.end).toHaveBeenCalledOnce();
});
it.each([false, true])("acceptance ends its pool even without a running server (close failure=%s)", async failed => {
  const { pool, owned } = acceptanceDatabase();
  const closing = owned.close(failed ? { close: (callback: (error?: Error) => void) => callback(new Error("synthetic server close failure")) } as unknown as Server : undefined);
  if (failed) await expect(closing).rejects.toThrow("synthetic server close failure");
  else await closing;
  expect(pool.end).toHaveBeenCalledOnce();
});
it("acceptance pool cleanup failures fail the run", async () => {
  const { pool, owned } = acceptanceDatabase();
  pool.end.mockRejectedValueOnce(new Error("synthetic pool end failure"));
  await expect(owned.close()).rejects.toThrow("synthetic pool end failure");
});
it.each([false, true])("acceptance waits for route cleanup after HTTP drain (request failure=%s)", async failed => {
  const { pool, owned } = acceptanceDatabase();
  let finish!: () => void;
  const request = owned.runRequest(() => new Promise<void>((done, reject) => {
    finish = () => failed ? reject(new Error("synthetic route cleanup failure")) : done();
  }));
  const result = failed ? expect(request).rejects.toThrow("synthetic route cleanup failure") : request;
  const server = { close: vi.fn(callback => callback()) };
  const closing = owned.close(server as unknown as Server);
  await Promise.resolve();
  expect(server.close).toHaveBeenCalledOnce(); expect(pool.end).not.toHaveBeenCalled();
  finish(); await result;
  if (failed) await expect(closing).rejects.toThrow("database or request failed during assertions");
  else await closing;
  expect(pool.end).toHaveBeenCalledOnce();
});
it("profile-local alias admits observed identity handlers without changing the public policy module", async () => {
  const { profile } = setup();
  const entry = join(profile.directory, "entry.ts"), output = join(profile.directory, "build");
  symlinkSync(resolve("node_modules"), join(profile.directory, "node_modules"), "dir");
  writeFileSync(entry, `export { withObservedRoute } from ${JSON.stringify(resolve("server/_lib/observability/route.ts"))};\nexport { withIdentityReferencePolicy, validateIdentityReferenceProfile } from ${JSON.stringify(resolve("server/runtime/auth/referenceIdentityPolicy.ts"))};`);
  await buildIdentityReferenceRuntime(entry, output);
  const loaded = await import(pathToFileURL(join(output, "runtime.mjs")).href);
  const called = vi.fn(async () => {}), handler = loaded.withObservedRoute(route, called);
  const logger = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    await handler(req, response()); expect(called).not.toHaveBeenCalled();
    await loaded.withIdentityReferencePolicy(profile, () => handler(req, response())); expect(called).toHaveBeenCalledOnce();
    expect(publicPolicy(route, req, response())).toBe(false);
  } finally { logger.mockRestore(); }
  const composedEntry = join(profile.directory, "composed-entry.ts");
  writeIdentityReferenceEntry(composedEntry);
  await buildIdentityReferenceRuntime(composedEntry, join(profile.directory, "composition"));
  const composition = await import(pathToFileURL(join(profile.directory, "composition/runtime.mjs")).href);
  for (const name of ["createReferenceIdentity", "startPublicReferenceServer", "createCustomerMagicLinkRoute", "createCustomerVerifyOtpRoute", "operatorRoutes", "privacyRoutes", "createInviteHandler", "createRemoveHandler"]) expect(typeof composition[name], name).toBe("function");
  const closed = response();
  await composition.createCustomerMagicLinkRoute(() => { throw new Error("binding must stay unread"); })(req, closed);
  expect(closed.status).toHaveBeenCalledWith(503);
});

it("bundled operator challenge routes admit the profile signing key and scope policy before session construction", async () => {
  const { profile } = setup();
  const entry = join(profile.directory, "operator-entry.ts"), output = join(profile.directory, "build");
  symlinkSync(resolve("node_modules"), join(profile.directory, "node_modules"), "dir");
  writeIdentityReferenceEntry(entry);
  writeFileSync(entry, readFileSync(entry, "utf8") + `\nexport { withIdentityReferencePolicy } from ${JSON.stringify(resolve("server/runtime/auth/referenceIdentityPolicy.ts"))};`);
  await buildIdentityReferenceRuntime(entry, output);
  const loaded = await import(pathToFileURL(join(output, "runtime.mjs")).href);
  const { generateKeyPairSync } = await import("node:crypto");
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const realBinding = loaded.createOperatorSessionBinding({ PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: "postgresql://unused.invalid/test", APP_BASE_URL: origin,
    CUSTOMER_IDENTITY_ISSUER: origin, CUSTOMER_IDENTITY_AUDIENCE: "identity-reference-customer", OPERATOR_IDENTITY_AUDIENCE: "identity-reference-operator",
    CUSTOMER_IDENTITY_KEY_ID: "reference-key", CUSTOMER_IDENTITY_PRIVATE_JWK: JSON.stringify({ ...pair.privateKey.export({ format: "jwk" }), kid: "reference-key", alg: "ES256" }),
    CUSTOMER_IDENTITY_JWKS: identityReferenceJwks(pair.publicKey, "reference-key"),
  });
  await realBinding.close();
  const requestChallenge = vi.fn(async (_req: HttpRequest, res: HttpResponse) => { res.status(200).json({ ok: true, data: { accepted: true } }); });
  const verifyChallenge = vi.fn(async (_req: HttpRequest, res: HttpResponse) => { res.status(401).json({ ok: false }); });
  const close = vi.fn(async () => {});
  const binding = vi.fn(() => ({ requestChallenge, verifyChallenge, close }));
  const routes = loaded.operatorRoutes({ PLATFORM_BUNDLE: "node-postgres" }, binding);
  for (const operation of ["magic-link", "verify-otp"]) {
    const handler = routes.find((entry: { route: string }) => entry.route === `/api/bff/admin/platform/${operation}`).handler;
    const blocked = response();
    await handler(req, blocked);
    expect(blocked.status).toHaveBeenCalledWith(503);
    expect(binding).not.toHaveBeenCalled();
    const accepted = response();
    await loaded.withIdentityReferencePolicy(profile, () => handler(req, accepted));
    expect(accepted.status).toHaveBeenCalledWith(operation === "magic-link" ? 200 : 401);
    expect(close).toHaveBeenCalledOnce();
    binding.mockClear(); close.mockClear();
  }
  expect(requestChallenge).toHaveBeenCalledOnce(); expect(verifyChallenge).toHaveBeenCalledOnce();
});

it.each(["node-postgres", "node-supabase"] as const)("disposable profile admits %s and dispatches its typed table, refusing installation drift before listening", async bundle => {
  const { env, profile } = setup(bundle);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const root = join(profile.directory, "host");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config/site-routes.json"), readFileSync("config/public-reference-site-routes.json"));
  symlinkSync(resolve("node_modules"), join(profile.directory, "node_modules"), "dir");
  const entry = join(profile.directory, "runtime-entry.ts");
  writeIdentityReferenceEntry(entry);
  const observed = await buildIdentityReferenceRuntime(entry, join(profile.directory, "runtime"));
  expect(observed.inventoryComplete).toBe(true);
  expect(observed.loadedPackages.map(pkg => pkg.name).sort()).toEqual(["@openlup/core", "@openlup/platform"]);
  const loaded = await import(pathToFileURL(join(profile.directory, "runtime/runtime.mjs")).href);
  const called = vi.fn(async () => {});
  const ports = {
    customerSession: { verifyAccessToken: vi.fn() }, customerProfile: { getCustomerMe: vi.fn() },
    operatorAuthorization: { authorize: vi.fn(async () => ({ ok: true, principalId, role: "admin", isMachineActor: false })) },
    operatorActions: { inviteAdminUser: vi.fn(), removeAdminUser: vi.fn() }, delivery: { deliver: vi.fn() },
    privacy: { export: called, erase: vi.fn() }, emailTrustPolicy: createVerifierResultOnlyEmailTrustPolicy(),
  };
  const runtime = loaded.createReferenceIdentity({ bundle, env: { ...processEnvironment }, migrationIdentity: "complete", ports,
    createRoutes: (selected: typeof ports) => [{ route: "/api/bff/admin/identity/privacy/export", pattern: /^\/api\/bff\/admin\/identity\/privacy\/export$/, params: [],
      handler: async (_req: HttpRequest, res: HttpResponse) => { await selected.privacy.export(); res.status(200).json({ ok: true }); } }],
  });
  const candidate = { artifact: "synthetic", configuration: "synthetic", environment: "test", database: runId, schema: "complete" };
  let missing = false;
  const identity = { profile, runtime, candidate, currentIdentity: () => candidate,
    observed,
    schemaProbe: { observe: async (requirement: typeof runtime.requiredSchema) => ({ database: runId, version: "complete", objects: requirement.objects.map((object: object) => ({ object, present: !missing })) }) },
  };
  const { Server } = await import("node:http");
  const listen = vi.spyOn(Server.prototype, "listen").mockImplementation(function(this: import("node:http").Server, ...args: unknown[]) {
    (args.at(-1) as () => void)(); return this;
  } as typeof Server.prototype.listen);
  const options = { root, env: { ...processEnvironment }, identity, port: 58421 };
  missing = true;
  await expect(loaded.startPublicReferenceServer(options)).rejects.toThrow("candidate refused before listener");
  missing = false;
  await expect(loaded.startPublicReferenceServer({ ...options, identity: { ...identity, observed: { ...observed, loadedPackages: [...observed.loadedPackages,
    { name: "@openlup/outbox", version: "0.0.0", kind: "rail" },
  ] } } })).rejects.toThrow("candidate refused before listener");
  await expect(loaded.startPublicReferenceServer({ ...options, identity: { ...identity, profile: { ...profile, bundle: bundle === "node-postgres" ? "node-supabase" : "node-postgres" } } })).rejects.toThrow("composition does not match");
  await expect(loaded.startPublicReferenceServer({ ...options, env: { ...options.env, DATABASE_URL: "postgresql://other.invalid/test" } })).rejects.toThrow("environment does not match");
  expect(listen).not.toHaveBeenCalled();
  const actualHttp = await vi.importActual<typeof import("node:http")>("node:http");
  listener.mockImplementationOnce(actualHttp.createServer as typeof listener);
  const server = await loaded.startPublicReferenceServer(options);
  try {
    expect(listen).toHaveBeenCalledOnce();
    const { Readable } = await import("node:stream");
    const request = Object.assign(Readable.from(["{}"]), { url: "/api/bff/admin/identity/privacy/export", method: "POST", headers: req.headers });
    await new Promise<void>((done, reject) => {
      const response = { statusCode: 0, headersSent: false, setHeader: vi.fn(), getHeader: vi.fn(), hasHeader: vi.fn(() => true), end: done, destroy: reject };
      server.emit("request", request, response);
      setTimeout(() => reject(new Error("Identity dispatch did not complete")), 2000).unref();
    });
    expect(called).toHaveBeenCalledOnce();
    expect(ports.operatorAuthorization.authorize).toHaveBeenCalled();
  } finally { server.close(); }
});
