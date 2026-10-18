import * as jose from 'jose';
import { expect, it, vi } from 'vitest';
import type { HttpRequest, HttpResponse } from '@openlup/platform/http';
const { store } = vi.hoisted(() => ({ store: {
  issue: vi.fn(async () => ({ deliverable: true, email: 'admin@example.invalid', expiresAt: new Date(Date.now()+600000).toISOString() })),
  redeem: vi.fn(async () => ({ principalId: '11111111-1111-4111-8111-111111111111', email: 'admin@example.invalid' })),
  findMembership: vi.fn(async () => ({ principalId: '11111111-1111-4111-8111-111111111111', email: 'admin@example.invalid', role: 'distributor', membershipState: 'active' })),
  close: vi.fn(async () => {}),
} }));
vi.mock('@openlup/platform/identity', async importOriginal => ({ ...await importOriginal<object>(), createPostgresOperatorIdentityStore: () => store }));
import { createOperatorSessionBinding, createOperatorHumanAuth } from './operatorSessionBinding.js';
it('reference composition issues and authorizes an operator audience with no machine configuration', async () => {
  const pair = await jose.generateKeyPair('ES256', { extractable: true });
  const env = { PLATFORM_BUNDLE: 'node-postgres', DATABASE_URL: 'postgresql://unused.invalid/test', APP_BASE_URL: 'https://app.example.invalid', CUSTOMER_IDENTITY_ISSUER: 'https://identity.example.invalid', CUSTOMER_IDENTITY_AUDIENCE: 'customer', OPERATOR_IDENTITY_AUDIENCE: 'operator', CUSTOMER_IDENTITY_KEY_ID: 'test.key', CUSTOMER_IDENTITY_PRIVATE_JWK: JSON.stringify({ ...await jose.exportJWK(pair.privateKey), alg: 'ES256' }), CUSTOMER_IDENTITY_JWKS: JSON.stringify({ keys: [{ ...await jose.exportJWK(pair.publicKey), alg: 'ES256', kid: 'test.key', use: 'sig' }] }) };
  const binding = createOperatorSessionBinding(env);
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() }; res.status.mockReturnValue(res);
  await binding.verifyChallenge({ method: 'POST', headers: { origin: env.APP_BASE_URL, 'content-type': 'application/json' }, body: { token: 'a'.repeat(43) } } as HttpRequest, res as unknown as HttpResponse);
  expect(res.status).toHaveBeenCalledWith(200);
  const session = res.json.mock.calls[0][0].data;
  const payload = jose.decodeJwt(session.accessToken); expect(payload.aud).toBe('operator'); expect(payload.exp! - payload.iat!).toBe(900);
  const auth = createOperatorHumanAuth(env);
  expect(await auth.authorize(session.accessToken)).toMatchObject({ ok: true, role: 'distributor', isMachineActor: false });
  expect(() => createOperatorSessionBinding({ ...env, OPERATOR_IDENTITY_AUDIENCE: 'customer' })).toThrow('distinct');
  expect(() => createOperatorSessionBinding({ ...env, APP_BASE_URL: 'https://app.example.invalid/path' })).toThrow('origin');
  await auth.close(); await binding.close();
});
