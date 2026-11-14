import type { FulfillmentOperatorMutationPort, FulfillmentOperatorMutationResult } from '../contracts/operator.js';
import { nativeCall, type PgExecutor } from '../postgresDispatchStore.js';
import { CommerceFulfillmentConflictError } from '../handlerSupport.js';
import { createPostgresFulfillmentOperatorPort } from './operatorMutations.js';

/** Host-authorized local obligations and audit attempts; creation never contacts a provider. */
export function createPostgresFulfillmentCommerceMutationPort(db: PgExecutor, input: {
  portKey: string; providerRef: string; stockSourceKey: string;
}): Pick<FulfillmentOperatorMutationPort, 'createCommerceFulfillmentOrder' | 'recordCommerceFulfillmentProviderAttempt' | 'cancelCommerceFulfillmentOrder'> {
  if (!input.portKey.trim()) throw new Error('fulfillment_port_key_required');
  const cancellation = createPostgresFulfillmentOperatorPort(db, input);
  const call = async (name: string, values: unknown[]): Promise<FulfillmentOperatorMutationResult> => {
    try { return await nativeCall(db, name, values); }
    catch (error) {
      const e = error as { code?: string; message?: string };
      if (['22023', '23505', '23514'].includes(e.code ?? '') && /^commerce_fulfillment_[a-z_]+$/.test(e.message ?? '')) {
        const reason = e.message!.replace(/^commerce_fulfillment_/, '');
        throw Object.assign(new CommerceFulfillmentConflictError(e.message!, { code: reason, reason, sqlState: e.code }), { code: e.code });
      }
      throw error;
    }
  };
  return {
    createCommerceFulfillmentOrder: r => call('fulfillment_operator_create_order', [r.idempotencyKey, r.orderId, input.portKey, r.actorUserId, r.metadata ?? {}]),
    recordCommerceFulfillmentProviderAttempt: r => call('fulfillment_record_operator_attempt', [
      r.idempotencyKey, r.fulfillmentOrderId, r.providerKind, r.status,
      { request: r.requestPayload ?? {}, response: r.responsePayload ?? {}, metadata: r.metadata ?? {} },
      r.error == null ? null : { message: r.error }, 'operator', r.actorUserId, r.metadata ?? {},
    ]),
    cancelCommerceFulfillmentOrder: cancellation.cancelCommerceFulfillmentOrder,
  };
}
