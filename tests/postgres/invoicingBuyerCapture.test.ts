import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresBillingInvoiceStore, mapInvoiceClaimToProviderSnapshot } from '@openlup/platform/invoicing';
import { createCapturedPostgresInvoiceProvider } from '@openlup/platform/invoicing/postgres';
import { createPostgresSandboxPaymentSimulator } from '@openlup/platform/payments';
import { createPostgresDestinationPort } from '@openlup/platform/commerce/server/destinations';
import type { InvoiceBuyerSelection, InvoiceFacts } from '@openlup/platform/invoicing/contracts';
import { installAccountMutations, type AccountProfile } from './customerAccountMutations.fixture.js';
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from '../helpers/postgresContainer.js';

type Db = Awaited<ReturnType<typeof installAccountMutations>>;
const profiles: AccountProfile[] = ['legacy', 'bootstrap', 'separate', 'admin-managed', 'admin-operator'];
const at = new Date().toISOString();
const seller = { read: async () => ({ kind: 'found' as const, revisionRef: 'seller-v1', seller: {
  name: 'Example Seller', address: { line1: 'Seller 1', city: 'Example', postalCode: '12345' },
  taxIdentifier: { scheme: 'synthetic', value: '123' }, bankAccount: null, routingRef: null,
} }) };
async function subject(db: Db) {
  const client = randomUUID();
  await db.owner.query('INSERT INTO public.clients(id,email,first_name,last_name,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)',
    [client, `${client}@example.invalid`, 'Example', 'Customer', at]);
  return client;
}
async function profile(db: Db, client: string) {
  const id = randomUUID(), address = randomUUID();
  await db.owner.query("INSERT INTO public.customer_orderer_profiles(id,client_id,full_name,email,is_default,created_at,updated_at) VALUES($1,$2,'Profile Buyer','billing@example.invalid',true,$3,$3)", [id, client, at]);
  await db.owner.query("INSERT INTO public.customer_saved_addresses(id,client_id,kind,line1,line2,city,postal_code,country,is_default,created_at,updated_at) VALUES($1,$2,'both','Billing 1','Billing unit 2','Example','12345','ZZ',true,$3,$3)", [address, client, at]);
  return { id, address };
}
async function order(db: Db, client: string, metadata = {}, withDestination = true) {
  const id = randomUUID();
  const c = await db.owner.connect();
  try {
    await c.query('BEGIN');
    await c.query("INSERT INTO public.commerce_orders(id,client_id,status,currency_code,total_amount_minor,metadata,created_at,updated_at) VALUES($1,$2,'pending_payment','XXX',100,$3,$4,$4)", [id, client, metadata, at]);
    await c.query('INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,100,100)', [id]);
    await c.query('COMMIT');
  } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
  if (withDestination) await createPostgresDestinationPort(db.runtime).registerOrder({ idempotencyKey: randomUUID(), orderId: id,
    address: { recipientName: 'Shipping Buyer', line1: 'Shipping 1', line2: 'Shipping unit 2', city: 'Example', postalCode: '12345', country: 'ZZ' }, now: at });
  return id;
}
const request = (id: string) => ({ requestKey: randomUUID(), sourceKind: 'paid' as const, sourceId: randomUUID(), orderId: id,
  evidence: { settlementIntentId: randomUUID(), amountMinor: 100, currency: 'XXX' }, occurredAt: at });
