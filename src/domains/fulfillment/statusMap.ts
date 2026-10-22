import { FULFILLMENT_STATUS_MAP as CANONICAL_MAP } from '@openlup/platform/fulfillment';
export { CANONICAL_LOCAL_FULFILLMENT_STATUSES, CUSTOMER_STEP_SEQUENCE, canonicalStatusToken, stepForToken, customerStepFromSignals, phaseIndexForStep, stepLabelKey, timelineLabelForStep, trackingPhaseKeyForStep, stepUsesTruckIcon } from '@openlup/platform/fulfillment';
export type { CanonicalLocalFulfillmentStatus, CustomerFulfillmentStep } from '@openlup/platform/fulfillment/contracts';
import type { CustomerFulfillmentStep } from '@openlup/platform/fulfillment/contracts';

/** Private trace vocabulary only; public fields and status semantics come from the package. */
type ProviderTrace = Pick<FulfillmentStatusStage, 'providers'>;
const PROVIDER_TRACE = {
  paid: { omnipack: { status: [], note: "before dispatch to the provider" }, dhl: { events: [] } },
  accepted: {
        omnipack: { status: ["NEW"], subStatusExamples: ["VALIDATION_PENDING", "READY_FOR_EXPORT", "EXPORTED"] },
        dhl: { events: ["label_created"] },
      },
  packing: {
        omnipack: {
          status: ["IN_FULFILLMENT", "READY_FOR_PACKING", "AWAITING_COURIER"],
          subStatusExamples: ["PICKING", "PICKED", "PACKED", "READY_FOR_PICKUP"],
        },
        dhl: { events: [] },
      },
  transit: { omnipack: { status: ["SHIPPING"] }, dhl: { events: ["in_transit", "out_for_delivery"] } },
  delivered: { omnipack: { status: ["DELIVERED"] }, dhl: { events: ["delivered"] } },
  exception: {
        omnipack: { status: ["SUSPENDED", "SHIPPING_FAILED", "RETURNED_TO_SENDER", "CANCELLED"] },
        dhl: { events: ["exception"] },
      },
  cancelled: { omnipack: { status: [], note: "reserved for audited local cancellation" }, dhl: { events: ["cancelled"] } },
} as const satisfies Record<CustomerFulfillmentStep, ProviderTrace['providers']>;
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
export interface FulfillmentStatusMap { version: number; comment: string; stages: readonly FulfillmentStatusStage[] }
export const FULFILLMENT_STATUS_MAP = {
  ...CANONICAL_MAP,
  stages: CANONICAL_MAP.stages.map(({ effects, ...stage }) => ({ ...stage, providers: PROVIDER_TRACE[stage.customerStep], effects })),
} satisfies FulfillmentStatusMap;
