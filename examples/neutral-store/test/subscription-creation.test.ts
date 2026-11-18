import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configurations } from '../owned/store.config.ts';
import { assertConfig } from '../shared/config.ts';
import { createInitialPurchaseActivation } from '../host/acquisition-predecessors.ts';
import type { Pool } from 'pg';
import type { CreateQuoteResponse } from '@openlup/platform/pricing';

for (const original of Object.values(configurations)) {
  test(`${original.id}: validates owned creation inputs independently of identity`, () => {
    const config = structuredClone(original);
    config.id = 'synthetic-creation-owner';
    // The donor's 72-hour literal remains a supported choice for every adopter.
    for (const editWindowHours of [1, 24, 72, 720]) {
      config.subscriptionCreation = { editWindowHours };
      assert.doesNotThrow(() => assertConfig(config));
    }
    for (const editWindowHours of [0, 721, 1.5, NaN, Infinity]) {
      config.subscriptionCreation = { editWindowHours };
      assert.throws(() => assertConfig(config), /starter_subscription_creation_invalid/);
    }
  });
}

for (const editWindowHours of [24, 72]) test(`ordinary and acquisition activation opt in with ${editWindowHours} hours`, async () => {
  const seen: { sql: string; values: unknown[] | undefined }[] = [];
  const db = { async query(sql: string, values?: unknown[]) {
    seen.push({ sql, values });
    if (sql.includes('subscription_register_renewal_purchase')) throw new Error('synthetic_registration_unavailable');
    if (sql.includes('SELECT cadence_days')) return { rows: [{ cadence_days: 28 }] };
    return { rows: [{ response: {} }] };
  } } as unknown as Pool;
  let acquisitionHours: number | undefined;
  const activation = createInitialPurchaseActivation(db, { assertAvailable() {}, async activate(input) {
    acquisitionHours = input.editWindowHours; return 'complete';
  } });
  const input = { orderId: '00000000-0000-4000-8000-000000000001', capturedReference: 'fixture', currency: 'XXX',
    methodFacts: { authorizationRef: 'fixture', unattendedChargeAuthorizedAt: new Date(0).toISOString(), payerAccountRef: null,
      methodRef: 'fixture', methodEvidenceRef: 'fixture' }, stockSourceKey: 'fixture', templateId: 'fixture', editWindowHours };
  const quote = { quote: { context: {}, currency: 'XXX', lines: [] } } as unknown as CreateQuoteResponse;
  await activation.activate({ ...input, acceptedQuote: quote });
  assert.equal(seen.find(call => call.sql.includes('captured_payment_with_edit_window'))?.values?.[3], editWindowHours);
  await activation.activate({ ...input, acceptedQuote: { quote: { context: { acquisitionTerms: {} } } } as unknown as CreateQuoteResponse });
  assert.equal(acquisitionHours, editWindowHours);
});
