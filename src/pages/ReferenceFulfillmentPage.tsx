import { useState } from 'react';
import { FulfillmentDeliveryStatus } from '@/components/FulfillmentDeliveryStatus';
import { readReferenceFulfillmentDelivery, type ReferenceFulfillmentDelivery } from '@/domains/fulfillment/referenceFulfillmentClient';

/** Opt-in operator example; the host owns mounting and supplies its existing session and order. */
export default function ReferenceFulfillmentPage({ accessToken, orderId }: { accessToken: string; orderId: string }) {
  const [delivery, setDelivery] = useState<ReferenceFulfillmentDelivery | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function read() {
    setBusy(true);
    setDelivery(null);
    setMessage(null);
    try { setDelivery(await readReferenceFulfillmentDelivery(accessToken, orderId)); }
    catch { setMessage('Fulfillment read unavailable.'); }
    finally { setBusy(false); }
  }
  return <section aria-label="Reference fulfillment">
    <h1>Fulfillment</h1>
    <button type="button" disabled={busy} onClick={() => { void read(); }}>Read fulfillment</button>
    {delivery && delivery.orderId === orderId && <FulfillmentDeliveryStatus status={delivery.status} trackingReference={delivery.trackingReference} />}
    {message && <p role="status">{message}</p>}
  </section>;
}
