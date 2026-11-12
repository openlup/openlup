import { createPostgresDestinationPort } from '@openlup/platform/commerce/server/destinations';

/** A complete recorded destination for a newly captured invoice source. */
export async function recordInvoiceDestination(
  db: { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
  orderId: string,
) {
  return createPostgresDestinationPort(db).registerOrder({ idempotencyKey: `invoice-destination:${orderId}`, orderId,
    address: { recipientName: 'Example Buyer', line1: 'Example 1', line2: 'Unit 2', city: 'Example', postalCode: '12345', country: 'ZZ' },
    now: new Date().toISOString() });
}
