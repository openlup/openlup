import * as jose from 'jose';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { HttpRequest, HttpResponse } from '@openlup/platform/http';
import type { OperatorMembership } from '@openlup/platform/identity';
import type { DeploymentRouteOptions } from '../../_lib/publicDeploymentPolicies.js';
const f = vi.hoisted(() => ({
  adopterPolicy: false,
  policy: vi.fn(),
  store: {
    issue: vi.fn(async () => ({ deliverable: true, email: 'admin@example.invalid', expiresAt: new Date(Date.now() + 600000).toISOString() })),
    redeem: vi.fn(async () => ({ principalId: '11111111-1111-4111-8111-111111111111', email: 'admin@example.invalid' })),
    findMembership: vi.fn<() => Promise<OperatorMembership | null>>(),
    close: vi.fn(async () => {}),
  },
}));
// Replace only the database transport; session factories, handlers, preflight and observation are real.
vi.mock('@openlup/platform/identity', async importOriginal => ({ ...await importOriginal<object>(), createPostgresOperatorIdentityStore: () => f.store }));
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
  vi.clearAllMocks(); f.adopterPolicy = false;
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
