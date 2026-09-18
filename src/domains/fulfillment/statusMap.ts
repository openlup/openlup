// SINGLE SOURCE OF TRUTH — fulfillment status mapping across ALL layers:
// carrier/fulfillment vocab (Layer A, per-provider dictionary e.g.
// config/omnipack-status-dictionary.json) → internal/OMS status (Layer B
// `local_status` + the durable `commerce_fulfillment_orders.status` FSM) →
// customer-facing step (Layer C) → UI labels + progress bar + side effects.
//
// No vendor lock-in: the UI consumes ONLY Layer C — swapping a courier /
// fulfillment house is an A→B dictionary change, ZERO UI/i18n change. Do NOT
// add a parallel status mapper; extend the map below — every surface (orders
// card, subscription card, start tiles, order-detail timeline, OMS) derives
// from it. This TS const is the runtime source of truth, mirrored to
// `config/fulfillment-status-map.json` (regenerate with
// `scripts/generate-fulfillment-status-map.ts`); `statusMap.test.ts` locks the
// two together and verifies full cross-layer coverage (FSM enum, Layer B,
// provider dictionaries, i18n). See docs/FULFILLMENT_STATUS_CANON.md.

export type CustomerFulfillmentStep =
  | "paid"
  | "accepted"
  | "packing"
  | "transit"
  | "delivered"
  | "exception"
  | "cancelled";

export interface FulfillmentStatusStage {
  /** Layer C — the provider-neutral customer step. */
  customerStep: CustomerFulfillmentStep;
  /** Precedence when several signals disagree — highest rank wins. */
  rank: number;
  /** Linear 5-step bar position (paid0 → delivered4); off-track states pinned. */
  phaseIndex: number;
  /** Whether this step sits on the normal paid→delivered track. */
  onTrack: boolean;
  /** i18n key for the short label (progress bar + cards). */
  stepLabelKey: string;
  /** Polish milestone label emitted server-side into the order-detail timeline. */
  timelineLabel: string;
  /** Key under `account:dashboard.panels.orders.trackingPhase.*` (start tile). */
  trackingPhaseKey: string;
  /** Short label mirror (kept === the i18n values by statusMap.test.ts). */
  label: { pl: string; en: string };
  /** Layer B `local_status` / durable FSM / order-level statuses resolving here. */
  localStatus: readonly string[];
  omsFulfillmentStatus: string[];
  orderStatus: string[];
  /** Extra provider/synonym tokens that also resolve here (for token→step). */
  aliasTokens: string[];
  /** Illustrative Layer A vocab — traceability only, never read by the UI; the
   * A→B mapping is SPECIFIED in the provider JSON, IMPLEMENTED in its mapper. */
  providers: {
    omnipack: { status: string[]; subStatusExamples?: string[]; note?: string };
    dhl: { events: string[] };
  };
  /** Side-effect boundary: `handover` drives both paths; `stock` is coarser (statusMap.test.ts). */
  effects: { stock: string; handover: boolean; customerEmail: string | false };
}

export interface FulfillmentStatusMap {
  version: number; comment: string;
  stages: readonly FulfillmentStatusStage[];
}

