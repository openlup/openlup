import { getAdminCommerceFulfillmentOrderDetail } from './commerceFulfillmentClient';
import type { BffRequestOptions } from '@/lib/bff/client';

export interface ReferenceFulfillmentDelivery {
  orderId: string;
  status: string;
  trackingReference: string | null;
}
/** Explicit operator read only. Raw operation payloads and address snapshots stay out of presentation. */
export async function readReferenceFulfillmentDelivery(
  accessToken: string,
  orderId: string,
  options: BffRequestOptions = {},
): Promise<ReferenceFulfillmentDelivery> {
  const { order } = await getAdminCommerceFulfillmentOrderDetail(accessToken, { orderId }, options);
  return { orderId: order.orderId, status: order.status, trackingReference: order.providerTrackingId };
}
