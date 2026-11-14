import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { currencyExponent } from '@openlup/platform/market-packs';
import type { PgQueryExecutor } from '@openlup/platform/data';
import { createEcommerceEventPrivacyContributor, createPostgresEcommerceEventProjection } from '@openlup/platform/communications';
import { createPostgresPrivacyStore, createPostgresPrivacyUnitOfWork, createIdentityPersonalDataContributor,
  createPersonalDataContributorRegistry, createFulfillmentParcelContactPrivacyContributor, createCustomerBillingPrivacyContributor, erasePersonalData } from '@openlup/platform/identity';
import { createSubscriptionsPrivacyContributor } from '../../server/runtime/auth/subscriptionsPrivacyContributor.js';
import { ecommercePaid, ecommerceAt } from './communicationEcommerceFixture.js';
import { lifecycleInstallation, type LifecycleInstallation } from './subscriptionLifecycleClosureFixture.js';
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from '../helpers/postgresContainer.js';

let env: LifecycleInstallation, fact: Awaited<ReturnType<typeof ecommercePaid>>;
const actor = { principalId: randomUUID() }, now = () => new Date(ecommerceAt);
const binding = { account: 'synthetic-erasure', environment: 'test', namespace: 'synthetic', mappingVersion: 'ecommerce-v1' };
beforeAll(async () => {
  env = await lifecycleInstallation('qualified-v2');
  const seed = await env.owner.connect();
  try { await seed.query('BEGIN'); fact = await ecommercePaid(seed); await seed.query('COMMIT'); }
  finally { await seed.query('ROLLBACK'); seed.release(); }
  await env.owner.query('INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)', [actor.principalId, `${actor.principalId}@example.invalid`]);
  await env.owner.query("INSERT INTO public.platform_human_memberships(principal_id,role,membership_state,membership_provenance,membership_accepted_at) VALUES($1,'admin','active','legacy',now())", [actor.principalId]);
}, postgresSetupTimeoutMs);
afterAll(async () => env?.close(), postgresTeardownTimeoutMs);

