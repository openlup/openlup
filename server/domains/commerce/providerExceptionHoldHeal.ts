// Backfill support for OmniPack provider-exception holds that predate the
// auto-heal trigger.
//
// The trigger only reacts to NEW evidence. An order that already reached its
// terminal delivered state has nothing left coming from OmniPack, so those holds
// can only be closed by a deliberate pass.
//
// The RPC call sites live here rather than in the ops script because
// config/supabase-rpc-catalog.json scopes commerce_oms_* to the owning domain.
// The script is a thin CLI over these functions.

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

// The only judgement this module makes on top of the SQL predicate.
export function selectBackfillRows(
  candidates: HealCandidate[],
  deliveries: Map<string, string | null>,
  orderNumbers: Map<string, string | null>,
): BackfillRow[] {
  const rows: BackfillRow[] = [];
  for (const candidate of candidates) {
    const deliveredAt = deliveries.get(candidate.fulfillment_order_id) ?? null;
    // No delivery, no proof. The trigger covers everything still in flight.
    if (!deliveredAt) continue;
    // An exception raised after delivery is a return, not a stale suspension —
    // the same chronology rule the trigger enforces.
    if (Date.parse(candidate.cleared_occurred_at) >= Date.parse(deliveredAt)) continue;
    rows.push({
      ...candidate,
      delivered_at: deliveredAt,
      order_number: orderNumbers.get(candidate.order_id) ?? null,
    });
  }
  return rows;
}
