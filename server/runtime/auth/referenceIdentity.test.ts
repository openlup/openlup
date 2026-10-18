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
function response() {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() }; res.status.mockReturnValue(res); return res;
}
function request(body?: unknown): HttpRequest { return { method: "POST", headers: { authorization: "Bearer synthetic" }, body } as HttpRequest; }
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); vi.restoreAllMocks(); policy.allow = false; });
it("direct reconcile reads only the verified actor's existing link and never request email", async () => {
  const asActor = vi.fn(async (_claims, work) => work({}));
  const read = vi.fn(async () => ({ clientId: contactId, email: "customer@example.invalid", firstName: null, lastName: null, lifecycleStage: "lead" as const }));
  const bind: typeof createCustomerIdentityBinding = (req, environment) => createCustomerIdentityBinding(req, environment, {
    createVerifier: () => ({ verifyAccessToken: async () => ({ principalId, email: "other@example.invalid", emailVerified: false }) }),
    createPostgresGateway: () => ({ asActor }), createPostgresPort: () => ({ getCustomerMe: read }),
  });
  const req = request(); Object.defineProperty(req, "body", { get: () => { throw new Error("must not read email"); } });
  const res = response(); await createDirectCustomerReconcileHandler(env, bind)(req, res as unknown as HttpResponse);
  expect(asActor).toHaveBeenCalledWith({ role: "authenticated", sub: principalId }, expect.any(Function));
  expect(read).toHaveBeenCalledWith(principalId);
  expect(res.json).toHaveBeenCalledWith({ ok: true, data: { accountId: contactId, created: false, linked: false } });
});
it.each(["unauthenticated", "unlinked"] as const)("direct reconcile refuses %s without creating or associating a contact", async failure => {
  const read = vi.fn(async () => null), res = response();
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
  const f = directOptions(), invite = response();
  await createInviteHandler(f.options)(request({ email: "new@example.invalid", role: "distributor" }), invite as never);
  expect(invite.status).toHaveBeenCalledWith(200);
  expect(f.ensurePrincipal).toHaveBeenCalledWith(expect.objectContaining({ email: "new@example.invalid" }));
  expect(f.issue).toHaveBeenCalledWith({ actorPrincipalId: principalId, targetPrincipalId: targetId, email: "new@example.invalid", role: "distributor", ttlSeconds: 604800 });
  expect(f.sendRoleGranted).toHaveBeenCalledOnce();
  const remove = response(); await createRemoveHandler(f.options)(request({ userId: targetId }), remove as never);
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
  const res = response(); await mountedReconcile(req, res as never);
  expect(asActor).toHaveBeenCalledWith({ role: "authenticated", sub: principalId }, expect.any(Function));
  expect(read).toHaveBeenCalledWith(principalId);
  if (linked) expect(res.json).toHaveBeenCalledWith({ ok: true, data: { accountId: contactId, created: false, linked: false } });
  else {
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ details: { code: "ACCOUNT_LINK_CONFLICT" } }) }));
  }
  expect(managedEnvironment).not.toHaveBeenCalled(); expect(managedClients).not.toHaveBeenCalled();
});
