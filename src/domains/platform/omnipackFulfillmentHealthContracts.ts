export type OmniPackFulfillmentHealthSnapshot = {
  fulfillmentHealthAttentionCount?: number;
  fulfillmentHealthMissingLocalCommitmentCount?: number;
  fulfillmentHealthBlockedUncertainCount?: number;
  fulfillmentHealthLocalAheadCount?: number;
  fulfillmentHealthProviderAheadCount?: number;
  fulfillmentHealthNeedsAttentionCount?: number;
  fulfillmentHealthOldestAgeSeconds?: number | null;
  fulfillmentHealthEvidence?: OmniPackFulfillmentHealthAttentionEvidence[];
};

export type OmniPackFulfillmentHealthAttentionEvidence = {
  orderId: string;
  fulfillmentOrderId: string | null;
  outboxEventId: string | null;
  dispatchRefFulfillmentOrderId: string | null;
  latestEvidenceFulfillmentOrderId: string | null;
  healthStatus:
    | "missing_local_commitment"
    | "blocked_uncertain"
    | "local_ahead"
    | "provider_ahead"
    | "needs_attention";
  attentionReasons: string[];
  oldestAgeSeconds: number | null;
};
