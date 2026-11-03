export type HealCandidate = {
  hold_id: string;
  order_id: string;
  fulfillment_order_id: string;
  cleared_evidence_id: string;
  cleared_provider_status: string;
  cleared_provider_sub_status: string | null;
  cleared_occurred_at: string;
};

export type BackfillRow = HealCandidate & {
  order_number: string | null;
  delivered_at: string;
};
