import type { FulfillmentNativeUnsupported } from './contracts/nativeUnsupported.js';
import type { FulfillmentReplacementPort } from './contracts/replacement.js';
import type { FulfillmentOperatorMutationPort } from './contracts/operator.js';
import type { FulfillmentCustomerAlignmentRowsReader } from './contracts/customerAlignment.js';
export const FULFILLMENT_NATIVE_UNSUPPORTED: FulfillmentNativeUnsupported = Object.freeze({ kind: 'native_unsupported', reason: 'host_binding_required', retryable: false });
/** Deliberately has no executor: unsupported native parity can never make a partial write. */
export function createNativeUnsupportedFulfillmentPorts(): FulfillmentReplacementPort & FulfillmentOperatorMutationPort & { readCustomerAlignmentRows: FulfillmentCustomerAlignmentRowsReader } {
  const unsupported = async () => FULFILLMENT_NATIVE_UNSUPPORTED;
  return {
    requestReplacementShipment: unsupported,
    createCommerceFulfillmentOrder: unsupported,
    recordCommerceFulfillmentProviderAttempt: unsupported,
    recordCommerceFulfillmentLabel: unsupported,
    handOffCommerceFulfillmentOrder: unsupported,
    recordCommerceFulfillmentTrackingEvent: unsupported,
    cancelCommerceFulfillmentOrder: unsupported,
    readCustomerAlignmentRows: unsupported,
  };
}
