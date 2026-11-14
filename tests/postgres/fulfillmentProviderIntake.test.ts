import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPostgresFulfillmentProviderIntake } from '@openlup/platform/fulfillment/native';
import { createPostgresPlatformJobRunLedger } from '@openlup/platform/job-ledger';
import type { PlatformJobRunLedgerPort } from '@openlup/platform/job-ledger';
import type { FulfillmentCapabilityDescriptor, FulfillmentObservation, FulfillmentReconciliationObservation } from '@openlup/platform/fulfillment/contracts';
import { fixture, openCase, replacement } from '../helpers/fulfillmentNative.js';
import { lifecycleInstallation, lifecycleProfiles, type LifecycleInstallation } from './subscriptionLifecycleClosureFixture.js';
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from '../helpers/postgresContainer.js';
import { captureStoreJourney, storeJourneyResources, journeySelection } from '../helpers/storeJourney.js';
import { restoreConnectedNativeStore } from '../../server/adapters/postgres/connectedStoreRestore.js';

const at = '2026-11-14T10:00:00.000Z', later = '2026-11-14T11:00:00.000Z', earlier = '2026-11-14T09:00:00.000Z';
const capability: FulfillmentCapabilityDescriptor = {
  providerRef: 'warehouse-a', role: 'warehouse', transportSelection: 'provider', operations: {
    dispatch: { supported: true }, readback: { supported: true }, exactAbsence: { supported: true }, verifyObservation: { supported: true },
    syncStock: { supported: true }, syncProducts: { supported: true }, labelCreate: { supported: false, reason: 'not_exposed' }, labelRead: { supported: false, reason: 'host_only' },
    labelVoid: { supported: false, reason: 'not_exposed' }, cancel: { supported: false, reason: 'not_exposed' }, pickupPoint: { supported: false, reason: 'not_exposed' }, courierPickup: { supported: false, reason: 'not_exposed' },
  }, authentication: 'token', freshness: 'not_available', defaultOff: true, selected: true, readiness: { ready: true }, ownsDeliveredNotification: true,
  stockAuthority: 'external_stock_master_with_local_reservations', labelReadOwner: 'host_storage', actionPolicy: { providerSpecificAdminActions: false, genericAdminActions: true, mutationSurface: 'local_only' },
};
const keys = {
  stock: (ref: string) => `intake:stock:${ref}`, handoff: (ref: string) => `intake:handoff:${ref}`,
  tracking: (event: string, number: string) => `intake:tracking:${event}:${number}`,
  acceptance: (ref: string) => ({ providerAttemptKey: `intake:accept:${ref}`, labelKey: `intake:receipt:${ref}` }),
  exception: (ref: string, occurrence: string) => `intake:exception:${ref}:${occurrence}`,
};
const adapterOrderIdentity = {
  merchantOrderRef: (number: string) => number,
  outboundOrderNumber: (order: { orderRef: string; orderNumber: string | null }) => order.orderNumber ?? order.orderRef,
};
const invocation = { triggerKind: 'scheduler' as const, invocationSource: 'offline-native-witness' };
const verification = { rawBody: new Uint8Array([123, 125]), headers: {}, receivedAt: at };
type Intake = ReturnType<typeof createPostgresFulfillmentProviderIntake>;
for (const profile of lifecycleProfiles) describe(`native provider intake on ${profile}`, () => {
  let h: LifecycleInstallation;
  beforeAll(async () => { h = await lifecycleInstallation(profile); }, postgresSetupTimeoutMs);
  afterAll(async () => { await h?.close(); }, postgresTeardownTimeoutMs);
  async function subject(reservations = true, accepted = true) {
    const f = await fixture(h.owner), external = `external:${randomUUID()}`, dispatch = randomUUID();
    const orderNumber = `ORDER-${f.order}`;
    await h.owner.query("UPDATE public.commerce_orders SET metadata=jsonb_build_object('orderNumber',$2::text) WHERE id=$1", [f.order, orderNumber]);
    const evidence = { commandFingerprint: 'a'.repeat(64), providerRef: 'warehouse-a', contactRevision: { schemaVersion: 1, source: 'fixture', revision: 1 }, carrierRef: null, serviceRef: null };
    await h.owner.query("INSERT INTO public.fulfillment_dispatch_refs(id,request_key,shipment_id,order_id,external_ref,mode,status,evidence,acceptance) VALUES($1,$2,$3,$4,$5,'live',$6,$7,$8)",
      [dispatch, `dispatch:${f.shipment}`, f.shipment, f.order, external, accepted ? 'created' : 'submitting', evidence,
        accepted ? { kind: 'accepted', externalRef: external, evidence, ...keys.acceptance(f.shipment) } : null]);
    if (accepted) await h.owner.query("INSERT INTO public.shipment_external_refs(shipment_id,ref_role,external_id) VALUES($1,'dispatch',$2)", [f.shipment, external]);
    if (reservations) await h.owner.query('INSERT INTO public.fulfillment_parcel_reservation_sets(shipment_id,order_id) VALUES($1,$2)', [f.shipment, f.order]);
    return { ...f, external, dispatch, orderNumber };
  }
  type Subject = Awaited<ReturnType<typeof subject>>;
  function observation(f: Subject, status: FulfillmentObservation['fact']['canonicalStatus'] = 'in_transit', time: string | null = at, numbers: string[] = [`TRACK-${f.shipment}`]): FulfillmentObservation {
    const event = randomUUID();
    return { eventKey: event, eventKind: status === 'delivered' ? 'shipment.delivered' : status === 'packed' ? 'shipment.packed' : status === 'exception' ? 'parcel.exception' : 'shipment.in_transit',
      firstReceivedAt: at, fact: { schemaVersion: 1, mapperVersion: 'fixture-v1', factId: event, providerKind: 'warehouse-a', fulfillmentReference: f.external,
        canonicalStatus: status, provenance: { source: 'provider_webhook', authority: 'provider_asserted' }, occurredAt: time === null ? null : new Date(time).toISOString(), receivedAt: at,
        rawEvent: { reference: `evidence:${randomUUID()}`, digestAlgorithm: 'sha256', digest: 'a'.repeat(64) } },
      correlation: { orderRef: null, fulfillmentRef: null, parcelRef: null, externalRef: f.external, orderNumber: f.orderNumber, providerFulfillmentRef: null },
      intake: { occurredAt: time, occurrenceKey: createHash('sha256').update(JSON.stringify([status, time])).digest('hex'), recovery: status === 'exception' ? 'provider_recovered' : null },
      trackingRefs: numbers.map(trackingNumber => ({ trackingNumber, carrierRef: 'carrier', serviceRef: 'service', publicUrl: `https://tracking.example.invalid/${trackingNumber}` })) };
  }
  function compose(obs: FulfillmentObservation, options: Partial<Parameters<typeof createPostgresFulfillmentProviderIntake>[0]> = {}) {
    return createPostgresFulfillmentProviderIntake({ db: h.runtime, enabled: true, selection: { providerRef: 'warehouse-a', carrierRef: null, serviceRef: null, deliveryKind: 'courier', pickupPoint: null },
      capability, observation: { verifyAndNormalize: async () => ({ kind: 'verified', observation: obs }) }, pages: { readPage: async () => ({ kind: 'page', rows: [row(obs)] }) },
      codecs: { normalizeCarrier: ({ carrierRef }) => carrierRef, approveTrackingUrl: value => new URL(value).hostname === 'tracking.example.invalid', publicUrl: () => null }, keys, ...options });
  }
  const row = (obs: FulfillmentObservation): FulfillmentReconciliationObservation => ({ kind: 'found', observation: obs, externalRef: obs.correlation.externalRef ?? '', createdAt: null, updatedAt: obs.intake?.occurredAt ?? null });
  const state = async (f: Subject) => (await h.owner.query('SELECT status,handed_over_at,delivered_at FROM public.fulfillment_shipments WHERE id=$1', [f.shipment])).rows[0];
  const proofs = (f: Subject) => h.owner.query('SELECT * FROM public.fulfillment_operator_status_evidence WHERE shipment_id=$1', [f.shipment]);
  const notices = (f: Subject, event = 'commerce.shipment.dispatched') => h.owner.query('SELECT * FROM public.outbox_events WHERE aggregate_id=$1 AND event_type=$2', [f.order, event]);
  async function census(f: Subject) {
    return { parcel: await state(f), refs: (await h.owner.query('SELECT * FROM public.shipment_external_refs WHERE shipment_id=$1 ORDER BY id', [f.shipment])).rows,
      proofs: (await proofs(f)).rows, holds: (await h.owner.query('SELECT * FROM public.commerce_order_holds WHERE order_id=$1 ORDER BY id', [f.order])).rows,
      arrivals: (await h.owner.query('SELECT * FROM public.subscription_delivery_alignment_arrivals WHERE shipment_id=$1', [f.shipment])).rows };
  }
  function job(ledger?: PlatformJobRunLedgerPort, pageSize = 50) {
    return { ledger: ledger ?? createPostgresPlatformJobRunLedger(h.runtime, { releaseCorrelation: () => ({}), defaultFailureReason: 'offline_failed' }), jobName: `intake-${randomUUID()}`, invocation, pageSize };
  }
  it('verifies before parse/storage and gates disabled, polling-only and unbound selections without writes', async () => {
    const f = await subject(), obs = observation(f), verify = vi.fn(async () => ({ kind: 'refused' as const, refusal: { reason: 'untrusted' as const, phase: 'verify' as const, retryable: false } }));
    const before = await census(f);
    expect(await compose(obs, { observation: { verifyAndNormalize: verify } }).ingest(verification)).toMatchObject({ kind: 'refused', refusal: { reason: 'untrusted' } });
    expect(verify).toHaveBeenCalledOnce(); verify.mockClear();
    for (const options of [{ enabled: false }, { capability: { ...capability, intakeMode: 'polling' as const } }, { db: null }])
      expect(await compose(obs, { ...options, observation: { verifyAndNormalize: verify } }).ingest(verification)).toMatchObject({ kind: 'refused' });
    expect(verify).not.toHaveBeenCalled(); expect(await census(f)).toEqual(before);
    expect((await h.owner.query('SELECT * FROM public.fulfillment_observations WHERE event_key=$1', [obs.eventKey])).rows).toEqual([]);
  });
  it('restores first receipt, changed tracking/digest and interrupted ACK correlation before any effect', async () => {
    const f = await subject(true, false), obs = observation(f, 'in_transit', at, ['TRACK:FIRST']);
    await h.runtime.query('SELECT public.fulfillment_intake_record_observation($1,NULL,$2,$3)', [obs.eventKey, obs, at]);
    const altered = { ...obs, correlation: { ...obs.correlation, externalRef: 'changed', orderNumber: 'changed' }, firstReceivedAt: later,
      fact: { ...obs.fact, receivedAt: later, rawEvent: { ...obs.fact.rawEvent, digest: 'b'.repeat(64) } }, trackingRefs: [] };
    expect(await compose(altered).ingest(verification)).toMatchObject({ kind: 'processed', replayed: true, observation: obs });
    const stored = (await h.owner.query('SELECT * FROM public.fulfillment_observations WHERE event_key=$1', [obs.eventKey])).rows[0];
    expect(new Date(stored.first_received_at).toISOString()).toBe(at); expect(stored.observation).toEqual(obs);
    expect((await state(f)).status).toBe('in_transit');
    expect((await h.owner.query("SELECT external_id FROM public.shipment_external_refs WHERE shipment_id=$1 AND ref_role='tracking'", [f.shipment])).rows).toEqual([{ external_id: 'TRACK:FIRST' }]);
    expect((await h.owner.query('SELECT status,acceptance FROM public.fulfillment_dispatch_refs WHERE id=$1', [f.dispatch])).rows[0]).toMatchObject({ status: 'created', acceptance: { externalRef: f.external } });
  });
  it('uses recorded byte-exact associations, rejects contradictions and never parses suffixes or provider UUIDs', async () => {
    const f = await subject(), obs = observation(f, 'picking');
    await h.owner.query("UPDATE public.fulfillment_dispatch_refs SET parcel_ref='recorded-parcel:2' WHERE id=$1", [f.dispatch]);
    const recorded = { ...obs, correlation: { ...obs.correlation, providerFulfillmentRef: 'recorded-parcel:2' } };
    expect(await compose(recorded).ingest(verification)).toMatchObject({ kind: 'processed' });
    for (const source of ['provider_reference', 'native_reference'] as const) {
      const only = observation(f, 'picking'); only.correlation.externalRef = null;
      if (source === 'provider_reference') only.correlation.providerFulfillmentRef = 'recorded-parcel:2';
      else only.correlation.fulfillmentRef = f.shipment;
      expect(await compose(only).ingest(verification)).toMatchObject({ kind: 'processed' });
    }
    const wrong = observation(f, 'picking'); wrong.correlation.fulfillmentRef = (await subject()).shipment;
    const before = await census(f); await expect(compose(wrong).ingest(verification)).rejects.toThrow('correlation_conflict'); expect(await census(f)).toEqual(before);
    const unknown = observation(f, 'picking'); unknown.correlation.externalRef = randomUUID(); unknown.correlation.orderNumber = 'number-R2';
    unknown.correlation.providerFulfillmentRef = 'unrecorded-R2';
    expect(await compose(unknown).ingest(verification)).toMatchObject({ kind: 'ignored' }); expect(await census(f)).toEqual(before);
  });
  it.each(['webhook', 'polling', 'unmapped'] as const)('repairs an interrupted ACK from the recorded merchant order through %s without resubmission', async channel => {
    const f = await subject(true, false), obs = observation(f, 'picking');
    await h.owner.query('UPDATE public.fulfillment_dispatch_refs SET external_ref=NULL,parcel_ref=NULL WHERE id=$1', [f.dispatch]);
    const before = await state(f), calls: string[] = [];
    const db = { query: async (sql: string, values?: unknown[]) => { calls.push(sql); return h.runtime.query(sql, values); } };
    const native = compose(obs, { db, ...(channel === 'unmapped' ? { pages: { readPage: async () => ({ kind: 'page' as const, rows: [{ kind: 'unmapped' as const, externalRef: f.external, evidence: { eventKey: obs.eventKey, correlation: obs.correlation } }] }) } } : {}) });
    if (channel === 'webhook') expect(await native.ingest(verification)).toMatchObject({ kind: 'processed' });
    else expect(await native.reconcile(job())).toMatchObject({ status: 200, result: { quarantined: channel === 'unmapped' ? 1 : 0 } });
    expect((await h.owner.query('SELECT status,external_ref,acceptance FROM public.fulfillment_dispatch_refs WHERE id=$1', [f.dispatch])).rows[0]).toMatchObject({ status: 'created', external_ref: f.external, acceptance: { externalRef: f.external } });
    expect(calls.filter(sql => sql.includes('fulfillment_dispatch_finish'))).toHaveLength(1);
    expect(calls.some(sql => /dispatch_begin|dispatch_claim|enqueue_provider_command/u.test(sql))).toBe(false);
    expect(await state(f)).toEqual(before);
    const accepted = (await h.owner.query('SELECT * FROM public.fulfillment_dispatch_refs WHERE id=$1', [f.dispatch])).rows;
    if (channel === 'webhook') expect(await native.ingest(verification)).toMatchObject({ kind: 'processed', replayed: true });
    else expect(await native.reconcile(job())).toMatchObject({ status: 200 });
    expect((await h.owner.query('SELECT * FROM public.fulfillment_dispatch_refs WHERE id=$1', [f.dispatch])).rows).toEqual(accepted);
    expect((await h.owner.query("SELECT * FROM public.shipment_external_refs WHERE shipment_id=$1 AND ref_role='dispatch'", [f.shipment])).rows).toHaveLength(1);
  });
  it('merchant fallback selects the newest recorded dispatch with a deterministic tie-break and refuses contradictory provider identity', async () => {
    const f = await subject(), obs = observation(f, 'picking');
    const newer = randomUUID(), parcel = await replacement(h.owner, f);
    await h.owner.query("UPDATE public.fulfillment_shipments SET created_at='2026-11-01T00:00:00Z' WHERE id=$1", [f.shipment]);
    await h.owner.query("INSERT INTO public.fulfillment_dispatch_refs(id,request_key,shipment_id,order_id,mode,status,evidence) SELECT $2::uuid,$2::text,$3::uuid,order_id,mode,'submitting',evidence FROM public.fulfillment_dispatch_refs WHERE id=$1", [f.dispatch, newer, parcel]);
    const read = async () => (await h.runtime.query('SELECT public.fulfillment_intake_find_dispatch($1,$2) AS value', ['warehouse-a', obs.correlation])).rows[0].value;
    // The provider identity wins over a newer merchant association.
    expect(await read()).toMatchObject({ dispatchRef: f.dispatch, matchedBy: 'provider' });
    obs.correlation.externalRef = 'new-provider-reference';
    expect(await read()).toMatchObject({ dispatchRef: newer, matchedBy: 'merchant' });
    await h.owner.query('UPDATE public.fulfillment_shipments SET created_at=(SELECT created_at FROM public.fulfillment_shipments WHERE id=$2) WHERE id=$1', [f.shipment, parcel]);
    obs.correlation.externalRef = null;
    expect(await read()).toMatchObject({ dispatchRef: [f.dispatch, newer].sort().at(-1), matchedBy: 'merchant' });
    await h.owner.query("UPDATE public.fulfillment_shipments SET created_at='2026-11-01T00:00:00Z' WHERE id=$1", [f.shipment]);
    obs.correlation.externalRef = 'new-provider-reference';
    await h.owner.query('UPDATE public.fulfillment_dispatch_refs SET external_ref=$2 WHERE id=$1', [newer, 'contradictory-reference']);
    const before = await census(f);
    await expect(compose(obs).ingest(verification)).rejects.toThrow('correlation_conflict');
    expect(await compose(obs).reconcile(job())).toMatchObject({ status: 502, result: { failures: 1 } });
    expect(await census(f)).toEqual(before);
  });
  it('ambiguous recorded merchant identities refuse without ACK, evidence or physical effects', async () => {
    const f = await subject(true, false), other = await subject(true, false), obs = observation(f, 'picking');
    await h.owner.query("UPDATE public.commerce_orders SET metadata=jsonb_build_object('orderNumber',$2::text) WHERE id=$1", [other.order, f.orderNumber]);
    await h.owner.query('UPDATE public.fulfillment_dispatch_refs SET external_ref=NULL WHERE id=ANY($1::uuid[])', [[f.dispatch, other.dispatch]]);
    const before = [await census(f), await census(other)];
    await expect(compose(obs).ingest(verification)).rejects.toThrow('correlation_conflict');
    expect(await compose(obs).reconcile(job())).toMatchObject({ status: 502, result: { failures: 1 } });
    expect([await census(f), await census(other)]).toEqual(before);
    expect((await h.owner.query('SELECT acceptance FROM public.fulfillment_dispatch_refs WHERE id=ANY($1::uuid[])', [[f.dispatch, other.dispatch]])).rows).toEqual([{ acceptance: null }, { acceptance: null }]);
  });
  it.each(['merchant-mapped', 'merchant-merchant', 'native-merchant', 'provider-provider'] as const)(
    'refuses every cross-order %s association before ACK or effects on webhook and both polling paths', async collision => {
      const f = await subject(true, false), other = await subject(true, false), obs = observation(f, 'delivered');
      await h.owner.query("UPDATE public.fulfillment_dispatch_refs SET external_ref=NULL,parcel_ref=NULL,status='uncertain' WHERE id=ANY($1::uuid[])", [[f.dispatch, other.dispatch]]);
      if (collision === 'merchant-mapped') {
        await h.owner.query("UPDATE public.commerce_orders SET metadata='{}' WHERE id=$1", [f.order]);
        obs.correlation.orderNumber = f.order;
      }
      await h.owner.query("UPDATE public.commerce_orders SET metadata=jsonb_build_object('orderNumber',$2::text) WHERE id=$1", [other.order, obs.correlation.orderNumber]);
      if (collision === 'native-merchant') obs.correlation.fulfillmentRef = f.shipment;
      if (collision === 'provider-provider') {
        await h.owner.query('UPDATE public.fulfillment_dispatch_refs SET external_ref=$2 WHERE id=$1', [f.dispatch, f.external]);
        obs.correlation.providerFulfillmentRef = `parcel:${other.shipment}`;
        await h.owner.query('UPDATE public.fulfillment_dispatch_refs SET parcel_ref=$2 WHERE id=$1', [other.dispatch, obs.correlation.providerFulfillmentRef]);
      }
      const snapshot = async () => ({ orders: [await census(f), await census(other)],
        dispatches: (await h.owner.query('SELECT * FROM public.fulfillment_dispatch_refs WHERE order_id=ANY($1::uuid[]) ORDER BY id', [[f.order, other.order]])).rows,
        stock: (await h.owner.query('SELECT * FROM public.fulfillment_inventory_reservations WHERE purchase_order_id=ANY($1::uuid[]) ORDER BY id', [[f.order, other.order]])).rows,
        cycles: (await h.owner.query('SELECT * FROM public.subscriptions WHERE id=ANY($1::uuid[]) ORDER BY id', [[f.subscription, other.subscription]])).rows,
        outbox: (await h.owner.query('SELECT * FROM public.outbox_events WHERE aggregate_id=ANY($1::uuid[]) ORDER BY id', [[f.order, other.order]])).rows });
      const before = await snapshot(), calls: string[] = [], errors: string[] = [];
      const db = { query: async (sql: string, values?: unknown[]) => {
        calls.push(sql);
        try { return await h.runtime.query(sql, values); }
        catch (error) { errors.push((error as Error).message); throw error; }
      } };
      const native = compose(obs, { db, orderIdentity: adapterOrderIdentity });
      await expect(native.ingest(verification)).rejects.toThrow('fulfillment_observation_correlation_conflict');
      expect(await native.reconcile(job())).toMatchObject({ status: 502, result: { failures: 1 } });
      const unmapped = compose(obs, { db, orderIdentity: adapterOrderIdentity, pages: { readPage: async () => ({ kind: 'page', rows: [
        { kind: 'unmapped', externalRef: f.external, evidence: { eventKey: obs.eventKey, correlation: obs.correlation } },
      ] }) } });
      expect(await unmapped.reconcile(job())).toMatchObject({ status: 502, result: { failures: 1 } });
      expect(errors).toEqual(Array(3).fill('fulfillment_observation_correlation_conflict'));
      expect(calls.some(sql => /fulfillment_dispatch_finish|fulfillment_intake_record_status|fulfillment_intake_consume_packed|fulfillment_operator_hand_off|fulfillment_intake_record_tracking|fulfillment_operator_record_tracking/u.test(sql))).toBe(false);
      expect(await snapshot()).toEqual(before);
    });
  it.each(['webhook', 'polling'] as const)('checks outbound identity even for a single merchant match through %s', async channel => {
    const f = await subject(true, false), obs = observation(f, 'delivered');
    await h.owner.query('UPDATE public.fulfillment_dispatch_refs SET external_ref=NULL WHERE id=$1', [f.dispatch]);
    const before = await census(f), calls: string[] = [];
    const native = compose(obs, { db: { query: async (sql: string, values?: unknown[]) => { calls.push(sql); return h.runtime.query(sql, values); } },
      orderIdentity: { ...adapterOrderIdentity, outboundOrderNumber: () => 'different-outbound-identity' } });
    if (channel === 'webhook') await expect(native.ingest(verification)).rejects.toThrow('fulfillment_observation_correlation_conflict');
    else expect(await native.reconcile(job())).toMatchObject({ status: 502, result: { failures: 1 } });
    expect(calls.some(sql => /fulfillment_dispatch_finish|fulfillment_intake_record_status/u.test(sql))).toBe(false);
    expect(await census(f)).toEqual(before);
    expect((await h.owner.query('SELECT acceptance FROM public.fulfillment_dispatch_refs WHERE id=$1', [f.dispatch])).rows).toEqual([{ acceptance: null }]);
  });
  it.each(['webhook', 'polling'] as const)('compares the actual outbound order identity with missing metadata through %s', async channel => {
    const f = await subject(), obs = observation(f, 'picking');
    await h.owner.query("UPDATE public.commerce_orders SET metadata='{}' WHERE id=$1", [f.order]);
    obs.correlation.orderNumber = f.order;
    const native = () => compose(obs, { orderIdentity: adapterOrderIdentity });
    if (channel === 'webhook') expect(await native().ingest(verification)).toMatchObject({ kind: 'processed' });
    else expect(await native().reconcile(job())).toMatchObject({ status: 200, result: { quarantined: 0 } });
    // The same outbound fallback can repair a lost ACK using only recorded order/dispatch associations.
    await h.owner.query("UPDATE public.fulfillment_dispatch_refs SET external_ref=NULL,parcel_ref=NULL,acceptance=NULL,status='submitting' WHERE id=$1", [f.dispatch]);
    obs.eventKey = randomUUID(); obs.fact = { ...obs.fact, factId: obs.eventKey };
    if (channel === 'webhook') expect(await native().ingest(verification)).toMatchObject({ kind: 'processed' });
    else expect(await native().reconcile(job())).toMatchObject({ status: 200, result: { quarantined: 0 } });
    const accepted = (await h.owner.query('SELECT * FROM public.fulfillment_dispatch_refs WHERE id=$1', [f.dispatch])).rows;
    if (channel === 'webhook') expect(await native().ingest(verification)).toMatchObject({ kind: 'processed', replayed: true });
    else expect(await native().reconcile(job())).toMatchObject({ status: 200, result: { quarantined: 0 } });
    expect((await h.owner.query('SELECT * FROM public.fulfillment_dispatch_refs WHERE id=$1', [f.dispatch])).rows).toEqual(accepted);
    expect((await h.owner.query("SELECT * FROM public.shipment_external_refs WHERE shipment_id=$1 AND ref_role='dispatch'", [f.shipment])).rows).toHaveLength(1);
    const before = await census(f), wrong = observation(f, 'picking'); wrong.correlation.orderNumber = randomUUID();
    await expect(compose(wrong, { orderIdentity: adapterOrderIdentity }).ingest(verification)).rejects.toThrow('correlation_conflict');
    // A known order UUID is still contradictory when the outbound command used a recorded merchant number.
    await h.owner.query("UPDATE public.commerce_orders SET metadata=jsonb_build_object('orderNumber',$2::text) WHERE id=$1", [f.order, f.orderNumber]);
    await expect(native().ingest(verification)).rejects.toThrow('correlation_conflict');
    expect(await census(f)).toEqual(before);
  });
  it('historical exact dispatch with no external reference stays unfinished; polling quarantines', async () => {
    const f = await subject(), obs = observation(f, 'picking');
    await h.owner.query('UPDATE public.fulfillment_dispatch_refs SET external_ref=NULL,acceptance=NULL WHERE id=$1', [f.dispatch]);
    obs.correlation.externalRef = null; obs.correlation.fulfillmentRef = f.shipment;
    await expect(compose(obs).ingest(verification)).rejects.toThrow('external_ref_missing');
    expect((await h.owner.query('SELECT outcome FROM public.fulfillment_observations WHERE event_key=$1', [obs.eventKey])).rows[0].outcome).toBeNull();
    const result = await compose(obs).reconcile(job()); expect(result).toMatchObject({ kind: 'finished', result: { quarantined: 1 } });
    expect((await h.owner.query("SELECT outcome FROM public.fulfillment_observations WHERE event_key=$1", [`quarantine:${obs.eventKey}`])).rows[0].outcome.reason).toBe('missing_external_ref');
  });
  it('early stages are evidence only; packed consumes accepted exact reservations without creating a label or handoff', async () => {
    const f = await subject();
    for (const status of ['provider_received', 'picking'] as const) {
      expect(await compose(observation(f, status)).ingest(verification)).toMatchObject({ kind: 'processed' }); expect((await state(f)).status).toBe('created');
    }
    const product = randomUUID(), skuId = randomUUID(), source = randomUUID(), sku = `SKU-${randomUUID()}`;
    await h.owner.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1::uuid,$1::text,'Unit')", [product]);
    await h.owner.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES($1,$2,$3,'Unit')", [skuId, product, sku]);
    await h.owner.query('UPDATE public.commerce_order_items SET sku_id=$2 WHERE order_id=$1', [f.order, skuId]);
    await h.owner.query("INSERT INTO public.fulfillment_stock_current(source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,inventory_class,last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint) VALUES($1,$2,100,100,0,'sellable',$3,'2099-01-01T00:00:00Z',$1,$1,repeat('a',64))", [source, sku, at]);
    const item = (await h.owner.query('SELECT id FROM public.commerce_order_items WHERE order_id=$1', [f.order])).rows[0].id;
    const reserve = async () => (await h.runtime.query("SELECT public.fulfillment_reserve_purchase_order_items($1,$2,$3,$4,'succeeded','2099-01-01T00:00:00Z','{}',$5) AS value", [randomUUID(), f.order, source, JSON.stringify([{ orderItemId: item, skuId, quantity: 1 }]), at])).rows[0].value.reservations[0].reservationId;
    const reservation = await reserve();
    const line = (await h.owner.query('INSERT INTO public.fulfillment_parcel_lines(shipment_id,order_item_id,sku_id,sku,quantity) VALUES($1,$2,$3,$4,1) RETURNING id', [f.shipment, item, skuId, sku])).rows[0].id;
    await h.owner.query('INSERT INTO public.fulfillment_parcel_line_reservations(line_id,reservation_id,quantity) VALUES($1,$2,1)', [line, reservation]);
    const invoice = vi.fn(); const obs = observation(f, 'packed');
    expect(await compose(obs, { accounting: { issue: invoice, classify: () => ({ permanent: false, identifier: null, sqlstate: null, benign: false }) } }).ingest(verification)).toMatchObject({ kind: 'processed' });
    expect(await state(f)).toMatchObject({ status: 'packed', handed_over_at: null, delivered_at: null }); expect(invoice).not.toHaveBeenCalled();
    expect((await h.owner.query('SELECT status FROM public.fulfillment_inventory_reservations WHERE id=$1', [reservation])).rows[0].status).toBe('consumed');
    expect((await h.owner.query("SELECT * FROM public.shipment_external_refs WHERE shipment_id=$1 AND ref_role='label'", [f.shipment])).rows).toEqual([]);
    expect(await compose(obs).ingest(verification)).toMatchObject({ kind: 'processed', replayed: true });
  });
  it('physical effects commit before accounting and webhook accounting failures are fail-soft', async () => {
    const f = await subject(), obs = observation(f); let observed = false;
    const issue = async () => {
      expect(await state(f)).toMatchObject({ status: 'in_transit' });
      const client = await h.owner.connect();
      try { await client.query('BEGIN'); expect((await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('native-dispatch|'||$1,0)) AS acquired", [f.shipment])).rows[0].acquired).toBe(true); }
      finally { await client.query('ROLLBACK'); client.release(); }
      observed = true; throw new Error('synthetic_invoice_failure');
    };
    expect(await compose(obs, { accounting: { issue, classify: () => ({ permanent: false, identifier: null, sqlstate: null, benign: false }) } }).ingest(verification)).toMatchObject({ kind: 'processed' });
    expect(observed).toBe(true); expect((await notices(f)).rows).toHaveLength(1);
  });
  it('delivered evidence without references keeps arrival/alignment untouched and independently heals an eligible hold', async () => {
    await h.owner.query("SELECT public.subscription_delivery_alignment_set_mode('auto_align')");
    const f = await subject(), exception = observation(f, 'exception', earlier, []);
    const first = await compose(exception).reconcile(job()); expect(first).toMatchObject({ result: { exceptions: 1 } });
    await h.owner.query("UPDATE public.fulfillment_shipments SET status='handed_over',handed_over_at=$2 WHERE id=$1", [f.shipment, earlier]);
    const beforeAlignment = (await h.owner.query('SELECT * FROM public.subscription_delivery_alignment_cases WHERE subscription_id=$1 ORDER BY id', [f.subscription])).rows;
    const beforeCycle = (await h.owner.query('SELECT next_cycle_at,status FROM public.subscriptions WHERE id=$1', [f.subscription])).rows;
    expect(beforeAlignment).toEqual([expect.objectContaining({state:'protected'})]);
    const delivered = observation(f, 'delivered', at, []);
    expect(await compose(delivered).ingest(verification)).toMatchObject({ kind: 'processed', trackingRefs: 0, trackingReadBacks: 0 });
    expect(await state(f)).toMatchObject({ status: 'handed_over', delivered_at: null });
    expect((await proofs(f)).rows).toEqual(expect.arrayContaining([expect.objectContaining({ canonical_status: 'delivered' })]));
    expect((await h.owner.query('SELECT status FROM public.commerce_order_holds WHERE order_id=$1', [f.order])).rows).toEqual([{ status: 'released' }]);
    expect((await h.owner.query('SELECT * FROM public.subscription_delivery_alignment_cases WHERE subscription_id=$1 ORDER BY id', [f.subscription])).rows).toEqual(beforeAlignment);
    expect((await h.owner.query('SELECT next_cycle_at,status FROM public.subscriptions WHERE id=$1', [f.subscription])).rows).toEqual(beforeCycle);
    expect((await notices(f)).rows).toHaveLength(0);
    expect((await h.runtime.query('SELECT public.subscription_delivery_alignment_admit_renewal($1,$2,now()) AS value', [f.subscription, beforeCycle[0].next_cycle_at])).rows[0].value).toMatchObject({allowed:false,state:'protected'});
    expect(await compose(delivered).ingest(verification)).toMatchObject({ kind: 'processed', trackingRefs: 0 }); expect((await state(f)).delivered_at).toBeNull();
    expect(await compose(observation(f, 'delivered', later, ['LATER-REF'])).ingest(verification)).toMatchObject({ kind: 'processed' }); expect((await state(f)).status).toBe('delivered');
    expect((await notices(f)).rows).toHaveLength(0); expect((await notices(f, 'commerce.shipment.delivered')).rows).toHaveLength(1);
  });
  it('multi-reference tracking retains each projection/readback; polling effects use revised snapshots for the same occurrence', async () => {
    const f = await subject(), obs = observation(f, 'in_transit', at, []), request = job();
    expect(await compose(obs).reconcile(request)).toMatchObject({ result: { trackingRefs: 0 } }); expect((await notices(f)).rows).toHaveLength(0);
    const revised = { ...obs, trackingRefs: observation(f, 'in_transit', at, ['REF-ONE', 'REF-TWO']).trackingRefs };
    expect(await compose(revised).reconcile(request)).toMatchObject({ result: { trackingRefs: 2, readBacks: 2, replayed: expect.any(Number) } });
    expect((await proofs(f)).rows).toHaveLength(1); expect((await notices(f)).rows).toHaveLength(1);
    const refs = (await h.owner.query("SELECT external_id,carrier_ref,service_ref,public_url FROM public.shipment_external_refs WHERE shipment_id=$1 AND ref_role='tracking' ORDER BY external_id", [f.shipment])).rows;
    expect(refs).toEqual(['REF-ONE', 'REF-TWO'].map(external_id => ({ external_id, carrier_ref: 'carrier', service_ref: 'service', public_url: `https://tracking.example.invalid/${external_id}` })));
    expect(await compose(revised).reconcile(request)).toMatchObject({ result: { trackingRefs: 0, readBacks: 2 } });
  });
  it('settles terminal tracking regression as superseded while retaining the independent reference', async () => {
    const f = await subject(), first = observation(f, 'delivered', at, [`FIRST-${f.shipment}`]);
    await compose(first).ingest(verification);
    const next = observation(f, 'in_transit', later, [`LATER-${f.shipment}`]);
    expect(await compose(next).ingest(verification)).toMatchObject({ kind: 'superseded', supersededCause: 'tracking_after_delivered_forbidden' });
    expect((await h.owner.query('SELECT outcome FROM public.fulfillment_observations WHERE event_key=$1', [next.eventKey])).rows[0].outcome).toEqual({ status: 'processed', supersededCause: 'tracking_after_delivered_forbidden' });
    expect(await compose(next).ingest(verification)).toMatchObject({ kind: 'superseded', replayed: true });
    await expect(compose(next).commands!.recordCommerceFulfillmentTrackingEvent({ idempotencyKey: randomUUID(), fulfillmentOrderId: f.shipment, actorUserId: randomUUID(), status: 'in_transit' })).rejects.toMatchObject({ details: { code: 'tracking_after_delivered_forbidden' } });
    expect((await h.owner.query("SELECT external_id FROM public.shipment_external_refs WHERE shipment_id=$1 AND external_id=$2", [f.shipment, `LATER-${f.shipment}`])).rows).toHaveLength(1);
    expect(await state(f)).toMatchObject({ status: 'delivered' });
    expect(new Date((await state(f)).delivered_at).toISOString()).toBe(at);
  });
  it.each(['stock_consumed_requires_label', 'fulfillment_not_found'] as const)('keeps %s retryable on webhook while polling quarantines it', async reason => {
    const f = await subject(), obs = observation(f), before = await state(f);
    const db = { query: async (sql: string, values?: unknown[]) => {
      if (sql.includes('fulfillment_intake_consume_packed')) {
        if (reason === 'fulfillment_not_found') return h.runtime.query(sql, [values![0], randomUUID()]);
        await h.owner.query("DELETE FROM public.shipment_external_refs WHERE shipment_id=$1 AND ref_role='dispatch'", [f.shipment]);
      }
      return h.runtime.query(sql, values);
    } };
    await expect(compose(obs, { db }).ingest(verification)).rejects.toThrow(reason);
    expect((await h.owner.query('SELECT outcome FROM public.fulfillment_observations WHERE event_key=$1', [obs.eventKey])).rows[0].outcome).toBeNull();
    expect(await state(f)).toEqual(before);
    expect(await compose(obs, { db }).reconcile(job())).toMatchObject({ status: 200, result: { stateConflicts: 1, quarantined: 1 } });
    expect(await state(f)).toEqual(before);
    if (reason === 'stock_consumed_requires_label') await h.owner.query("INSERT INTO public.shipment_external_refs(shipment_id,ref_role,external_id) VALUES($1,'dispatch',$2)", [f.shipment, f.external]);
    expect(await compose(obs).ingest(verification)).toMatchObject({ kind: 'processed', replayed: true });
  });
  it.each(['webhook', 'polling'] as const)('preserves original delivery bytes and the resulting cycle extension through %s', async channel => {
    for (const raw of ['2026-11-10T12:00:00+0200', '2026-11-10T12:00Z', '2026-11-10T12:00:00', '2026-11-10T12:00:00+02:00']) {
      const f = await subject(); await openCase(h.owner, f);
      const obs = observation(f, 'delivered', raw), native = compose(obs);
      const before = (await h.owner.query('SELECT now() AS t,next_cycle_at FROM public.subscriptions WHERE id=$1', [f.subscription])).rows[0];
      if (channel === 'webhook') expect(await native.ingest(verification)).toMatchObject({ kind: 'processed' });
      else expect(await native.reconcile(job())).toMatchObject({ status: 200, result: { trackingRefs: 1 } });
      const parcel = await state(f), delivered = new Date(parcel.delivered_at);
      if (raw.endsWith('+02:00')) expect(delivered.toISOString()).toBe('2026-11-10T10:00:00.000Z');
      else expect(delivered.getTime()).toBeGreaterThanOrEqual(new Date(before.t).getTime());
      const rawEvent = (await h.owner.query("SELECT command#>'{request,rawEvent}' AS raw_event FROM public.fulfillment_operator_receipts WHERE kind='tracking' AND command->>'shipmentId'=$1", [f.shipment])).rows[0].raw_event;
      expect(rawEvent.occurredAt).toBe(raw);
      const next = (await h.owner.query('SELECT next_cycle_at,status FROM public.subscriptions WHERE id=$1', [f.subscription])).rows[0];
      expect(next).toEqual({ status: 'active', next_cycle_at: new Date(Math.max(new Date(before.next_cycle_at).getTime(), delivered.getTime() + 28 * 86400000)) });
      const after = await census(f);
      if (channel === 'webhook') await native.ingest(verification); else await native.reconcile(job());
      expect(await census(f)).toEqual(after);
      expect((await h.owner.query('SELECT next_cycle_at,status FROM public.subscriptions WHERE id=$1', [f.subscription])).rows[0]).toEqual(next);
    }
  });
  it('missing provider classification refuses even when both nullable identity operands are NULL', async () => {
    const f = await subject(), obs = observation(f, 'picking');
    await h.owner.query("UPDATE public.fulfillment_dispatch_refs SET evidence=evidence-'providerRef' WHERE id=$1", [f.dispatch]);
    const before = await census(f);
    await expect(h.runtime.query('SELECT public.fulfillment_intake_record_status($1,$2,$3,$4,$5)',
      [obs.eventKey, f.dispatch, f.shipment, 'picking', { ...obs, fact: { ...obs.fact, providerKind: null } }])).rejects.toThrow('fulfillment_status_evidence_correlation');
    expect(await census(f)).toEqual(before);
  });
  it('historical NULL proof classification cannot release a scoped hold', async () => {
    const f = await subject(), exception = observation(f, 'exception', earlier, []), legacy = observation(f, 'picking', later, []);
    await compose(exception).reconcile(job());
    await h.runtime.query('SELECT public.fulfillment_intake_record_observation($1,$2,$3,$4)', [legacy.eventKey, f.shipment, legacy, at]);
    await h.owner.query('INSERT INTO public.fulfillment_operator_status_evidence(event_key,shipment_id,occurred_at) VALUES($1,$2,$3)', [legacy.eventKey, f.shipment, later]);
    const before = await census(f);
    expect((await h.runtime.query("SELECT public.fulfillment_intake_heal_exception($1,$2,'{}') AS value", [legacy.eventKey, f.shipment])).rows[0].value).toEqual({ released: 0 });
    expect(await census(f)).toEqual(before); expect(before.holds[0].status).toBe('active');
  });
  it('stale status skips effects and off-track known/unmapped evidence skips ACK and quarantine alarms', async () => {
    const f = await subject(), obs = observation(f, 'picking', later, []); await compose(obs).reconcile(job());
    const before = await census(f); expect(await compose(observation(f, 'in_transit', earlier)).reconcile(job())).toMatchObject({ result: { stale: 1 } }); expect(await census(f)).toEqual(before);
    await h.owner.query("UPDATE public.fulfillment_shipments SET status='cancelled' WHERE id=$1", [f.shipment]);
    await h.owner.query("UPDATE public.fulfillment_dispatch_refs SET status='submitting',acceptance=NULL WHERE id=$1", [f.dispatch]);
    const known = observation(f, 'delivered', later, []);
    expect(await compose(known).reconcile(job())).toMatchObject({ result: { offTrackSkips: 1, quarantined: 0 } });
    expect((await state(f)).status).toBe('cancelled'); expect((await proofs(f)).rows).toHaveLength(2);
    const unmapped: FulfillmentReconciliationObservation = { kind: 'unmapped', externalRef: f.external, evidence: { eventKey: randomUUID(), correlation: known.correlation } };
    expect(await compose(known, { pages: { readPage: async () => ({ kind: 'page', rows: [unmapped] }) } }).reconcile(job())).toMatchObject({ result: { offTrackSkips: 1, quarantined: 0 } });
    expect((await h.owner.query('SELECT status FROM public.fulfillment_dispatch_refs WHERE id=$1', [f.dispatch])).rows[0].status).toBe('submitting');
  });
  it('exception replay after release never recreates a hold and never rewrites the parcel FSM', async () => {
    const f = await subject(), obs = observation(f, 'exception', earlier, []), request = job();
    expect(await compose(obs).reconcile(request)).toMatchObject({ result: { exceptions: 1 } }); expect((await state(f)).status).toBe('created');
    expect((await notices(f, 'commerce.shipment.exception')).rows).toHaveLength(1);
    await compose(observation(f, 'picking', at, [])).reconcile(request);
    const before = await census(f); expect(before.holds[0].status).toBe('released');
    // A direct exact exception replay survives audited release (poll chronology would skip it).
    await h.runtime.query('SELECT public.fulfillment_intake_record_exception($1,$2,\'provider_exception\',$3)', [keys.exception(f.shipment, obs.intake!.occurrenceKey), f.shipment, obs]);
    expect(await census(f)).toEqual(before); expect((await notices(f, 'commerce.shipment.exception')).rows).toHaveLength(1);
  });
  it('terminal, unclassified, unknown-time and human holds never auto-heal; delivery-only needs delivered proof', async () => {
    for (const mode of ['manual', 'unknown_time', 'unclassified', 'human', 'delivery_only'] as const) {
      const f = await subject(), obs = observation(f, 'exception', mode === 'unknown_time' ? null : earlier, []);
      obs.intake!.recovery = mode === 'manual' ? 'manual' : mode === 'delivery_only' ? 'delivery_only' : 'provider_recovered';
      await compose(obs).reconcile(job());
      if (mode === 'unclassified') await h.owner.query("UPDATE public.commerce_order_holds SET metadata='{}' WHERE order_id=$1", [f.order]);
      if (mode === 'human') {
        const actor = randomUUID(); await h.owner.query("INSERT INTO public.commerce_operators(id,label) VALUES($1,'Human')", [actor]);
        await h.owner.query('UPDATE public.commerce_order_holds SET created_by=$2 WHERE order_id=$1', [f.order, actor]);
      }
      await compose(observation(f, 'picking', at, [])).reconcile(job());
      expect((await h.owner.query('SELECT status FROM public.commerce_order_holds WHERE order_id=$1', [f.order])).rows[0].status).toBe('active');
      if (mode === 'delivery_only') { await compose(observation(f, 'delivered', later, [])).reconcile(job()); expect((await h.owner.query('SELECT status FROM public.commerce_order_holds WHERE order_id=$1', [f.order])).rows[0].status).toBe('released'); }
    }
  });
  it('competing eligible proofs release exactly once and late exception notices stay suppressed after durable handoff', async () => {
    const f = await subject(); await compose(observation(f, 'in_transit', earlier)).ingest(verification);
    const obs = observation(f, 'exception', at, []); await compose(obs).reconcile(job());
    expect((await notices(f, 'commerce.shipment.exception')).rows).toHaveLength(0);
    await Promise.all([compose(observation(f, 'picking', later, [])).reconcile(job()), compose(observation(f, 'delivered', later, [])).ingest(verification)]);
    expect((await h.owner.query("SELECT * FROM public.commerce_order_operations WHERE order_id=$1 AND operation_type='hold_released'", [f.order])).rows).toHaveLength(1);
  });
  it('lease precedes checkpoint and GET; full failed pages advance, short/empty reset, checkpoint-read failure writes no replacement checkpoint', async () => {
    const f = await subject(), obs = observation(f, 'picking'), events: string[] = [], finishes: unknown[] = [];
    let checkpoint: unknown = { reconciliationPagination: { version: 1, page: 1, pageSize: 2, nextPage: 2 } };
    const real = job().ledger;
    const ledger: PlatformJobRunLedgerPort = { ...real,
      claimJobRun: async () => { events.push('lease'); return { acquired: true, runId: randomUUID(), reason: 'acquired' }; },
      readLatestTerminalRunMetadata: async () => { events.push('checkpoint'); return checkpoint as Record<string, unknown>; },
      finishJobRun: async (...args) => { events.push('finish'); finishes.push(args); return true; },
    };
    let rows: readonly FulfillmentReconciliationObservation[] = [row(obs), { kind: 'unknown', refusal: { reason: 'malformed', phase: 'normalize', retryable: false } }];
    const native = compose(obs, { pages: { readPage: async ({ page }) => { events.push(`GET:${page}`); return { kind: 'page', rows }; } } });
    expect(await native.reconcile(job(ledger, 2))).toMatchObject({ status: 502, metadata: { reconciliationPagination: { page: 2, nextPage: 3 } } }); expect(events).toEqual(['lease', 'checkpoint', 'GET:2', 'finish']);
    rows = [row(obs)]; expect(await native.reconcile(job(ledger, 2))).toMatchObject({ metadata: { reconciliationPagination: { nextPage: 0 } } });
    rows = []; expect(await native.reconcile(job(ledger, 2))).toMatchObject({ metadata: { reconciliationPagination: { nextPage: 0 } } });
    for (const invalid of [null, {}, { reconciliationPagination: { version: 1, pageSize: 3, page: 1, nextPage: 2 } }, { reconciliationPagination: { version: 1, pageSize: 2, page: 1, nextPage: 99 } }]) {
      checkpoint = invalid; expect(await native.reconcile(job(ledger, 2))).toMatchObject({ metadata: { reconciliationPagination: { page: 0 } } });
    }
    events.length = 0; finishes.length = 0;
    ledger.readLatestTerminalRunMetadata = async () => { events.push('checkpoint'); throw new Error('synthetic_checkpoint_failure'); };
    expect(await native.reconcile(job(ledger, 2))).toMatchObject({ kind: 'failed', reason: 'reconciliation_checkpoint_read_failed' }); expect(events).toEqual(['lease', 'checkpoint', 'finish']); expect((finishes[0] as unknown[])[5]).toBeUndefined();
    ledger.claimJobRun = async () => ({ acquired: false, runId: null, reason: 'lease_busy' }); events.length = 0;
    expect(await native.reconcile(job(ledger))).toEqual({ kind: 'skipped', reason: 'lease_busy' }); expect(events).toEqual([]);
  });
  it('native fatal zero-scan failure resets to zero while the generic helper remains unchanged', async () => {
    const f = await subject(), obs = observation(f), request = job();
    const ledger: PlatformJobRunLedgerPort = { ...request.ledger, claimJobRun: async () => ({ acquired: true, runId: randomUUID(), reason: 'acquired' }),
      readLatestTerminalRunMetadata: async () => ({ reconciliationPagination: { version: 1, pageSize: 50, page: 2, nextPage: 3 } }), finishJobRun: async () => true };
    expect(await compose(obs, { pages: { readPage: async () => { throw new Error('synthetic_page_failure'); } } }).reconcile(job(ledger))).toMatchObject({ status: 502, metadata: { reconciliationPagination: { page: 3, nextPage: 0 } } });
  });
  it('polling distinguishes transient invoice errors from permanent refusals after physical effects', async () => {
    for (const permanent of [false, true]) {
      const f = await subject(), obs = observation(f);
      const request = job();
      const result = await compose(obs, { accounting: { issue: async () => { expect((await state(f)).status).toBe('in_transit'); throw new Error('synthetic_invoice_failure'); },
        classify: () => ({ permanent, identifier: 'invoice_not_eligible', sqlstate: '22023', benign: true }) } }).reconcile(request);
      const metadata = (await h.owner.query('SELECT metadata FROM public.platform_job_runs WHERE job_name=$1', [request.jobName])).rows[0].metadata;
      expect(metadata).toMatchObject({ invoiceIssueFailures: permanent ? 0 : 1, invoiceIssueRefused: permanent ? 1 : 0, checked: 1 });
      expect(result).toMatchObject({ status: permanent ? 200 : 502, result: { invoiceIssueFailures: permanent ? 0 : 1, invoiceIssueRefused: permanent ? 1 : 0 } });
      expect((await state(f)).status).toBe('in_transit');
    }
  });
  it('missing envelope/reservations and unattributed cross-order references refuse without forbidden mutation', async () => {
    const f = await subject(false), obs = observation(f, 'packed');
    await expect(compose(obs).ingest(verification)).rejects.toThrow('fulfillment_parcel_reservations_not_recorded'); expect((await state(f)).status).toBe('created');
    const old = observation(f); await h.owner.query('INSERT INTO public.fulfillment_observations(event_key,observation,first_received_at) VALUES($1,\'{}\',$2)', [old.eventKey, at]);
    await expect(compose(old).ingest(verification)).rejects.toThrow('observation_evidence_not_recorded');
    const malformed = observation(f);
    await h.owner.query('INSERT INTO public.fulfillment_observations(event_key,observation,first_received_at) VALUES($1,$2,$3)',
      [malformed.eventKey, { eventKey: malformed.eventKey, fact: { rawEvent: malformed.fact.rawEvent } }, at]);
    await expect(compose(malformed).ingest(verification)).rejects.toThrow('observation_evidence_not_recorded');
    expect((await state(f)).status).toBe('created');
    const recorded = await subject(), other = await subject(), track = `TRACK-${randomUUID()}`;
    await h.owner.query("INSERT INTO public.shipment_external_refs(shipment_id,ref_role,external_id) VALUES($1,'tracking',$2)", [other.shipment, track]);
    const beforeOther = await census(other); await expect(compose(observation(recorded, 'in_transit', at, [track])).ingest(verification)).rejects.toThrow('tracking_reference_unattributed'); expect(await census(other)).toEqual(beforeOther);
  });
  it('contention annotations close only exact unfinished packed receipts after stock proof; bookkeeping is fail-soft', async () => {
    const f = await subject(), picked = observation(f, 'packed');
    await h.runtime.query('SELECT public.fulfillment_intake_record_observation($1,$2,$3,$4)', [picked.eventKey, f.shipment, picked, at]);
    await h.runtime.query('SELECT public.fulfillment_intake_annotate_stock_contention($1,$2)', [picked.eventKey, f.shipment]);
    expect((await h.runtime.query('SELECT public.fulfillment_intake_close_recovered_picked($1) AS count', [f.shipment])).rows[0].count).toBe(0);
    await compose(observation(f, 'in_transit', later)).ingest(verification);
    expect((await h.owner.query('SELECT outcome FROM public.fulfillment_observations WHERE event_key=$1', [picked.eventKey])).rows[0].outcome).toEqual({ status: 'processed' });
    const g = await subject(), obs = observation(g);
    const failingBookkeeping = { query: async (sql: string, values?: unknown[]) => { if (sql.includes('fulfillment_intake_close_recovered_picked')) throw new Error('synthetic_bookkeeping_failure'); return h.runtime.query(sql, values); } };
    expect(await compose(obs, { db: failingBookkeeping }).ingest(verification)).toMatchObject({ kind: 'processed' }); expect((await state(g)).status).toBe('in_transit');
  });
  it('binds unchanged operator commands, preserves historical zero consumption and earlier-only delivery replay', async () => {
    const f = await subject(false), native = compose(observation(f)); const actor = randomUUID();
    await h.owner.query('INSERT INTO public.platform_human_principals(principal_id,email) VALUES($1,$2)', [actor, `${actor}@example.invalid`]);
    await native.commands!.recordCommerceFulfillmentLabel({ idempotencyKey: randomUUID(), fulfillmentOrderId: f.shipment, actorUserId: actor, providerKind: 'warehouse-a', providerTrackingId: 'OPERATOR-REF', labelUrl: 'https://labels.example.invalid/unit' });
    expect(await native.commands!.handOffCommerceFulfillmentOrder({ idempotencyKey: randomUUID(), fulfillmentOrderId: f.shipment, actorUserId: actor })).toMatchObject({ reservationDisposition: 'reservations_not_recorded', consumedReservationCount: 0 });
    const key = randomUUID(), command = { idempotencyKey: key, fulfillmentOrderId: f.shipment, actorUserId: actor, status: 'delivered' as const, providerTrackingId: 'OPERATOR-REF', rawEvent: { occurredAt: later } };
    await native.commands!.recordCommerceFulfillmentTrackingEvent(command);
    await native.commands!.recordCommerceFulfillmentTrackingEvent({ ...command, rawEvent: { occurredAt: at } }); expect(new Date((await state(f)).delivered_at).toISOString()).toBe(at);
    await native.commands!.recordCommerceFulfillmentTrackingEvent(command); expect(new Date((await state(f)).delivered_at).toISOString()).toBe(at);
  });
  it('closed intake entrypoints refuse browser execution and retain existing status-evidence RLS and table ACLs', async () => {
    const routines = (await h.owner.query("SELECT oid::regprocedure::text AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'fulfillment_intake_%' ORDER BY oid")).rows;
    for (const { signature } of routines) for (const role of ['anon', 'authenticated']) expect((await h.owner.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS allowed', [role, signature])).rows[0].allowed).toBe(false);
    for (const table of ['fulfillment_observations', 'fulfillment_operator_status_evidence', 'shipment_external_refs']) for (const role of ['anon', 'authenticated'])
      expect((await h.owner.query("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') AS allowed", [role, `public.${table}`])).rows[0].allowed).toBe(false);
    expect((await h.owner.query("SELECT relrowsecurity FROM pg_class WHERE oid IN ('public.fulfillment_operator_status_evidence'::regclass)")).rows.every(row => row.relrowsecurity)).toBe(true);
  });
});

it('capture/restore retains nullable reference metadata and closed status classification columns byte-for-byte', async () => {
  const resources = storeJourneyResources();
  try {
    const source = await resources.installation('intake-source'), target = await resources.installation('intake-target'), f = await fixture(source.owner);
    const event = randomUUID();
    await source.owner.query("INSERT INTO public.fulfillment_observations(event_key,shipment_id,observation,first_received_at) VALUES($1,$2,'{}',$3)", [event, f.shipment, at]);
    await source.owner.query("INSERT INTO public.fulfillment_operator_status_evidence(event_key,shipment_id,provider_status,occurred_at,occurrence_key,canonical_status,recovery_classification) VALUES($1,$2,'exception',$3,'occurrence','exception','delivery_only')", [event, f.shipment, at]);
    await source.owner.query("INSERT INTO public.shipment_external_refs(shipment_id,ref_role,external_id,provider_kind,carrier_ref,service_ref,public_url) VALUES($1,'tracking','TRACK-TRANSFER','warehouse-a','carrier',NULL,'https://tracking.example.invalid/unit')", [f.shipment]);
    const packet = await captureStoreJourney(source.owner, 'intake-source'), freshTarget = await captureStoreJourney(target.owner, 'intake-target');
    await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget });
    for (const table of ['shipment_external_refs', 'fulfillment_operator_status_evidence']) {
      const rows = (await target.owner.query(`SELECT to_jsonb(t)::text AS row FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows.map(r => r.row);
      expect(rows).toEqual(packet.owned.find(t => t.table === table)!.rows);
    }
    expect(await restoreConnectedNativeStore({ owner: target.owner, installation: journeySelection, packet, freshTarget })).toMatchObject({ replayed: true });
  } finally { await resources.close(); }
}, postgresSetupTimeoutMs);
