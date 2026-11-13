import { expect, it } from 'vitest';
import { createPostgresFulfillmentShipmentCommandPort } from '../../src/fulfillment/native/index.js';

it('constructs inertly and limits historical tracking error detail to its operator order reference', async () => {
  let queries = 0;
  const order = '11111111-1111-4111-8111-111111111111';
  const port = createPostgresFulfillmentShipmentCommandPort({ async query() {
    queries++;
    throw Object.assign(new Error('commerce_fulfillment_tracking_reference_unattributed'), {
      code: '23505', detail: JSON.stringify({ conflictingOrderId: order, unrelated: 'withheld detail' }),
    });
  } });
  expect(queries).toBe(0);
  await expect(port.recordCommerceFulfillmentLabel({ idempotencyKey: 'label', fulfillmentOrderId: order,
    actorUserId: order, providerKind: 'carrier', providerTrackingId: 'tracking' })).rejects.toMatchObject({
    name: 'CommerceFulfillmentConflictError', details: { code: 'tracking_reference_unattributed', conflictingOrderId: order },
  });
  try {
    await port.recordCommerceFulfillmentLabel({ idempotencyKey: 'label', fulfillmentOrderId: order,
      actorUserId: order, providerKind: 'carrier', providerTrackingId: 'tracking' });
    throw new Error('Expected refusal');
  } catch (error) {
    expect(error).toHaveProperty('details', { code: 'tracking_reference_unattributed', reason: 'tracking_reference_unattributed', sqlState: '23505', conflictingOrderId: order });
  }
  expect(queries).toBe(2);
});
