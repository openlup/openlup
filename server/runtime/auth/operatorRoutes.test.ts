import * as jose from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const privacy = vi.hoisted(() => {
  const query = vi.fn(), close = vi.fn(async () => {});
  return { query, close, createUnitOfWork: vi.fn(() => ({ run: (work: (context: { query: typeof query }) => Promise<unknown>) => work({ query }), close })) };
});
const authorize = vi.hoisted(() => vi.fn<(token: string | null) => Promise<AdminAuthorizationResult>>());
vi.mock('./operatorSessionBinding.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./operatorSessionBinding.js')>();
  return { ...actual, createOperatorHumanAuth: (...args: Parameters<typeof actual.createOperatorHumanAuth>) => f.privacyAuth
    ? { authorize, close: async () => {} } : actual.createOperatorHumanAuth(...args) };
});
vi.mock('./adminAuthBinding.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./adminAuthBinding.js')>();
  return { ...actual, resolveAdminAuthBinding: (...args: Parameters<typeof actual.resolveAdminAuthBinding>) => f.privacyAuth
    ? { binding: { run: async (token: string | null, work: (auth: { authorize: typeof authorize }) => Promise<unknown>) => work({ authorize }) } }
    : actual.resolveAdminAuthBinding(...args) };
});
const managed = vi.hoisted(() => ({ from: vi.fn(), getUserById: vi.fn() }));
vi.mock('../../_lib/admin-domain/auth.js', async importOriginal => ({
  ...await importOriginal<object>(),
  createServiceRoleClient: () => ({ from: managed.from, auth: { admin: { getUserById: managed.getUserById } } }),
}));
vi.mock('../../adapters/supabase/adminAuthVerifier.js', () => ({ createSupabaseAdminAuthFromEnv: () => ({ authorize }) }));
import bffRouter from '../../../api/bff/[...path].js';
import type { VercelRequest, VercelResponse } from '../../_lib/types/vercel.js';
import type { AdminAuthorizationResult } from '@openlup/platform/identity';
import type { HttpRequest, HttpResponse } from '@openlup/platform/http';
import type { OperatorMembership } from '@openlup/platform/identity';
import type { DeploymentRouteOptions } from '../../_lib/publicDeploymentPolicies.js';
const f = vi.hoisted(() => ({
  adopterPolicy: false,
  privacyAuth: false,
  policy: vi.fn(),
  store: {
    issue: vi.fn(async () => ({ deliverable: true, email: 'admin@example.invalid', expiresAt: new Date(Date.now() + 600000).toISOString() })),
    redeem: vi.fn(async () => ({ principalId: '11111111-1111-4111-8111-111111111111', email: 'admin@example.invalid' })),
    findMembership: vi.fn<() => Promise<OperatorMembership | null>>(),
    close: vi.fn(async () => {}),
  },
}));
// Operator sign-in keeps real session factories, handlers, preflight and observation.
vi.mock('@openlup/platform/identity', async importOriginal => ({ ...await importOriginal<object>(), createPostgresOperatorIdentityStore: () => f.store, createPostgresPrivacyUnitOfWork: privacy.createUnitOfWork }));
vi.mock('#deployment-route-policy', async importOriginal => {
  const policy = await importOriginal<typeof import('../../_lib/publicDeploymentPolicies.js')>();
  return { ...policy, enforceDeploymentRoutePolicy: (options: DeploymentRouteOptions, req: HttpRequest, res: HttpResponse) => {
    f.policy(options);
    // An adopter supplies this module through the same import-map seam as other admin mutations.
    return f.adopterPolicy || policy.enforceDeploymentRoutePolicy(options, req, res);
  } };
});
vi.mock('../settlementProfileBootstrap.js', () => ({ bootstrapAmbientSettlementProfile: () => {} }));
import { createOperatorSessionBinding } from './operatorSessionBinding.js';
import * as adminAuthBinding from './adminAuthBinding.js';
import { createReferenceBffDispatch, dispatch } from '../bffDispatch.js';
function response() { const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() }; res.status.mockReturnValue(res); return res; }
const origin = 'https://app.example.invalid';
function request(operation: string, body?: unknown) {
  return { url: '/api/bff/admin/platform/' + operation, method: operation === 'me' ? 'GET' : 'POST', headers: { origin, 'content-type': 'application/json' }, body } as HttpRequest;
}
beforeAll(async () => {
  const pair = await jose.generateKeyPair('ES256', { extractable: true });
  configuration = {
    PLATFORM_BUNDLE: 'node-postgres', DATABASE_URL: 'postgresql://unused.invalid/test', APP_BASE_URL: origin,
    CUSTOMER_IDENTITY_ISSUER: 'https://identity.example.invalid', CUSTOMER_IDENTITY_AUDIENCE: 'customer', OPERATOR_IDENTITY_AUDIENCE: 'operator', CUSTOMER_IDENTITY_KEY_ID: 'test.key',
    CUSTOMER_IDENTITY_PRIVATE_JWK: JSON.stringify({ ...await jose.exportJWK(pair.privateKey), alg: 'ES256' }),
    CUSTOMER_IDENTITY_JWKS: JSON.stringify({ keys: [{ ...await jose.exportJWK(pair.publicKey), alg: 'ES256', kid: 'test.key', use: 'sig' }] }),
  };
});
let configuration: Record<string, string>;
beforeEach(() => {
  vi.clearAllMocks(); f.adopterPolicy = false; f.privacyAuth = false;
  for (const [name, value] of Object.entries(configuration)) vi.stubEnv(name, value);
  f.store.findMembership.mockResolvedValue({ principalId: '11111111-1111-4111-8111-111111111111', email: 'admin@example.invalid', role: 'distributor', membershipState: 'active' });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it.each(['magic-link', 'verify-otp', 'me'])('public policy refuses mounted %s before reading input or creating a binding', async operation => {
  const createBinding = vi.fn(createOperatorSessionBinding);
  const resolveBinding = vi.spyOn(adminAuthBinding, 'resolveAdminAuthBinding');
  const req = request(operation);
  const readBody = vi.fn(() => { throw new Error('request body must stay unread'); });
  Object.defineProperty(req, 'body', { get: readBody });
  const res = response();
  await createReferenceBffDispatch(createBinding)([], req, res as unknown as HttpResponse);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ details: { reason: 'adopter_policy_required', route: req.url } }) }));
  expect(readBody).not.toHaveBeenCalled(); expect(createBinding).not.toHaveBeenCalled();
  expect(resolveBinding).not.toHaveBeenCalled(); expect(f.store.findMembership).not.toHaveBeenCalled();
  expect(f.store.issue).not.toHaveBeenCalled(); expect(f.store.redeem).not.toHaveBeenCalled();
  expect(f.policy).toHaveBeenCalledWith({ route: req.url, domain: 'platform', surface: 'admin', risk: 'mutation' });
});
it('adopter policy enables mounted delivery to an injected sink and real redemption', async () => {
  f.adopterPolicy = true;
  const res = response();
  const deliver = vi.fn(async () => { expect(res.json).toHaveBeenCalledWith({ ok: true, data: { accepted: true } }); });
  const composed = createReferenceBffDispatch(env => createOperatorSessionBinding(env, { deliver }));
  await composed([], request('magic-link', { email: 'admin@example.invalid' }), res as unknown as HttpResponse);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(deliver).toHaveBeenCalledExactlyOnceWith({ email: 'admin@example.invalid', token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresAt: expect.any(String) });
  expect(f.store.issue).toHaveBeenCalledOnce(); expect(f.store.close).toHaveBeenCalledOnce();
  const verified = response();
  await composed([], request('verify-otp', { token: 'a'.repeat(43) }), verified as unknown as HttpResponse);
  expect(verified.status).toHaveBeenCalledWith(200);
  expect(jose.decodeJwt(verified.json.mock.calls[0][0].data.accessToken).aud).toBe('operator');
  expect(f.store.redeem).toHaveBeenCalledOnce(); expect(f.store.close).toHaveBeenCalledTimes(2);
});
it('preserves caller-composed handlers behind the mounted policy boundary', async () => {
  const route = '/api/bff/admin/platform/magic-link';
  const deliver = vi.fn(async () => {});
  const binding = createOperatorSessionBinding(configuration, { deliver });
  const supplied = [{ route, pattern: new RegExp(`^${route}$`), params: [], handler: binding.requestChallenge }];
  try {
    const blocked = response();
    await dispatch(supplied, request('magic-link', { email: 'admin@example.invalid' }), blocked as unknown as HttpResponse);
    expect(blocked.status).toHaveBeenCalledWith(503); expect(deliver).not.toHaveBeenCalled();
    f.adopterPolicy = true;
    const accepted = response();
    await dispatch(supplied, request('magic-link', { email: 'admin@example.invalid' }), accepted as unknown as HttpResponse);
    expect(accepted.status).toHaveBeenCalledWith(200); expect(deliver).toHaveBeenCalledOnce();
  } finally { await binding.close(); }
});
it('default static reference mounts no identity routes', async () => {
  vi.stubEnv('PLATFORM_BUNDLE', ''); const res = response();
  await dispatch([], request('magic-link'), res as unknown as HttpResponse);
  expect(res.status).toHaveBeenCalledWith(404); expect(f.store.issue).not.toHaveBeenCalled();
});
it('adopter policy admits mounted me and authorizes the human bearer against live membership', async () => {
  f.adopterPolicy = true;
  const binding = createOperatorSessionBinding(configuration);
  const signed = response();
  await binding.verifyChallenge(request('verify-otp', { token: 'a'.repeat(43) }), signed as unknown as HttpResponse);
  await binding.close();
  const req = request('me'); req.headers.authorization = 'Bearer ' + signed.json.mock.calls[0][0].data.accessToken;
  const res = response(); await dispatch([], req, res as unknown as HttpResponse);
  expect(res.json).toHaveBeenCalledWith({ ok: true, data: { isAdmin: true, role: 'distributor' } });
  expect(f.policy).toHaveBeenCalledWith({ route: req.url, domain: 'platform', surface: 'admin', risk: 'mutation' });
  f.store.findMembership.mockResolvedValueOnce(null);
  await dispatch([], req, res as unknown as HttpResponse); expect(res.status).toHaveBeenLastCalledWith(403);
  f.store.findMembership.mockRejectedValueOnce(new Error('db'));
  await dispatch([], req, res as unknown as HttpResponse); expect(res.status).toHaveBeenLastCalledWith(503);
});

