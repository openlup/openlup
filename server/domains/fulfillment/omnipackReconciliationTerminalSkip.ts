// Which local fulfillment states reconciliation must NOT try to converge.
//
// WHY THIS EXISTS (historical failure mode, 2026-07-17 → 2026-07-18):
// a single cancelled order left a live `omnipack_dispatch_refs` row.
// OmniPack keeps returning that fulfilment from `getFulfilments`, the local ref
// still matches (findOmnipackDispatchRef matches on provider_order_id /
// order_number and has NO status filter), so every 15-min run called
// `omnipack_acknowledge_dispatch_acceptance` on it. That RPC raises
//   omnipack_dispatch_label_ack_invalid_fulfillment_status (SQLSTATE 22023)
// for any fulfillment whose status is outside
//   created | label_pending | label_created | packed | handed_over | in_transit | delivered
// The port surfaces that as a PLAIN Error (only the SQLSTATE survives — the
// message is dropped), so the worker's catch could not classify it, and the job
// reported `failed` on every run for ~1.3 days, paging ntfy every ~4h. It also
// froze the pagination checkpoint, so reconciliation made no forward progress
// at all.
//
// The fix is a positive check on LOCAL state before the ack, not error sniffing:
//   - the port only exposes the SQLSTATE, and 22023 is raised by five distinct
//     guards in that RPC — swallowing it wholesale would mask real faults;
//   - terminalising the dispatch ref does not help either, since the RPC's ref
//     -status guard rejects everything outside submitting|uncertain|created.
//
// This must NOT be routed through recordQuarantine: that writes
// `inbound_provider_events` with processing_status='ignored', which feeds BOTH
// `omnipack_inbound_quarantined` AND `omnipack_reconciliation_state_conflict` —
// both p1. Quarantining here would simply trade one p1 for another. A cancelled
// order genuinely has nothing to reconcile: its reservations are already
// released and the status canon gives it no forward transition.
//
// The set is DERIVED from the status canon (src/domains/fulfillment/statusMap.ts,
// the single source of truth) rather than hand-listed here — a parallel status
// mapper is explicitly forbidden by AGENTS.md. The off-track stages
// (`onTrack: false`) are exactly `exception` and `cancelled`, which are exactly
// the two FSM statuses the ack RPC rejects.

import { FULFILLMENT_STATUS_MAP } from "../../../src/domains/fulfillment/statusMap.js";

/**
 * Durable `commerce_fulfillment_orders.status` values that sit off the
 * paid→delivered track. Derived from the canon so it cannot drift.
 */
export const OFF_TRACK_FULFILLMENT_STATUSES: ReadonlySet<string> = new Set(
  FULFILLMENT_STATUS_MAP.stages
    .filter((stage) => !stage.onTrack)
    .flatMap((stage) => stage.omsFulfillmentStatus),
);

/**
 * True when the local fulfillment has no forward transition left, so the
 * provider-acceptance ack can never converge it. A benign disposition — never a
 * quarantine.
 *
 * "No forward transition" is not "nothing to write". Status EVIDENCE is still
 * recorded for these fulfilments, because the provider-exception hold healer is
 * an AFTER INSERT trigger on the status-evidence table: an `exception`
 * fulfilment that the provider later reports delivered or recovered can only
 * clear its hold if the pull path writes that observation down. The evidence RPC
 * has no fulfillment-status allowlist; the ack RPC does. The worker therefore
 * gates the ACK on this predicate, not the whole iteration.
 *
 * An unknown/missing status returns false on purpose: reconciliation should
 * still run (and fail loudly) rather than silently skip a state we do not
 * recognise.
 */
export function isOffTrackFulfillmentStatus(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && OFF_TRACK_FULFILLMENT_STATUSES.has(status);
}
