import type { OmsOrderDetail } from "../../../src/domains/commerce/omsContracts.js";
import type {
  OmsFulfillmentOrderRow,
  OmsOmnipackDispatchRefRow,
} from "../../../src/domains/commerce/omsFulfillmentSummary.js";
// Through the shipping domain's public `contracts` seam, not its module: the delivery
// selection is a cross-domain contract, and the architecture guard only admits it there.
import { resolveDeliverySelectionEvidence } from "../../../src/domains/shipping/contracts.js";

export type OmsHealthDispatchRefRow = OmsOmnipackDispatchRefRow & { id?: string | null };

// The fulfilment provider this deployment dispatches through, named once.
const DISPATCH_PROVIDER_KIND = "omnipack";

type DispatchFinding = {
  healthStatus: Exclude<OmsOrderDetail["fulfillmentHealth"]["healthStatus"], "ok">;
  reason: OmsOrderDetail["fulfillmentHealth"]["attentionReasons"][number];
  timestamp: string | null | undefined;
};

export function classifyOmsOmnipackDispatchHealth(input: {
  fulfillmentOrder: OmsFulfillmentOrderRow;
  // Only `metadata` is read, so the classifier does not depend on the whole order row shape.
  order?: { metadata?: unknown } | null;
  dispatchRef: OmsHealthDispatchRefRow | null;
  now: Date;
  missingRefGraceSeconds: number;
  staleSeconds: number;
}): DispatchFinding | null {
  const { fulfillmentOrder, dispatchRef, now } = input;
  const fulfillmentStatus = clean(fulfillmentOrder.status);
  if (!["created", "label_pending"].includes(fulfillmentStatus)) return null;
  if (!dispatchRef && !isDispatchObligation(input.order, fulfillmentOrder)) return null;

  if (!dispatchRef) {
    const timestamp = fulfillmentOrder.updated_at ?? fulfillmentOrder.created_at;
    if (!isAtLeastAgeOrUnknown(timestamp, now, input.missingRefGraceSeconds)) return null;
    return { healthStatus: "missing_local_commitment", reason: "paid_order_missing_dispatch_ref", timestamp };
  }

  const timestamp = dispatchRef.updated_at ?? dispatchRef.created_at;
  const status = clean(dispatchRef.status);
  if (status === "draft") return null;
  if (status === "submitting") {
    return isAtLeastAgeOrUnknown(timestamp, now, input.staleSeconds)
      ? { healthStatus: "blocked_uncertain", reason: "dispatch_submission_stale", timestamp }
      : null;
  }
  if (status === "uncertain") {
    return { healthStatus: "blocked_uncertain", reason: "dispatch_outcome_uncertain", timestamp };
  }
  if (status === "failed") {
    return { healthStatus: "needs_attention", reason: "dispatch_failed", timestamp };
  }
  if (status === "created") {
    return dispatchRef.provider_order_id?.trim()
      ? null
      : { healthStatus: "needs_attention", reason: "dispatch_created_without_provider_order_id", timestamp };
  }
  if (["cancel_requested", "cancelled"].includes(status)) {
    return { healthStatus: "needs_attention", reason: "dispatch_terminal_without_progress", timestamp };
  }
  return { healthStatus: "needs_attention", reason: "dispatch_status_unknown", timestamp };
}

/**
 * Is this parcel one THIS deployment's provider is supposed to dispatch?
 *
 * The obligation used to be read from `commerce_fulfillment_orders.provider_kind` alone, and
 * that check could never be true in the only window this classifier evaluates. The column is
 * written by exactly one writer - `commerce_fulfillment_record_label_created` - and that same
 * statement sets the row's status to `label_created`, which is outside the
 * `created`/`label_pending` window above. So the guard was unreachable-true and
 * `paid_order_missing_dispatch_ref` could never fire: a parcel that stranded before dispatch
 * reported `ok`, the very case the finding exists for, and a stranded REPLACEMENT reported
 * `ok` too.
 *
 * The order's delivery selection is the fact that IS present in that window, and it is the
 * same fact the dispatch router and the dispatch candidate gate decide on, read through the
 * one resolver that owns it. The column is still honoured, so this is strictly wider than
 * before and never narrower.
 */
function isDispatchObligation(
  order: { metadata?: unknown } | null | undefined,
  fulfillmentOrder: OmsFulfillmentOrderRow,
): boolean {
  const obliged = DISPATCH_PROVIDER_KIND;
  if (clean(fulfillmentOrder.provider_kind) === obliged) return true;
  return resolveDeliverySelectionEvidence({ orderMetadata: order?.metadata }).providerKind === obliged;
}

function isAtLeastAgeOrUnknown(
  value: string | null | undefined,
  now: Date,
  seconds: number,
): boolean {
  const parsed = timestamp(value);
  return parsed <= 0 || now.getTime() - parsed > seconds * 1000;
}

function timestamp(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function clean(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}
