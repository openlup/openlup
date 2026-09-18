export const PROVIDER_FULFILLMENT_TRACKING_STATUSES = [
  "provider_received",
  "picking",
  "packed",
  "label_created",
  "handed_over",
  "in_transit",
  "delivered",
  "failed",
  "cancelled",
] as const;
export type ProviderFulfillmentTrackingStatus = (typeof PROVIDER_FULFILLMENT_TRACKING_STATUSES)[number];

export interface ProviderFulfillmentAttemptMetadata {
  providerKind: string;
  providerOrderRef: string | null;
  retryable: boolean;
  failureCode: string | null;
  rawPayload: Record<string, unknown>;
}

export interface ProviderFulfillmentItemLotFacts {
  sku: string;
  quantity: number;
  lotCode: string | null;
  expiresAt: string | null;
  fefoRank: number | null;
}

export function providerStatusConsumesInventory(status: ProviderFulfillmentTrackingStatus): boolean {
  return status === "handed_over";
}
