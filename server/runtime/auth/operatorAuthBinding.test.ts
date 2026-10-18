import { expect, it, vi } from 'vitest';
import { resolveAdminAuthBinding, preflightAdminBffRoute } from './adminAuthBinding.js';
import type { VercelRequest, VercelResponse } from '../../_lib/types/vercel.js';
const id = '11111111-1111-4111-8111-111111111111';
it('human login needs no machine credential and retains the verified human actor', async () => {
  const auth = { authorize: vi.fn(async () => ({ ok: true as const, principalId: id, role: 'distributor' as const, isMachineActor: false })), close: vi.fn(async () => {}) };
  const factory = vi.fn(() => auth);
  const binding = resolveAdminAuthBinding({ PLATFORM_BUNDLE: 'node-postgres', OPERATOR_IDENTITY_AUDIENCE: 'operator' }, { humanAuthFactory: factory }).binding!;
  expect(await binding.run('human', a => a.authorize('human'))).toEqual({ ok: true, principalId: id, role: 'distributor', isMachineActor: false });
  expect(factory).toHaveBeenCalledOnce(); expect(auth.close).toHaveBeenCalledOnce();
});
it('a revoked matching machine credential never falls through to human authority', async () => {
  const humanAuthFactory = vi.fn(); const token = 'm'.repeat(32);
  const binding = resolveAdminAuthBinding({ PLATFORM_BUNDLE: 'node-postgres', OPERATOR_IDENTITY_AUDIENCE: 'operator', PLATFORM_OPERATOR_TOKEN: token, PLATFORM_OPERATOR_ID: id }, {
    humanAuthFactory, checkerFactory: () => ({ isOperatorAllowed: async () => false, close: async () => {} }),
  }).binding!;
  expect(await binding.run(token, a => a.authorize(token))).toMatchObject({ code: 'FORBIDDEN' }); expect(humanAuthFactory).not.toHaveBeenCalled();
});
it('human database failure becomes unavailable without invoking a machine checker', async () => {
  const checkerFactory = vi.fn();
  const humanClose = vi.fn(async () => {});
  const humanAuthFactory = vi.fn(() => ({ authorize: async () => { throw new Error('db'); }, close: humanClose }));
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() }; res.status.mockReturnValue(res);
  expect(await preflightAdminBffRoute({ headers: { authorization: 'Bearer human' } } as VercelRequest, res as unknown as VercelResponse, '/api/bff/admin/platform/admin-users/invite', { PLATFORM_BUNDLE: 'node-postgres', OPERATOR_IDENTITY_AUDIENCE: 'operator' }, {
    checkerFactory, humanAuthFactory,
  })).toBe(false);
  expect(res.status).toHaveBeenCalledWith(503); expect(checkerFactory).not.toHaveBeenCalled(); expect(humanAuthFactory).toHaveBeenCalledOnce(); expect(humanClose).toHaveBeenCalledOnce();
});

import { createSubscriptionsPrivacyContributor } from './subscriptionsPrivacyContributor.js';
import { createPostgresPrivacyStore, createIdentityPersonalDataContributor, createPersonalDataContributorRegistry, createPrivacyOperations } from '@openlup/platform/identity';
import type { PgQueryExecutor } from '@openlup/platform/data';
const C = "11111111-1111-4111-8111-111111111111", P = "22222222-2222-4222-8222-222222222222", A = "33333333-3333-4333-8333-333333333333", K = "44444444-4444-4444-8444-444444444444";
const subject = { contactId: C, principalId: P, identity: { contact: { id: C, principal_id: P, email: "person@example.com", metadata: {} }, membership: null } };
const actor = { principalId: A };
function executor(respond: (sql: string, values: unknown[]) => Record<string, unknown>[] = () => []) {
  const query = vi.fn(async (sql: string, values: unknown[] = []) => ({ rows: respond(sql, values) }));
  return { query, db: { query } as unknown as PgQueryExecutor };
}
it.each([["active", "PRIVACY_ACTIVE_SUBSCRIPTION"], ["paused", "PRIVACY_RESUMABLE_SUBSCRIPTION"], ["unknown", "PRIVACY_ASSESSMENT_UNAVAILABLE"]])("subscription %s veto precedes every identity mutation and never changes a subscription", async (status, code) => {
  const { db, query } = executor(sql => sql.startsWith("SELECT status") ? [{ status }] : []);
  const subscriptions = createSubscriptionsPrivacyContributor(); const store = createPostgresPrivacyStore();
  store.prepareErasure = async () => {}; store.authorizeErasure = async () => {}; store.resolve = async () => structuredClone(subject); store.findReceipt = async () => null;
  const erase = vi.spyOn(store, "eraseIdentity"); const save = vi.spyOn(store, "saveReceipt");
  const registry = createPersonalDataContributorRegistry([createIdentityPersonalDataContributor(store, { retainedContactFields: {} }, () => K), subscriptions], { requiredContributorIds: ["identity", "subscriptions"] });
  const ops = createPrivacyOperations({ store, registry, unitOfWork: { run: work => work(db) }, now: () => new Date(), randomId: () => K });
  await expect(ops.erase(actor, { subject: { kind: "contact", contactId: C }, idempotencyKey: K })).rejects.toThrow(code);
  expect(erase).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  expect(query.mock.calls.map(([sql]) => sql)).toEqual(["LOCK TABLE public.subscriptions IN SHARE MODE", "SELECT status FROM public.subscriptions WHERE client_id = $1"]);
});
