import type { FulfillmentOperatorMutationPort, FulfillmentOperatorMutationResult } from '../contracts/operator.js';
import { CommerceFulfillmentConflictError } from '../handlerSupport.js';
import { nativeCall, type PgExecutor } from '../postgresDispatchStore.js';

type ShipmentCommandPort = {
  [K in 'recordCommerceFulfillmentLabel' | 'handOffCommerceFulfillmentOrder' | 'recordCommerceFulfillmentTrackingEvent']:
    (request: Parameters<FulfillmentOperatorMutationPort[K]>[0]) => Promise<FulfillmentOperatorMutationResult>;
};

/** Operator evidence transactions. The host authenticates actors and owns connection lifetime.
 * Compose the invoicing handoff wrapper outside this committed database command. */
export function createPostgresFulfillmentShipmentCommandPort(db: PgExecutor): ShipmentCommandPort {
  return {
    recordCommerceFulfillmentLabel: request => command(db, 'fulfillment_operator_record_label', [
      request.idempotencyKey, request.fulfillmentOrderId, request, request.actorUserId,
    ]),
    handOffCommerceFulfillmentOrder: request => command(db, 'fulfillment_operator_hand_off', [
      request.idempotencyKey, request.fulfillmentOrderId, request.actorUserId, request.metadata ?? {},
    ]),
    recordCommerceFulfillmentTrackingEvent: request => command(db, 'fulfillment_operator_record_tracking', [
      request.idempotencyKey, request.fulfillmentOrderId, request, request.actorUserId,
    ]),
  };
}

async function command(db: PgExecutor, name: string, values: unknown[]): Promise<FulfillmentOperatorMutationResult> {
  try { return await nativeCall(db, name, values); }
  catch (error) {
    const value = error as { code?: string; message?: string; detail?: string };
    if (typeof value?.code === 'string' && ['22023', '23505', '40001', '55P03'].includes(value.code)
      && typeof value.message === 'string' && /^commerce_fulfillment_[a-z_]+$/.test(value.message)) {
      const reason = value.message.slice('commerce_fulfillment_'.length);
      const details: Record<string, unknown> = { code: reason, reason, sqlState: value.code };
      if (reason === 'tracking_reference_unattributed' && value.detail) {
        try {
          const parsed = JSON.parse(value.detail) as { conflictingOrderId?: unknown };
          if (typeof parsed.conflictingOrderId === 'string' && /^[0-9a-f-]{36}$/.test(parsed.conflictingOrderId)) {
            details.conflictingOrderId = parsed.conflictingOrderId;
          }
        } catch { /* Optional structured detail never replaces the named refusal. */ }
      }
      throw Object.assign(new CommerceFulfillmentConflictError(value.message, details), { code: value.code });
    }
    throw error;
  }
}
