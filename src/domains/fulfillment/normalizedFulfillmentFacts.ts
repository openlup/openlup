export {
  FULFILLMENT_FACT_SOURCE_AUTHORITIES,
  FULFILLMENT_FACT_SOURCES,
  PROVIDER_FULFILLMENT_FACT_SOURCES,
  NORMALIZED_FULFILLMENT_FACT_PREVIOUS_SCHEMA_VERSION,
  NORMALIZED_FULFILLMENT_FACT_SCHEMA_VERSION,
  TRANSITION_CONFLICT_REASONS,
  FulfillmentFactCollisionError,
  InvalidFulfillmentFactError,
  UnsupportedFulfillmentFactSchemaError,
  canonicalFulfillmentFactFingerprint,
  canonicalizeFulfillmentFacts,
} from "@openlup/core/fulfillment";
export type {
  FulfillmentFactProvenance,
  FulfillmentFactSourceAuthority,
  FulfillmentFactSource,
  FulfillmentProviderSequence,
  FulfillmentRawEventReference,
  TransitionConflictDecision,
  TransitionConflictReason,
} from "@openlup/core/fulfillment";

// Preserve host names while delegating canonical validation to core.
export {
  isCanonicalLocalFulfillmentStatus,
  parseFulfillmentFact as parseAppNormalizedFulfillmentFact,
  parseFulfillmentTransitionConflict as parseAppTransitionConflict,
} from "@openlup/core/fulfillment";
export type {
  CanonicalNormalizedFulfillmentFact as NormalizedFulfillmentFact,
  CanonicalNormalizedFulfillmentFactV1 as NormalizedFulfillmentFactV1,
  CanonicalNormalizedFulfillmentFactV0 as NormalizedFulfillmentFactV0,
  CanonicalCompatibleNormalizedFulfillmentFact as CompatibleNormalizedFulfillmentFact,
  CanonicalFulfillmentTransitionSnapshot as FulfillmentTransitionSnapshot,
  CanonicalTransitionConflict as TransitionConflict,
} from "@openlup/core/fulfillment";
