// Shared presentation delegates to the neutral core canon; adapters own status translation.
export {
  FULFILLMENT_STATUS_MAP,
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
  FulfillmentStatusStage,
  FulfillmentStatusMap,
} from "@openlup/core/fulfillment";
