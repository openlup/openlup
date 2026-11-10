import type { FulfillmentReplacementRequest, FulfillmentReplacementResult } from '../contracts/replacement.js';
import type { FulfillmentOperatorMutationPort, FulfillmentOperatorMutationResult } from '../contracts/operator.js';
import { CommerceFulfillmentConflictError } from '../handlerSupport.js';
import { nativeCall, type PgExecutor } from '../postgresDispatchStore.js';

interface NativeOperatorPort {
  requestReplacementShipment(request: FulfillmentReplacementRequest): Promise<FulfillmentReplacementResult>;
  cancelCommerceFulfillmentOrder(request: Parameters<FulfillmentOperatorMutationPort['cancelCommerceFulfillmentOrder']>[0]): Promise<FulfillmentOperatorMutationResult>;
}

/** Explicit operator composition. The host authenticates actors and binds provider stock. */
export function createPostgresFulfillmentOperatorPort(
  db: PgExecutor, stock: { providerRef: string; stockSourceKey: string },
): NativeOperatorPort {
  if (!stock.providerRef.trim() || !stock.stockSourceKey.trim()) throw new Error('fulfillment_operator_stock_binding_required');
  return {
    requestReplacementShipment: request => operatorCall(db, 'commerce_oms_request_replacement_shipment', [
      request.idempotencyKey, request.orderId, request.reason, request.actorUserId,
      stock.providerRef, stock.stockSourceKey, request.metadata ?? {},
    ]),
    cancelCommerceFulfillmentOrder: request => operatorCall(db, 'fulfillment_operator_cancel_order', [
      request.idempotencyKey, request.fulfillmentOrderId, request.reason, request.actorUserId, request.metadata ?? {},
    ]),
  };
}

/** Host stock-effect callback; consumes only this parcel's recorded reservation generation. */
export function createPostgresParcelReservationConsumption(db: PgExecutor) {
  return (request: { idempotencyKey: string; fulfillmentOrderId: string }) => nativeCall<{
    consumedReservationIds: string[]; replayed: boolean;
  }>(db, 'fulfillment_consume_parcel_reservations', [request.idempotencyKey, request.fulfillmentOrderId]);
}


async function operatorCall<T>(db: PgExecutor, name: string, values: unknown[]): Promise<T> {
  try { return await nativeCall<T>(db, name, values); }
  catch (error) {
    const value = error as { code?: unknown; message?: unknown };
    if (typeof value?.code === 'string' && ['22023','23505','23514','40001','55P03'].includes(value.code)
      && typeof value.message === 'string' && /^(commerce_oms_replacement_|commerce_fulfillment_|inventory_external_provider_|inventory_admission_)[a-z_]+$/.test(value.message)) {
      const reason = value.message.replace(/^(commerce_oms_replacement_|commerce_fulfillment_provider_cancel_|commerce_fulfillment_cancel_|commerce_fulfillment_)/, '');
      throw Object.assign(new CommerceFulfillmentConflictError(value.message, { code: reason, reason, sqlState: value.code }), { code: value.code });
    }
    throw error;
  }
}
