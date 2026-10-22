import { expect, it } from 'vitest';
import { readFulfillmentLabel, cleanupFulfillmentLabel } from '../../src/fulfillment/index.js';
it('keeps cached signed downloads transient, cleanup uncertainty', async () => {
  let reads = 0, cleanups = 0;
  const document = { objectRef: 'labels/parcel.pdf', mediaType: 'application/pdf' as const, externalRef: 'parcel' };
  const bytes = JSON.stringify(document);
  const port = { async read() { reads++; return { kind: 'available' as const, url: 'https://storage.invalid/transient', expiresAt: null }; }, async void() { cleanups++; return { providerDeletion: 'unconfirmed' as const, labelDeleted: false, canProceed: true }; } };
  expect(await readFulfillmentLabel(port, null)).toMatchObject({ kind: 'refused', refusal: { reason: 'local_missing' } }); expect(reads).toBe(0);
  expect(await readFulfillmentLabel(port, document)).toMatchObject({ kind: 'available' }); expect(reads).toBe(1); expect(JSON.stringify(document)).toBe(bytes);
  expect(await cleanupFulfillmentLabel(port, { parcelRef: 'parcel', document, actorUserId: 'operator', idempotencyKey: 'cleanup-key' })).toEqual({ providerDeletion: 'unconfirmed', labelDeleted: false, canProceed: true }); expect(cleanups).toBe(1);
});
