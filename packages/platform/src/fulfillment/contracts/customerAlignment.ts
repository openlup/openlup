import type { FulfillmentNativeUnsupported } from './nativeUnsupported.js';
export interface CustomerDeliveryAlignment { state: 'protected' | 'aligned' }
/** Absence from the map means no current customer case, distinct from protected. */
export type FulfillmentCustomerAlignmentRowsReader = (subscriptionIds: string[]) => Promise<Record<string, unknown>[] | FulfillmentNativeUnsupported>;
