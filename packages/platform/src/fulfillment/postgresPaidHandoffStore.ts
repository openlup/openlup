import type { FulfillmentPaidHandoffPort } from './contracts/index.js';
import { nativeCall, type PgExecutor } from './postgresDispatchStore.js';

/** Select an existing native port explicitly; never route by a private provider default. */
export function createPostgresPaidFulfillmentHandoffStore(db: PgExecutor, portKey: string): FulfillmentPaidHandoffPort {
  if (!portKey.trim()) throw new Error('fulfillment_port_key_required');
  return {
    ensureObligation: v => nativeCall(db, 'fulfillment_ensure_paid_handoff', [v.requestKey, v.orderRef, v.paidFactRef, portKey]),
    acknowledge: v => nativeCall(db, 'fulfillment_ack_paid_handoff', [v.requestKey, v.fulfillmentRef]),
  };
}