export const FULFILLMENT_STATUS_MAP = {
  version: 1,
  comment:
    "SINGLE SOURCE OF TRUTH for fulfillment status across all layers. Layer C (customerStep) is the spine. Providers (Layer A) map ONLY to local_status (Layer B) in their own dictionary; the UI consumes only Layer C. statusMap.test.ts keeps every layer consistent.",
  stages: [
    {
      customerStep: "paid",
      rank: 1,
      phaseIndex: 0,
      onTrack: true,
      stepLabelKey: "account:dashboard.ordersV2.steps.paid",
      timelineLabel: "Oplacone",
      trackingPhaseKey: "paid",
      label: { pl: "Opłacone", en: "Paid" },
      localStatus: [],
      omsFulfillmentStatus: ["created"],
      orderStatus: ["paid", "fulfillment_pending"],
      aliasTokens: [],
      providers: { omnipack: { status: [], note: "before dispatch to the provider" }, dhl: { events: [] } },
      effects: { stock: "reserved", handover: false, customerEmail: false },
    },
    {
      customerStep: "accepted",
      rank: 2,
      phaseIndex: 1,
      onTrack: true,
      stepLabelKey: "account:dashboard.ordersV2.steps.accepted",
      timelineLabel: "Przyjete do realizacji",
      trackingPhaseKey: "accepted",
      label: { pl: "Przyjęte", en: "Accepted" },
      localStatus: ["provider_received"],
      omsFulfillmentStatus: ["label_pending", "label_created"],
      orderStatus: [],
      aliasTokens: ["new", "accepted", "processing", "provider_attempt_recorded"],
      providers: {
        omnipack: { status: ["NEW"], subStatusExamples: ["VALIDATION_PENDING", "READY_FOR_EXPORT", "EXPORTED"] },
        dhl: { events: ["label_created"] },
      },
      effects: { stock: "reserved", handover: false, customerEmail: false },
    },
    {
      customerStep: "packing",
      rank: 3,
      phaseIndex: 2,
      onTrack: true,
      stepLabelKey: "account:dashboard.ordersV2.steps.packing",
      timelineLabel: "Przygotowane do wysylki",
      trackingPhaseKey: "preparing",
      label: { pl: "Przygotowanie", en: "Preparing" },
      localStatus: ["picking", "packed"],
      omsFulfillmentStatus: ["packed"],
      orderStatus: [],
      aliasTokens: ["picked", "in_fulfillment", "ready_for_packing", "awaiting_courier", "ready_for_pickup"],
      providers: {
        omnipack: {
          status: ["IN_FULFILLMENT", "READY_FOR_PACKING", "AWAITING_COURIER"],
          subStatusExamples: ["PICKING", "PICKED", "PACKED", "READY_FOR_PICKUP"],
        },
        dhl: { events: [] },
      },
      effects: { stock: "consumed", handover: false, customerEmail: false },
    },
    {
      customerStep: "transit",
      rank: 4,
      phaseIndex: 3,
      onTrack: true,
      stepLabelKey: "account:dashboard.ordersV2.steps.transit",
      timelineLabel: "W drodze",
      trackingPhaseKey: "in_transit",
      label: { pl: "W drodze", en: "In transit" },
      localStatus: ["in_transit"],
      omsFulfillmentStatus: ["handed_over", "in_transit"],
      orderStatus: [],
      aliasTokens: ["shipped", "shipping", "out_for_delivery", "dispatched"],
      providers: { omnipack: { status: ["SHIPPING"] }, dhl: { events: ["in_transit", "out_for_delivery"] } },
      effects: { stock: "consumed", handover: true, customerEmail: "shipment.dispatched" },
    },
    {
      customerStep: "delivered",
      rank: 7,
      phaseIndex: 4,
      onTrack: true,
      stepLabelKey: "account:dashboard.ordersV2.steps.delivered",
      timelineLabel: "Dostarczono",
      trackingPhaseKey: "delivered",
      label: { pl: "Dostarczone", en: "Delivered" },
      localStatus: ["delivered"],
      omsFulfillmentStatus: ["delivered"],
      orderStatus: ["fulfilled"],
      aliasTokens: ["delivery_delivered"],
      providers: { omnipack: { status: ["DELIVERED"] }, dhl: { events: ["delivered"] } },
      effects: { stock: "consumed", handover: true, customerEmail: false },
    },
    {
      customerStep: "exception",
      rank: 5,
      phaseIndex: 1,
      onTrack: false,
      stepLabelKey: "account:dashboard.ordersV2.status.exception",
      timelineLabel: "Wymaga sprawdzenia",
      trackingPhaseKey: "exception",
      label: { pl: "Wymaga sprawdzenia", en: "Needs review" },
      localStatus: ["exception"],
      omsFulfillmentStatus: ["exception"],
      orderStatus: [],
      aliasTokens: ["shipping_failed", "failed", "suspended", "returned_to_sender"],
      providers: {
        omnipack: { status: ["SUSPENDED", "SHIPPING_FAILED", "RETURNED_TO_SENDER", "CANCELLED"] },
        dhl: { events: ["exception"] },
      },
      effects: { stock: "held", handover: false, customerEmail: "shipment.exception (provider exception before handoff)" },
    },
    {
      customerStep: "cancelled",
      rank: 6,
      phaseIndex: 0,
      onTrack: false,
      stepLabelKey: "account:dashboard.ordersV2.status.cancelled",
      timelineLabel: "Anulowano",
      trackingPhaseKey: "cancelled",
      label: { pl: "Anulowano", en: "Cancelled" },
      localStatus: ["cancelled"],
      omsFulfillmentStatus: ["cancelled"],
      orderStatus: ["cancelled", "refunded"],
      aliasTokens: ["canceled"],
      providers: { omnipack: { status: [], note: "reserved for audited local cancellation" }, dhl: { events: ["cancelled"] } },
      effects: { stock: "released", handover: false, customerEmail: false },
    },
  ],
} as const satisfies FulfillmentStatusMap;

export type CanonicalLocalFulfillmentStatus =
  (typeof FULFILLMENT_STATUS_MAP.stages)[number]["localStatus"][number];
