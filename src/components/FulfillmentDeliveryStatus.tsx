/** Read-only display of host-projected parcel facts. References are text, never executable links. */
export function FulfillmentDeliveryStatus({ status, trackingReference }: {
  status: string;
  trackingReference: string | null;
}) {
  return <dl aria-label="Fulfillment delivery status">
    <dt>Status</dt><dd>{status}</dd>
    <dt>Tracking reference</dt><dd>{trackingReference ?? 'Unavailable'}</dd>
  </dl>;
}
