import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createPostgresPrivacyStore, createPostgresPrivacyUnitOfWork, createVerifierResultOnlyEmailTrustPolicy,
  readRequiredPrivacyContributorIds, PrivacyRefusal } from "@openlup/platform/identity";
import type { HttpRequest, HttpResponse } from "@openlup/platform/http";
import { composeNativePrivacy, nativePrivacyContributors } from "../../server/runtime/auth/privacyBinding.js";
import { createReferenceIdentity } from "../../server/runtime/auth/referenceIdentity.js";
import { createReferenceBffDispatcher } from "../../server/runtime/bffDispatch.js";
import { postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { createAccountMutationsTemplate, type AccountMutationsStore } from "./customerAccountMutations.fixture.js";

const expectedRefusal = "PRIVACY_RECEIPT_COVERAGE_INCOMPLETE";
const policy = vi.hoisted(() => ({ allow: false }));
vi.mock("#deployment-route-policy", async importOriginal => {
  const original = await importOriginal<typeof import("../../server/_lib/publicDeploymentPolicies.js")>();
  return { ...original, enforceDeploymentRoutePolicy: (...args: Parameters<typeof original.enforceDeploymentRoutePolicy>) =>
    policy.allow || original.enforceDeploymentRoutePolicy(...args) };
});
afterEach(() => { policy.allow = false; });

async function withReplayFixture(work: (fixture: Awaited<ReturnType<typeof replayFixture>>) => Promise<void>) {
  const template = await createAccountMutationsTemplate("separate", "privacy-replay-fence");
  try { await work(await replayFixture(await template.clone())); }
  finally { await template.close(); }
}

async function replayFixture(db: AccountMutationsStore) {
  const actor = { principalId: randomUUID() };
  const store = createPostgresPrivacyStore();
  const contributors = nativePrivacyContributors(store);
  const required = await readRequiredPrivacyContributorIds(db.runtime);
  const missing = "customer-saved-addresses";
  expect(required).toContain(missing);
  expect(contributors.map(owner => owner.id).sort()).toEqual(required);

  await db.owner.query("INSERT INTO public.platform_human_principals(principal_id,email) VALUES ($1,'operator@example.invalid')", [actor.principalId]);
  await db.owner.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',now())", [actor.principalId]);
  async function receipt(covered: boolean) {
    const subject = { kind: "contact" as const, contactId: randomUUID() };
    const idempotencyKey = randomUUID(), erasureId = randomUUID();
    const versions = Object.fromEntries(contributors.filter(owner => covered || owner.id !== missing).map(owner => [owner.id, owner.version]));
    await db.owner.query("INSERT INTO public.clients(id,email) VALUES ($1,$2)", [subject.contactId, `${subject.contactId}@example.invalid`]);
    await db.owner.query(`INSERT INTO public.identity_privacy_erasures
      (erasure_id,idempotency_key,client_id,actor_principal_id,contract_version,contributor_versions,dispositions,retained_obligations,completed_at)
      VALUES ($1,$2,$3,$4,'identity.erasure.v1',$5,'[]','[]',now())`, [erasureId, idempotencyKey, subject.contactId, actor.principalId, versions]);
    return { erasureId, input: { subject, idempotencyKey } };
  }
  const uncovered = await receipt(false), covered = await receipt(true);
  const snapshot = async () => (await db.owner.query(`SELECT ARRAY(SELECT to_jsonb(c) FROM public.clients c ORDER BY id) AS clients,
    ARRAY(SELECT to_jsonb(e) FROM public.identity_privacy_erasures e ORDER BY erasure_id) AS receipts`)).rows;
  const unitOfWork = createPostgresPrivacyUnitOfWork({ connectionString: "postgresql://unused.invalid/fixture" }, { poolFactory: () => db.runtime });
  const privacyTransaction = vi.spyOn(unitOfWork, "run");
  const { operations } = composeNativePrivacy({ store, unitOfWork });
  const env = { PLATFORM_BUNDLE: "node-postgres" };
  const runtime = createReferenceIdentity({
    bundle: "node-postgres", migrationIdentity: db.inventory, env,
    ports: {
      privacy: operations, emailTrustPolicy: createVerifierResultOnlyEmailTrustPolicy(),
      customerSession: { verifyAccessToken: vi.fn() }, customerProfile: { getCustomerMe: vi.fn() },
      operatorAuthorization: { authorize: async () => ({ ...actor, ok: true, role: "admin", isMachineActor: false }) },
      operatorActions: { inviteAdminUser: vi.fn(), removeAdminUser: vi.fn() }, delivery: { deliver: vi.fn() },
    },
    createRoutes: () => (["export", "erase"] as const).map(operation => {
      const route = `/api/bff/admin/identity/privacy/${operation}`;
      return { route, pattern: new RegExp(`^${route}$`), params: [], availability: "direct-postgres", handler: vi.fn() };
    }),
  });
  const dispatch = createReferenceBffDispatcher(() => env, runtime.preflight);
  async function post(operation: "export" | "erase", body: unknown) {
    const req = { method: "POST", url: `/api/bff/admin/identity/privacy/${operation}`, body, headers: { authorization: "Bearer synthetic" } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
    await dispatch(runtime.routes, req as HttpRequest, res as unknown as HttpResponse);
    return res;
  }
  return { actor, covered, uncovered, operations, post, privacyTransaction, snapshot };
}

it("fences native privacy at deployment policy", () => withReplayFixture(async fixture => {
  for (const operation of ["export", "erase"] as const) {
    const { input } = fixture.uncovered;
    const res = await fixture.post(operation, operation === "erase" ? input : { subject: input.subject });
    expect(res.status).toHaveBeenCalledExactlyOnceWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.objectContaining({
      details: expect.objectContaining({ reason: "adopter_policy_required" }),
    }) }));
  }
  expect(fixture.privacyTransaction).not.toHaveBeenCalled();
}), postgresSetupTimeoutMs);

it("refuses an uncovered native erasure replay after admission", () => withReplayFixture(async fixture => {
  policy.allow = true;
  const before = await fixture.snapshot();
  const res = await fixture.post("erase", fixture.uncovered.input);
  expect(res.status).toHaveBeenCalledExactlyOnceWith(503);
  expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.objectContaining({
    code: "UPSTREAM_UNAVAILABLE",
    details: { privacyCode: expectedRefusal, observed: expect.any(String), cause: expect.any(String), fix: expect.any(String), recheck: expect.any(String) },
  }) }));
  const refused = await fixture.operations.erase(fixture.actor, fixture.uncovered.input).catch(error => error);
  expect(Object.getPrototypeOf(refused)).toBe(PrivacyRefusal.prototype);
  expect(refused).toMatchObject({ message: expectedRefusal, code: expectedRefusal });
  const control = await fixture.post("erase", fixture.covered.input);
  expect(control.status).toHaveBeenCalledExactlyOnceWith(200);
  expect(control.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, data: expect.objectContaining({
    erasureId: fixture.covered.erasureId, outcome: "ALREADY_ERASED",
  }) }));
  expect(await fixture.snapshot()).toEqual(before);
}), postgresSetupTimeoutMs);