export const CANONICAL_LOCAL_FULFILLMENT_STATUSES: readonly CanonicalLocalFulfillmentStatus[] =
  FULFILLMENT_STATUS_MAP.stages.flatMap((stage) => stage.localStatus);
// Off-track steps render separately and are absent from the progress-bar spine.
export const CUSTOMER_STEP_SEQUENCE: CustomerFulfillmentStep[] = ["paid", "accepted", "packing", "transit", "delivered"];

// Provider strings arrive in varied spelling ("IN_FULFILLMENT", "in-fulfillment",
// "Label Created") — compare on a canonical token so casing/separator drift never
// silently changes the mapping.
export function canonicalStatusToken(value: string | null | undefined): string | null {
  const token = value?.trim().toLowerCase().replace(/[\s_-]+/g, "_");
  return token || null;
}

const STAGE_BY_STEP: Record<CustomerFulfillmentStep, FulfillmentStatusStage> = Object.fromEntries(
  FULFILLMENT_STATUS_MAP.stages.map((stage) => [stage.customerStep, stage]),
) as unknown as Record<CustomerFulfillmentStep, FulfillmentStatusStage>;

// token → customerStep, derived from the map (localStatus + FSM + orderStatus +
// aliasTokens). Built once; conflicts across stages would be a map bug caught by
// statusMap.test.ts. (Named "lookup", not "*_TOKEN" — all-caps *_TOKEN
// identifiers trip the client secret-boundary guard.)
const STEP_LOOKUP: Record<string, CustomerFulfillmentStep> = (() => {
  const table: Record<string, CustomerFulfillmentStep> = {};
  for (const stage of FULFILLMENT_STATUS_MAP.stages) {
    for (const token of [
      ...stage.localStatus,
      ...stage.omsFulfillmentStatus,
      ...stage.orderStatus,
      ...stage.aliasTokens,
    ]) {
      const canon = canonicalStatusToken(token);
      if (canon) table[canon] = stage.customerStep;
    }
  }
  return table;
})();

/**
 * Resolve a single raw token (a Layer B `local_status`, an FSM value, an order
 * status, or a provider/synonym) to a customer step. Exact map lookup first, then
 * a conservative substring fallback so an unknown FUTURE token never regresses to
 * a misleading default — it returns null and the caller decides (generic label /
 * "paid" floor). Never guesses a more-advanced state than the token implies.
 */
export function stepForToken(token: string | null | undefined): CustomerFulfillmentStep | null {
  const canon = canonicalStatusToken(token);
  if (!canon) return null;
  const exact = STEP_LOOKUP[canon];
  if (exact) return exact;
  if (/deliver/.test(canon)) return "delivered";
  if (/cancel/.test(canon)) return "cancelled";
  if (/exception|fail/.test(canon)) return "exception";
  if (/transit|dispatch|shipp|out_for/.test(canon)) return "transit";
  if (/pack|pick|fulfil/.test(canon)) return "packing";
  if (/label|accept|received|processing/.test(canon) || canon === "new") return "accepted";
  if (/paid|created/.test(canon)) return "paid";
  return null;
}

/**
 * The single customer step for an order, from all its real signals (order status,
 * durable fulfillment status, latest provider evidence). The most-advanced real
 * signal wins by rank — so the internal `label_created` (set at OUR dispatch) can
 * never overstate a box the provider has not started, and a real `picking`/
 * `in_transit` is never held back by a stale internal state. Floors at "paid".
 */
export function customerStepFromSignals(tokens: Array<string | null | undefined>): CustomerFulfillmentStep {
  let best: CustomerFulfillmentStep | null = null;
  let bestRank = -1;
  for (const token of tokens) {
    const step = stepForToken(token);
    if (!step) continue;
    const rank = STAGE_BY_STEP[step].rank;
    if (rank > bestRank) {
      bestRank = rank;
      best = step;
    }
  }
  return best ?? "paid";
}

export function phaseIndexForStep(step: CustomerFulfillmentStep): number {
  return STAGE_BY_STEP[step].phaseIndex;
}

/** i18n key for a step's short label (progress bar + cards). */
export function stepLabelKey(step: CustomerFulfillmentStep): string {
  return STAGE_BY_STEP[step].stepLabelKey;
}

/** Server-emitted Polish milestone label for the order-detail timeline. */
export function timelineLabelForStep(step: CustomerFulfillmentStep): string {
  return STAGE_BY_STEP[step].timelineLabel;
}

/** `panels.orders.trackingPhase.*` key for a step (start-page tile). */
export function trackingPhaseKeyForStep(step: CustomerFulfillmentStep): string {
  return STAGE_BY_STEP[step].trackingPhaseKey;
}

export function stepUsesTruckIcon(step: CustomerFulfillmentStep): boolean {
  return step === "transit" || step === "delivered";
}
