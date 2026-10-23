import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair } from 'jose';
import { createPostgresMigrationRunner } from '../../server/adapters/postgres/migrationRunner.js';
import { createPostgresDataGateway, type PgGatewayClient } from '@openlup/platform/data';
import { createCapturedCustomerChallengeDelivery, createCustomerIdentityVerifier, createPostgresCustomerMePort, resolveCustomerSessionBinding, type CustomerSessionBinding } from '@openlup/platform/identity';
import { createPostgresCustomerAuthPort } from '../../src/integrations/postgres/customerAuthPort';
import { getCustomerMe } from '../../src/domains/customers/customerMeClient';
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from '../helpers/postgresContainer.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PA = '33333333-3333-4333-8333-333333333333';
const PB = '44444444-4444-4444-8444-444444444444';
const SUB = '55555555-5555-4555-8555-555555555555';
let pool: Pool;
let container: PostgresContainer | undefined;
let binding: CustomerSessionBinding;
let verifier: ReturnType<typeof createCustomerIdentityVerifier>;
let gateway: ReturnType<typeof createPostgresDataGateway>;
let challenge = '';
let clock = new Date();
let ledger: unknown;
const ledgerRows = async () => (await pool.query('SELECT catalog_path, sha256, position, executed_at FROM public.platform_schema_migrations ORDER BY position')).rows;
const identityRows = async () => ({ clients: (await pool.query('SELECT id, principal_id FROM public.clients ORDER BY id')).rows, subscriptions: (await pool.query('SELECT id, client_id, status FROM public.subscriptions ORDER BY id')).rows });
let identities: Awaited<ReturnType<typeof identityRows>>;