it('erases through the qualified runtime before a waiting projection without a deadlock', async () => {
  const projectionDb = await env.runtime.connect();
  const unitOfWork = createPostgresPrivacyUnitOfWork({ connectionString: 'postgresql://unused.invalid/fixture' }, { poolFactory: () => env.runtime });
  const originalStore = createPostgresPrivacyStore();
  let resolveEntered!: () => void, resumeResolve!: () => void, erasureDb!: PgQueryExecutor;
  const entered = new Promise<void>(resolve => { resolveEntered = resolve; });
  const resume = new Promise<void>(resolve => { resumeResolve = resolve; });
  const store = { ...originalStore, async resolve(...args: Parameters<typeof originalStore.resolve>) {
    const [db] = args, subject = await originalStore.resolve(...args);
    erasureDb = db; resolveEntered(); await resume; return subject;
  } };
  const retainedContactFields = Object.fromEntries(['lifecycle_stage', 'acquisition_source'].map(field => [field,
    { owner: 'clients', resource: `clients.${field}`, disposition: 'retain' as const, reasonCode: 'CONTACT_LIFECYCLE_RETENTION', remote: false }]));
  const registry = createPersonalDataContributorRegistry([
    createIdentityPersonalDataContributor(store, { retainedContactFields }, randomUUID), createSubscriptionsPrivacyContributor(),
    createFulfillmentParcelContactPrivacyContributor(), createCustomerBillingPrivacyContributor(), createEcommerceEventPrivacyContributor(),
  ], { requiredContributorIds: ['identity', 'subscriptions', 'fulfillment-parcel-contacts', 'customer-billing', 'communication-events'] });
  const withTransaction = async <T>(work: (db: PoolClient) => Promise<T>) => {
    try { await projectionDb.query('BEGIN'); const result = await work(projectionDb); await projectionDb.query('COMMIT'); return result; }
    catch (error) { await projectionDb.query('ROLLBACK'); throw error; }
  };
  const projection = createPostgresEcommerceEventProjection({ binding, now, liveSince: new Date('2026-11-11T11:00:00Z'),
    currency: { code: 'USD', exponent: currencyExponent('USD'), provenance: 'runtime-icu:currencyExponent.v1' }, withTransaction,
    resolveTarget: async () => ({ subjectReference: 'subject:synthetic', profileId: 'profile_synthetic', generation: 1, authorityReference: 'authority:1' }) });
  let erasing: ReturnType<typeof erasePersonalData<PgQueryExecutor>> | undefined, projecting: ReturnType<typeof projection.project> | undefined;
  try {
    expect((await projectionDb.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user')).rows)
      .toEqual([{ current_user: 'service_role', rolsuper: false, rolbypassrls: false }]);
    await projection.initialize();
    const projectionPid = (await projectionDb.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    erasing = erasePersonalData({ store, unitOfWork, registry, now, randomId: randomUUID }, actor,
      { subject: { kind: 'contact', contactId: fact.client }, idempotencyKey: randomUUID() });
    // Attach rejection handlers before either transaction can finish.
    const erased = Promise.allSettled([erasing]);
    await Promise.race([entered, erasing.then(() => { throw new Error('erasure completed before the resolution barrier'); })]);
    let projectionFinished = false;
    projecting = projection.project();
    const projected = Promise.allSettled([projecting]).then(results => { projectionFinished = true; return results; });
    // Observe the other backend using the paused erasure connection: no third observer, sleeps or clock bounds.
    while (!(await erasureDb.query('SELECT pg_backend_pid()=ANY(pg_blocking_pids($1)) AS blocked', [projectionPid])).rows[0]?.blocked) {
      if (projectionFinished) throw new Error('projection completed before its lock wait');
    }
    resumeResolve();
    const outcomes = [...await erased, ...await projected];
    for (const outcome of outcomes) if (outcome.status === 'rejected') {
      const error = outcome.reason as Error & { code?: string };
      throw new Error(`erasure/projection SQLSTATE ${error.code}: ${error.message}`, { cause: error });
    }
    expect(outcomes).toMatchObject([{ status: 'fulfilled', value: { outcome: 'ERASED' } },
      { status: 'fulfilled', value: { projected: 0, refused: 1, deferred: 0 } }]);
    expect((await projectionDb.query('SELECT email,first_name,last_name,phone,country,principal_id FROM public.clients WHERE id=$1', [fact.client])).rows[0])
      .toEqual({ email: expect.stringMatching(/^erased\+.+@identity\.invalid$/u), first_name: null, last_name: null, phone: null, country: null, principal_id: null });
    // Read private receipts as the fixture owner; the runtime receives no table-write grant.
    expect((await env.owner.query('SELECT state,reason,outbox_event_id,request_digest FROM public.communication_event_receipts WHERE source_key=$1', [`paid:${fact.order}`])).rows)
      .toEqual([{ state: 'erased', reason: 'subject_erased', outbox_event_id: null, request_digest: null }]);
    expect((await env.owner.query('SELECT client_id FROM public.communication_event_erasures WHERE client_id=$1', [fact.client])).rows).toEqual([{ client_id: fact.client }]);
    expect((await env.owner.query('SELECT client_id FROM public.identity_privacy_erasures WHERE client_id=$1', [fact.client])).rows).toEqual([{ client_id: fact.client }]);
    expect((await env.owner.query("SELECT count(*)::integer AS count FROM public.outbox_events WHERE event_type='communication.ecommerce.export.v1'")).rows).toEqual([{ count: 0 }]);
    expect((await projectionDb.query("SELECT has_table_privilege(current_user,'public.communication_event_receipts','UPDATE') AS allowed")).rows).toEqual([{ allowed: false }]);
  } finally {
    resumeResolve(); await Promise.allSettled([erasing, projecting]); projectionDb.release();
  }
});
