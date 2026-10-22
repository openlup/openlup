/** @beta */
export {
  FULFILLMENT_FACT_SOURCE_AUTHORITIES,
  FULFILLMENT_FACT_SOURCES,
  PROVIDER_FULFILLMENT_FACT_SOURCES,
  NORMALIZED_FULFILLMENT_FACT_PREVIOUS_SCHEMA_VERSION,
  NORMALIZED_FULFILLMENT_FACT_SCHEMA_VERSION,
  TRANSITION_CONFLICT_REASONS,
  InvalidFulfillmentFactError,
  FulfillmentFactCollisionError,
  UnsupportedFulfillmentFactSchemaError,
  canonicalFulfillmentFactFingerprint,
  canonicalizeFulfillmentFacts,
  parseNormalizedFulfillmentFact,
  parseTransitionConflict,
} from "./facts.js";
/** @beta */
export type {
  CompatibleNormalizedFulfillmentFact,
  FulfillmentFactSourceAuthority,
  FulfillmentFactSource,
  FulfillmentFactProvenance,
  FulfillmentRawEventReference,
  FulfillmentProviderSequence,
  FulfillmentFactParserOptions,
  ProviderFulfillmentFactSource,
  NormalizedFulfillmentFact,
  NormalizedFulfillmentFactV0,
  NormalizedFulfillmentFactV1,
  TransitionConflict,
  TransitionConflictDecision,
  FulfillmentTransitionSnapshot,
  TransitionConflictReason,
} from "./facts.js";

export { FULFILLMENT_STATUS_MAP, CANONICAL_LOCAL_FULFILLMENT_STATUSES, CUSTOMER_STEP_SEQUENCE, canonicalStatusToken, stepForToken, customerStepFromSignals, phaseIndexForStep, stepLabelKey, timelineLabelForStep, trackingPhaseKeyForStep, stepUsesTruckIcon } from "./statusMap.js";
export type { FulfillmentStatusStage, FulfillmentStatusMap } from "./statusMap.js";

export { fulfillmentProgressPresentation } from "./trackingProgress.js";

export { parcelSequenceNo, compareParcelPrecedence, currentParcel, currentParcelFor, currentParcelPerOrder, currentParcelFirst, belongsToParcel, rowsForParcel } from "./currentFulfillmentParcel.js";
export type { FulfillmentParcelRow, ParcelAttributedRow } from "./currentFulfillmentParcel.js";

export { isCanonicalLocalFulfillmentStatus, parseFulfillmentFact, parseFulfillmentTransitionConflict } from "./normalizedFulfillmentFacts.js";
export type { CanonicalNormalizedFulfillmentFact, CanonicalNormalizedFulfillmentFactV1, CanonicalNormalizedFulfillmentFactV0, CanonicalCompatibleNormalizedFulfillmentFact, CanonicalFulfillmentTransitionSnapshot, CanonicalTransitionConflict } from "./normalizedFulfillmentFacts.js";
export type { CanonicalLocalFulfillmentStatus, CustomerFulfillmentStep, FulfillmentProgressInput, FulfillmentProgressPresentation } from "./types.js";