beforeAll(async () => {
  // Node supplies WebCrypto; the browser adapter also needs window-owned storage.
  vi.stubGlobal('window', { localStorage, sessionStorage, location: { search: '' } });
  if (!(await dockerAvailable())) throw new Error('This acceptance proof requires Docker and postgres:16; a skip is not a pass');
  container = await runPostgresContainer({ name: `browser-identity-${process.pid}`, password: 'synthetic-test-only' });
  if (!(await waitForPostgresTcpReady(container.connectionString))) throw new Error('Disposable PostgreSQL did not become ready');
  const { Pool: PoolCtor } = await import('pg');
  pool = new PoolCtor({ connectionString: container.connectionString });
  const runner = createPostgresMigrationRunner({ connectionString: container.connectionString }, { poolFactory: () => pool });
  await runner.apply(); // Complete selected catalogue, never the sparse package projections.
  ledger = await ledgerRows();
  await pool.query('INSERT INTO public.clients (id, email, principal_id, lifecycle_stage) VALUES ($1,$2,$3,\'customer\'),($4,$5,$6,\'customer\')', [A, 'a@example.com', PA, B, 'b@example.com', PB]);
  await pool.query('INSERT INTO public.subscriptions (id, client_id, cadence_days, status) VALUES ($1,$2,28,\'active\')', [SUB, A]);
  identities = await identityRows();
  const keys = await generateKeyPair('ES256', { extractable: true });
  const privateJwk = { ...await exportJWK(keys.privateKey), alg: 'ES256', kid: 'browser-proof', use: 'sig' };
  const publicJwk = { ...await exportJWK(keys.publicKey), alg: 'ES256', kid: 'browser-proof', use: 'sig' };
  const env = { PLATFORM_BUNDLE: 'node-postgres', DATABASE_URL: container.connectionString,
    CUSTOMER_IDENTITY_AUDIENCE: 'browser-reference', CUSTOMER_IDENTITY_ISSUER: 'https://identity.example.invalid', CUSTOMER_IDENTITY_KEY_ID: 'browser-proof', CUSTOMER_IDENTITY_PRIVATE_JWK: JSON.stringify(privateJwk) };
  const selected = resolveCustomerSessionBinding(env, { loadJwt: () => import('jose'), now: () => clock,
    delivery: createCapturedCustomerChallengeDelivery(async (value) => { challenge = value.token; }) });
  if (!selected.binding) throw new Error(selected.error);
  binding = selected.binding;
  verifier = createCustomerIdentityVerifier({ audience: env.CUSTOMER_IDENTITY_AUDIENCE, issuer: env.CUSTOMER_IDENTITY_ISSUER, jwks: JSON.stringify({ keys: [publicJwk] }) }, () => import('jose'));
  gateway = createPostgresDataGateway({ connectionString: container.connectionString }, { poolFactory: () => pool });
  vi.stubGlobal('fetch', vi.fn(async (path: string, input: RequestInit) => {
    const body = input?.body ? JSON.parse(String(input.body)) : null;
    let data: unknown;
    if (path === '/api/bff/customers/magic-link') { await binding.requestChallenge(body.email); data = { accepted: true }; }
    else if (path === '/api/bff/customers/verify-otp') {
      data = await binding.verifyChallenge(body.token);
      if (!data) return new Response(JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired challenge' } }), { status: 401 });
    } else if (path === '/api/bff/customers/me') {
      const bearer = new Headers(input.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
      const principal = await verifier.verifyAccessToken(bearer);
      if (!principal) throw new Error('Session did not verify');
      data = await gateway.asActor({ sub: principal.principalId }, (client) => createPostgresCustomerMePort(client as PgGatewayClient).getCustomerMe(principal.principalId));
    } else throw new Error('Unexpected browser transport');
    return new Response(JSON.stringify({ ok: true, data }), { headers: { 'content-type': 'application/json' } });
  }));
}, postgresSetupTimeoutMs);
afterAll(async () => { vi.unstubAllGlobals(); await closePostgres(container, pool); }, postgresTeardownTimeoutMs);

describe('direct browser identity on the complete selected PostgreSQL catalogue', () => {
  it('redeemed challenge reads only its linked customer', async () => {
    const port = createPostgresCustomerAuthPort();
    await expect(port.signInWithOtp({ email: 'a@example.com', locale: 'en' })).resolves.toEqual({ error: null });
    expect(challenge.length).toBeGreaterThanOrEqual(16);
    await expect(port.verifyOtpCode({ email: 'a@example.com', token: challenge })).resolves.toEqual({ error: null });
    const session = await port.getSession();
    expect(session?.user.id).toBe(PA);
    expect(await getCustomerMe(session!.accessToken)).toMatchObject({ clientId: A, email: 'a@example.com' });
    await port.signOut();
    expect(await port.getSession()).toBeNull();
  });
  it('replayed or expired challenge cannot establish a session', async () => {
    const port = createPostgresCustomerAuthPort();
    await expect(port.verifyOtpCode({ email: 'a@example.com', token: challenge })).resolves.toEqual({ error: 'otp_invalid_or_expired' });
    await port.signInWithOtp({ email: 'b@example.com', locale: 'en' });
    clock = new Date(Date.now() + 20 * 60_000);
    await expect(port.verifyOtpCode({ email: 'b@example.com', token: challenge })).resolves.toEqual({ error: 'otp_invalid_or_expired' });
    expect(await port.getSession()).toBeNull();
  });
  it('customer A cannot read customer B through the actor lane', async () => {
    await gateway.asActor({ sub: PA }, async (raw) => {
      const client = raw as PgGatewayClient;
      const { data, error } = await client.from('clients').select('id, email').eq('id', B).maybeSingle();
      expect(error).toBeNull(); expect(data).toBeNull();
    });
  });
  it('failed verification preserves client and subscription identity', async () => {
    expect(await binding.verifyChallenge('invalid_synthetic_challenge')).toBeNull();
    expect(await identityRows()).toEqual(identities);
  });
  it('browser deployment and runner replay leave the migration ledger unchanged', async () => {
    await expect(createPostgresMigrationRunner({ connectionString: container!.connectionString }, { poolFactory: () => pool }).apply()).resolves.toEqual({ applied: [] });
    expect(await ledgerRows()).toEqual(ledger);
    expect(await identityRows()).toEqual(identities);
  });
});
