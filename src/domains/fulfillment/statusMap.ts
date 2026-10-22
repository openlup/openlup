// Core owns the status canon and helpers; the host adds provider trace metadata.
import {
  FULFILLMENT_STATUS_MAP as CORE_FULFILLMENT_STATUS_MAP,
  type CustomerFulfillmentStep,
  type FulfillmentStatusStage as CoreFulfillmentStatusStage,
} from "@openlup/core/fulfillment";

export {
  CANONICAL_LOCAL_FULFILLMENT_STATUSES,
  CUSTOMER_STEP_SEQUENCE,
  canonicalStatusToken,
  stepForToken,
  customerStepFromSignals,
  phaseIndexForStep,
  stepLabelKey,
  timelineLabelForStep,
  trackingPhaseKeyForStep,
  stepUsesTruckIcon,
} from "@openlup/core/fulfillment";
export type {
  CanonicalLocalFulfillmentStatus,
  CustomerFulfillmentStep,
} from "@openlup/core/fulfillment";

export interface FulfillmentStatusStage extends CoreFulfillmentStatusStage {
  /** Private Layer A traceability; runtime mapping stays in provider dictionaries. */
  providers: {
    omnipack: { status: string[]; subStatusExamples?: string[]; note?: string };
    dhl: { events: string[] };
  };
}

export interface FulfillmentStatusMap {
  version: number; comment: string;
  stages: readonly FulfillmentStatusStage[];
}

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
} as const satisfies Record<CustomerFulfillmentStep, FulfillmentStatusStage["providers"]>;

export const FULFILLMENT_STATUS_MAP = {
  ...CORE_FULFILLMENT_STATUS_MAP,
  // Keep the existing serialized field order: provider trace precedes effects.
  stages: CORE_FULFILLMENT_STATUS_MAP.stages.map(({ effects, ...stage }) => ({
    ...stage,
    providers: PROVIDER_TRACE[stage.customerStep],
    effects,
  })),
} as const satisfies FulfillmentStatusMap;