async function capture(db: Db, input: ReturnType<typeof request>) {
  return (await db.runtime.query('SELECT public.invoicing_capture_duty($1,$2,$3,$4,$5,$6) AS value',
    [input.requestKey, input.sourceKind, input.sourceId, input.orderId, input.evidence, input.occurredAt])).rows[0].value as { dutyId: string; status: string };
}
const rows = async (db: Db, duty: string) => ({
  duty: (await db.owner.query('SELECT to_jsonb(d) AS row,d.xmin::text FROM public.invoicing_duties d WHERE id=$1', [duty])).rows,
  buyer: (await db.owner.query('SELECT to_jsonb(s) AS row,s.xmin::text FROM public.invoicing_buyer_snapshots s WHERE duty_id=$1', [duty])).rows,
  receipts: (await db.owner.query('SELECT to_jsonb(r) AS row,r.xmin::text FROM public.invoicing_effect_receipts r WHERE duty_id=$1 ORDER BY receipt_key', [duty])).rows,
});
function facts(id: string, buyer: InvoiceBuyerSelection): InvoiceFacts {
  if (!buyer.name) throw Error('buyer name required');
  return { factRevision: `facts:${id}`, policyVersion: 'synthetic', refs: { orderId: id, orderRef: id, invoiceRef: `invoice:${id}` },
    dates: { issueDate: at.slice(0, 10), sellDate: at.slice(0, 10), handedOverAt: null, paymentCompletedAt: at },
    documentKind: 'synthetic', clearanceRequired: false, currency: 'XXX', buyer: { ...buyer, name: buyer.name, taxIdentifier: null },
    payment: { intentRef: randomUUID(), providerRef: 'synthetic', providerPaymentRef: null, amountMinor: 100, currency: 'XXX', localSettlementState: 'matched' },
    orderMoney: null, lines: [{ description: 'Item', quantity: 1, unitNetMinor: 100, unitGrossMinor: 100, totalNetMinor: 100,
      totalTaxMinor: 0, totalGrossMinor: 100, taxRateBps: 0, positionKind: 'item', catalogTotalGrossMinor: 100,
      discountAllocatedMinor: 0, shippingGrossMinor: null, shippingDiscountMinor: null }],
    totalNetMinor: 100, totalTaxMinor: 0, totalGrossMinor: 100, chargedTotalGrossMinor: 100 };
}
for (const installation of profiles) describe(`invoicing first-duty buyer on ${installation}`, () => {
  let db: Db;
  beforeAll(async () => { db = await installAccountMutations(installation, false, 'buyer-capture'); }, postgresSetupTimeoutMs);
  afterAll(async () => db?.close(), postgresTeardownTimeoutMs);
  it.each(['explicit', 'profile', 'fallback'] as const)('freezes %s on first capture and replays without any rewrite', async source => {
    const client = await subject(db), saved = source !== 'fallback' ? await profile(db, client) : null;
    const explicit = { name: 'Explicit Buyer', email: 'explicit@example.invalid', companyName: null, taxId: null, source: 'order_buyer',
      address: { line1: 'Explicit 1', line2: 'Explicit unit 2', city: 'Example', postalCode: '12345', country: 'ZZ', source: 'order_address' } };
    const id = await order(db, client, source === 'explicit' ? { invoiceBuyerSnapshot: explicit } : {}), input = request(id);
    const duty = await capture(db, input), store = createPostgresBillingInvoiceStore(db.runtime);
    const buyer = await store.readCapturedBuyer(id);
    expect(buyer).toMatchObject(source === 'explicit' ? { name: 'Explicit Buyer', source: 'order_buyer', address: explicit.address }
      : source === 'profile' ? { name: 'Profile Buyer', source: 'customer_orderer_profile', ordererProfileId: saved!.id,
        billingAddressId: saved!.address, addressSource: 'customer_billing_address', address: { line2: 'Billing unit 2' } }
      : { name: 'Shipping Buyer', source: 'legacy_shipping_address_fallback', legacyFallback: true, address: { line2: 'Shipping unit 2' } });
    const before = await rows(db, duty.dutyId);
    expect(await capture(db, input)).toEqual(duty);
    expect(await store.captureDuty(input)).toEqual(duty);
    expect(await rows(db, duty.dutyId)).toEqual(before);
  });
  it('refuses an unrecorded destination by name without capturing a duty or inventing buyer facts', async () => {
    const client = await subject(db), id = await order(db, client, {}, false), input = request(id);
    await expect(capture(db, input)).rejects.toMatchObject({ code: '22023', message: 'commerce_destination_unavailable' });
    expect((await db.owner.query('SELECT id FROM public.invoicing_duties WHERE order_id=$1', [id])).rows).toEqual([]);
    expect((await db.owner.query('SELECT * FROM public.invoicing_effect_receipts WHERE receipt_key=$1', [`source:paid:${input.sourceId}`])).rows).toEqual([]);
  });
  it('never backfills an existing owed duty, even through the owned capture routine', async () => {
    const client = await subject(db), id = await order(db, client), input = request(id);
    // This is the persisted shape created by the pre-buyer duty owner, before facts exist.
    const duty = (await db.owner.query('INSERT INTO public.invoicing_duties(order_id,original_key) VALUES($1,$2) RETURNING id', [id, input.requestKey])).rows[0].id;
    const before = (await rows(db, duty)).duty;
    await profile(db, client);
    for (const name of ['invoicing_capture_duty', 'invoicing_capture_duty_with_buyer']) {
      expect((await db.runtime.query(`SELECT public.${name}($1,$2,$3,$4,$5,$6) AS value`, [input.requestKey, input.sourceKind, input.sourceId, id, input.evidence, at])).rows[0].value).toMatchObject({ dutyId: duty });
      expect((await rows(db, duty)).duty).toEqual(before);
      expect((await rows(db, duty)).buyer).toEqual([]);
    }
  });
  it('rolls duty and receipts back if the new buyer component cannot be frozen', async () => {
    const client = await subject(db), id = await order(db, client), input = request(id);
    await db.owner.query("ALTER TABLE public.invoicing_buyer_snapshots ADD CONSTRAINT buyer_capture_failure CHECK (buyer->>'email' <> 'capture-failure@example.invalid')");
    try {
      await db.owner.query("UPDATE public.clients SET email='capture-failure@example.invalid' WHERE id=$1", [client]);
      await expect(capture(db, input)).rejects.toMatchObject({ code: '23514' });
      expect((await db.owner.query('SELECT id FROM public.invoicing_duties WHERE order_id=$1', [id])).rows).toEqual([]);
      expect((await db.owner.query('SELECT * FROM public.invoicing_effect_receipts WHERE receipt_key=$1', [`source:paid:${input.sourceId}`])).rows).toEqual([]);
    } finally { await db.owner.query('ALTER TABLE public.invoicing_buyer_snapshots DROP CONSTRAINT buyer_capture_failure'); }
    expect(await capture(db, input)).toMatchObject({ status: 'owed' });
  });
  it('carries sandbox payment buyer line2/provenance through facts, projection and immutable issued bytes', async () => {
    const client = await subject(db), saved = await profile(db, client), id = await order(db, client);
    const intent = (await db.runtime.query('SELECT public.commerce_open_settlement_intent($1,$2,$3,$4,$5,$6,$7) AS value',
      [randomUUID(), id, 'sandbox', 100, 'XXX', {}, at])).rows[0].value.settlement.id;
    const simulator = createPostgresSandboxPaymentSimulator(db.runtime, { dunningTemplateSlug: 'dunning', recoveryUrlPath: '/recover', recoveryTemplateSlug: 'recover' });
    const attempt = await simulator.beginAttempt({ idempotencyKey: randomUUID(), settlementIntentId: intent, requestFingerprint: 'a'.repeat(64), at });
    const observation = await simulator.recordObservation({ attemptId: attempt.id, idempotencyKey: randomUUID(), outcome: 'captured', occurredAt: at });
    const envelope = { rawBody: new TextEncoder().encode(JSON.stringify({ settlementIntentId: intent, attemptId: attempt.id, observationId: observation.id })), headers: {}, receivedAt: at };
    expect(await simulator.ingress.receive(envelope)).toMatchObject({ status: 200 });
    const store = createPostgresBillingInvoiceStore(db.runtime, { seller }), buyer = (await store.readCapturedBuyer(id))!;
    expect(buyer).toMatchObject({ name: 'Profile Buyer', ordererProfileId: saved.id, billingAddressId: saved.address, addressSource: 'customer_billing_address', address: { line2: 'Billing unit 2' } });
    const duty = (await db.owner.query('SELECT id FROM public.invoicing_duties WHERE order_id=$1', [id])).rows[0].id;
    const frozen = await rows(db, duty), invoice = facts(id, buyer);
    await db.owner.query("UPDATE public.customer_orderer_profiles SET full_name='Changed Buyer' WHERE id=$1", [saved.id]);
    await db.owner.query("UPDATE public.customer_saved_addresses SET line2='Changed unit' WHERE id=$1", [saved.address]);
    expect(await simulator.ingress.receive(envelope)).toMatchObject({ status: 200 });
    expect(await rows(db, duty)).toEqual(frozen);
    await store.installFacts({ dutyId: duty, facts: invoice });
    const installed = (await db.owner.query('SELECT facts FROM public.invoicing_fact_revisions WHERE duty_id=$1', [duty])).rows[0].facts;
    const projection = mapInvoiceClaimToProviderSnapshot({ orderRef: id, issueDate: at.slice(0, 10), sellDate: at.slice(0, 10), currency: 'XXX', seller: {}, buyerSnapshot: installed.buyer,
      documentKind: 'synthetic', governmentClearanceRequired: false, payment: {}, linesSnapshot: [{ name: 'Item', quantity: 1, unitGrossMinor: 100, totalGrossMinor: 100, vatRate: '0' }], totalGrossMinor: 100, totalNetMinor: 100, orderMoney: null },
    { defaultLineLabel: 'Item', deliveryLabel: 'Delivery', defaultTaxRate: '0', defaultBuyerLabel: 'Unavailable' });
    expect(projection.buyer).toMatchObject({ ordererProfileId: saved.id, billingAddressId: saved.address, addressSource: 'customer_billing_address', address: { line2: 'Billing unit 2', addressId: saved.address } });
    const sweep = await store.sweep(100); if ('kind' in sweep) throw Error('sweep refused');
    const claim = sweep.claims.find(c => c.dutyId === duty)!; const prepared = await store.prepareFacts(claim);
    if ('kind' in prepared || prepared.status !== 'ready') throw Error('prepare refused');
    await store.finishFacts({ ...claim, result: { ...prepared, status: 'ready' } });
    const claims = await store.claim({ limit: 1, visibilitySeconds: 300, providerRef: 'captured', orderId: id });
    if ('kind' in claims) throw Error('claim refused'); const document = claims[0]!;
    await store.preflight({ claim: document, status: 'succeeded', amountMinor: 100, currency: 'XXX', proof: { evidenceRef: 'synthetic', fingerprint: 'b'.repeat(64), observedAt: at } });
    const provider = createCapturedPostgresInvoiceProvider(db.runtime, { enabled: true, providerRef: 'captured' });
    const issued = await provider.provider.issue({ identity: { ...document.identity, operation: 'issue', correctionRef: null, parentProviderDocumentRef: null }, facts: document.facts, recoveryLookupRequired: false });
    if (issued.kind !== 'issued') throw Error('issue refused'); await store.finish({ claim: document, result: issued });
    const bytes = (await db.owner.query('SELECT to_jsonb(o) AS row FROM public.invoicing_document_observations o WHERE document_id=$1', [document.documentId])).rows;
    await db.owner.query("UPDATE public.customer_orderer_profiles SET full_name='After issue' WHERE id=$1", [saved.id]);
    expect(await store.installFacts({ dutyId: duty, facts: invoice })).toMatchObject({ replayed: true });
    expect((await db.owner.query('SELECT to_jsonb(o) AS row FROM public.invoicing_document_observations o WHERE document_id=$1', [document.documentId])).rows).toEqual(bytes);
    expect(await store.readCapturedBuyer(id)).toEqual(buyer);
    const later = await order(db, client); await capture(db, request(later));
    expect(await store.readCapturedBuyer(later)).toMatchObject({ name: 'After issue', address: { line2: 'Changed unit' } });
  });
  it('keeps raw buyer/profile tables and the owned capture unavailable to browser roles', async () => {
    const c = await db.owner.connect();
    try { for (const role of ['anon', 'authenticated']) {
      await c.query(`SET ROLE ${role}`);
      for (const table of ['customer_orderer_profiles', 'customer_saved_addresses', 'invoicing_buyer_snapshots']) await expect(c.query(`SELECT * FROM public.${table}`)).rejects.toMatchObject({ code: '42501' });
      await expect(c.query('SELECT public.invoicing_capture_duty_with_buyer(NULL,NULL,NULL,NULL,NULL,NULL)')).rejects.toMatchObject({ code: '42501' });
      await c.query('RESET ROLE');
    } } finally { c.release(); }
  });
});
