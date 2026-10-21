export function providerOccurrenceKey(
  fulfillmentOrderId: string,
  providerStatus: string,
  occurredAt: string | null,
): string {
  return `${fulfillmentOrderId}:${providerStatus}:${occurredAt ?? "unknown-time"}`;
}