describe('mounted privacy routes', () => {
  beforeEach(() => { f.privacyAuth = true; });
it('direct privacy routes precede managed entries and enforce human admin in the handler', async () => {
  f.adopterPolicy = true;
  vi.stubEnv('OPERATOR_IDENTITY_AUDIENCE', 'operator'); vi.stubEnv('PLATFORM_BUNDLE', 'node-postgres'); vi.stubEnv('DATABASE_URL', 'postgresql://unused.invalid/test');
  const C = '22222222-2222-4222-8222-222222222222';
  privacy.query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT c.*') || sql.startsWith('SELECT * FROM public.clients') ? [{ id: C, email: 'privacy@example.com', principal_id: null, metadata: {} }] : sql.includes('AS unsafe') ? [{ unsafe: false }] : sql.startsWith('SELECT m.role') ? [{ role: 'admin', membership_state: 'active' }] : [] }));
  for (const operation of ['export', 'erase']) {
    authorize.mockResolvedValue({ ok: true, principalId: '11111111-1111-4111-8111-111111111111', role: 'admin', isMachineActor: false });
    const route = '/api/bff/admin/identity/privacy/' + operation, res = response();
    await dispatch([{ route, pattern: new RegExp('^' + route + '$'), params: [], handler: async () => { throw new Error('must use direct handler'); } }], { url: route, method: 'POST', headers: { authorization: 'Bearer human' }, body: { subject: { kind: 'contact', contactId: C }, ...(operation === 'erase' ? { idempotencyKey: C } : {}) } } as HttpRequest, res as unknown as HttpResponse);
    expect(res.status).toHaveBeenCalledWith(200); expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(authorize).toHaveBeenCalledWith('human', { allowedRoles: ['admin'] });
  }
  expect(privacy.close).toHaveBeenCalledTimes(2);
  authorize.mockResolvedValue({ ok: true, principalId: C, role: 'admin', isMachineActor: true });
  const denied = response(); privacy.query.mockClear();
  await dispatch([], { url: '/api/bff/admin/identity/privacy/erase', method: 'POST', headers: { authorization: 'Bearer machine' }, body: {} } as HttpRequest, denied as unknown as HttpResponse);
  expect(denied.status).toHaveBeenCalledWith(403); expect(privacy.query).not.toHaveBeenCalled();
});

const privacyContact = '22222222-2222-4222-8222-222222222222';
function mountedPrivacyRequest(operation: 'export' | 'erase') {
  const route = '/api/bff/admin/identity/privacy/' + operation;
  return {
    routes: [{ route, pattern: new RegExp('^' + route + '$'), params: [], handler: async () => { throw new Error('default mount must take precedence'); } }],
    req: { url: route, method: 'POST', headers: { authorization: 'Bearer human' }, body: {
      subject: { kind: 'contact', contactId: privacyContact }, ...(operation === 'erase' ? { idempotencyKey: privacyContact } : {}),
    } } as HttpRequest,
  };
}
function managedAdmin() {
  vi.stubEnv('PLATFORM_BUNDLE', 'node-supabase');
  vi.stubEnv('SUPABASE_URL', 'https://identity.example.invalid');
  vi.stubEnv('SUPABASE_ANON_KEY', 'synthetic-public-key');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service-key');
  authorize.mockResolvedValue({ ok: true, principalId: privacyContact, role: 'admin', isMachineActor: false });
  managed.from.mockImplementation(() => {
    const query = { select: vi.fn(() => query), eq: vi.fn(() => query), maybeSingle: async () => ({ data: {
      id: privacyContact, email: 'privacy@example.com', auth_user_id: null,
    }, error: null }) };
    return query;
  });
}
it.each(['export', 'erase'] as const)('public default refuses mounted direct %s before input or bindings', async operation => {
  const resolveBinding = vi.spyOn(adminAuthBinding, 'resolveAdminAuthBinding');
  const { routes, req } = mountedPrivacyRequest(operation), res = response();
  const supplied = vi.fn(async () => { throw new Error('supplied handler must stay behind policy'); });
  routes[0].handler = supplied;
  const readBody = vi.fn(() => { throw new Error('request body must stay unread'); });
  const readQuery = vi.fn(() => { throw new Error('request query must stay unread'); });
  Object.defineProperty(req, 'body', { get: readBody });
  Object.defineProperty(req, 'query', { get: readQuery });
  await dispatch(routes, req, res as unknown as HttpResponse);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(res.json).toHaveBeenCalledWith({ ok: false, error: expect.objectContaining({
    code: 'UPSTREAM_UNAVAILABLE', details: { reason: 'adopter_policy_required', route: req.url },
  }) });
  expect(f.policy).toHaveBeenCalledExactlyOnceWith({ route: req.url, domain: 'auth', surface: 'admin', risk: 'mutation' });
  expect(readBody).not.toHaveBeenCalled(); expect(readQuery).not.toHaveBeenCalled();
  expect(resolveBinding).not.toHaveBeenCalled(); expect(authorize).not.toHaveBeenCalled();
  expect(privacy.createUnitOfWork).not.toHaveBeenCalled(); expect(privacy.query).not.toHaveBeenCalled();
  expect(managed.from).not.toHaveBeenCalled(); expect(supplied).not.toHaveBeenCalled();
});
it.each(['node-supabase', 'vercel-supabase', ''])('mounted managed public default refuses privacy before reading request data (%s)', async bundle => {
  managedAdmin(); vi.stubEnv('PLATFORM_BUNDLE', bundle);
  for (const operation of ['export', 'erase'] as const) {
    const { req } = mountedPrivacyRequest(operation), res = response();
    const readBody = vi.fn(() => { throw new Error('request body must not be read'); });
    const readQuery = vi.fn(() => { throw new Error('request query must not be read'); });
    Object.defineProperty(req, 'body', { get: readBody });
    Object.defineProperty(req, 'query', { get: readQuery });
    await bffRouter(req as VercelRequest, res as unknown as VercelResponse);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: expect.objectContaining({
      code: 'UPSTREAM_UNAVAILABLE', details: { reason: 'adopter_policy_required', route: req.url },
    }) });
    expect(f.policy).toHaveBeenLastCalledWith(expect.objectContaining({
      route: req.url, surface: 'admin', risk: 'mutation',
    }));
    expect(readBody).not.toHaveBeenCalled(); expect(readQuery).not.toHaveBeenCalled();
  }
  expect(authorize).not.toHaveBeenCalled();
  expect(managed.from).not.toHaveBeenCalled(); expect(managed.getUserById).not.toHaveBeenCalled();
  expect(privacy.query).not.toHaveBeenCalled();
});
it.each(['node-supabase', 'vercel-supabase', ''])('mounted managed export reads with incomplete coverage through adopter policy (%s)', async bundle => {
  managedAdmin(); vi.stubEnv('PLATFORM_BUNDLE', bundle); f.adopterPolicy = true;
  const { req } = mountedPrivacyRequest('export'), res = response();
  await bffRouter(req as VercelRequest, res as unknown as VercelResponse);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ ok: true, data: expect.objectContaining({
    missingContributors: ['subscriptions'], documents: [expect.objectContaining({ coverage: expect.objectContaining({
      complete: false, unavailable: expect.arrayContaining(['contact.country', 'identity.erasure-receipts']),
    }) })],
  }) });
  expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  expect(f.policy).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ route: req.url, surface: 'admin', risk: 'mutation' }));
  expect(authorize).toHaveBeenCalledWith('human', { allowedRoles: ['admin'] });
  expect(managed.from).toHaveBeenCalledExactlyOnceWith('clients');
});
it.each(['node-supabase', 'vercel-supabase', ''])('mounted managed erase returns its mutation-free capability refusal through adopter policy (%s)', async bundle => {
  managedAdmin(); vi.stubEnv('PLATFORM_BUNDLE', bundle); f.adopterPolicy = true;
  const { req } = mountedPrivacyRequest('erase'), res = response();
  await bffRouter(req as VercelRequest, res as unknown as VercelResponse);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.objectContaining({ details: { privacyCode: 'MANAGED_PRIVACY_ERASURE_UNAVAILABLE' } }) }));
  expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  expect(f.policy).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ route: req.url, surface: 'admin', risk: 'mutation' }));
  expect(authorize).toHaveBeenCalledWith('human', { allowedRoles: ['admin'] });
  expect(managed.from).not.toHaveBeenCalled(); expect(managed.getUserById).not.toHaveBeenCalled();
  expect(privacy.query).not.toHaveBeenCalled();
});
it.each(['export', 'erase'] as const)('mounted managed %s retains admin and machine write fences', async operation => {
  managedAdmin(); f.adopterPolicy = true;
  const { routes, req } = mountedPrivacyRequest(operation);
  for (const auth of [
    { ok: false as const, code: 'UNAUTHORIZED' as const, message: 'Session required' },
    { ok: true as const, principalId: privacyContact, role: 'distributor' as const, isMachineActor: false },
    { ok: true as const, principalId: privacyContact, role: 'admin' as const, isMachineActor: true },
  ]) {
    authorize.mockResolvedValue(auth);
    const res = response(); await dispatch(routes, req, res as unknown as HttpResponse);
    expect(res.status).toHaveBeenCalledWith(auth.ok ? 403 : 401);
  }
  expect(managed.from).not.toHaveBeenCalled(); expect(privacy.query).not.toHaveBeenCalled();
});
it.each(['export', 'erase'] as const)('adopter policy admits mounted direct %s before managed entries', async operation => {
  f.adopterPolicy = true;
  vi.stubEnv('PLATFORM_BUNDLE', 'node-postgres'); vi.stubEnv('OPERATOR_IDENTITY_AUDIENCE', 'operator');
  vi.stubEnv('DATABASE_URL', 'postgresql://unused.invalid/test');
  authorize.mockResolvedValue({ ok: true, principalId: privacyContact, role: 'admin', isMachineActor: false });
  privacy.query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT c.*') || sql.startsWith('SELECT * FROM public.clients')
    ? [{ id: privacyContact, email: 'privacy@example.com', principal_id: null, metadata: {} }]
    : sql.includes('AS unsafe') ? [{ unsafe: false }] : sql.startsWith('SELECT m.role') ? [{ role: 'admin', membership_state: 'active' }] : [] }));
  const { routes, req } = mountedPrivacyRequest(operation), res = response();
  await dispatch(routes, req, res as unknown as HttpResponse);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json).toHaveBeenCalledWith({ ok: true, data: expect.objectContaining(operation === 'export'
    ? { missingContributors: [], documents: expect.arrayContaining([expect.objectContaining({ contributorId: 'subscriptions' })]) }
    : { outcome: 'ERASED' }) });
  expect(privacy.close).toHaveBeenCalledOnce(); expect(managed.from).not.toHaveBeenCalled();
  expect(f.policy).toHaveBeenCalledExactlyOnceWith({ route: req.url, domain: 'auth', surface: 'admin', risk: 'mutation' });
});

});
