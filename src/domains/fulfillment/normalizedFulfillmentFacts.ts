import {
  parseNormalizedFulfillmentFact,
  parseTransitionConflict,
  type CompatibleNormalizedFulfillmentFact as CoreCompatibleNormalizedFulfillmentFact,
  type FulfillmentTransitionSnapshot as CoreFulfillmentTransitionSnapshot,
  type NormalizedFulfillmentFact as CoreNormalizedFulfillmentFact,
  type NormalizedFulfillmentFactV0 as CoreNormalizedFulfillmentFactV0,
  type NormalizedFulfillmentFactV1 as CoreNormalizedFulfillmentFactV1,
  type TransitionConflict as CoreTransitionConflict,
} from "@openlup/core/fulfillment";
import {
  CANONICAL_LOCAL_FULFILLMENT_STATUSES,
  type CanonicalLocalFulfillmentStatus,
} from "./statusMap";

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

/** Application binding: core evidence narrowed to the single Layer B status canon. */
export type NormalizedFulfillmentFact =
  CoreNormalizedFulfillmentFact<CanonicalLocalFulfillmentStatus>;
export type NormalizedFulfillmentFactV1 =
  CoreNormalizedFulfillmentFactV1<CanonicalLocalFulfillmentStatus>;
export type NormalizedFulfillmentFactV0 =
  CoreNormalizedFulfillmentFactV0<CanonicalLocalFulfillmentStatus>;
export type CompatibleNormalizedFulfillmentFact =
  CoreCompatibleNormalizedFulfillmentFact<CanonicalLocalFulfillmentStatus>;
export type FulfillmentTransitionSnapshot =
  CoreFulfillmentTransitionSnapshot<CanonicalLocalFulfillmentStatus>;
export type TransitionConflict =
  CoreTransitionConflict<CanonicalLocalFulfillmentStatus>;

const CANONICAL_STATUSES = new Set<string>(CANONICAL_LOCAL_FULFILLMENT_STATUSES);

export function isCanonicalLocalFulfillmentStatus(
  value: string,
): value is CanonicalLocalFulfillmentStatus {
  return CANONICAL_STATUSES.has(value);
}

/** Strict unknown-input parser bound to the existing status canon. */
export function parseAppNormalizedFulfillmentFact(
  value: unknown,
): NormalizedFulfillmentFact {
  return parseNormalizedFulfillmentFact(value, {
    isCanonicalStatus: isCanonicalLocalFulfillmentStatus,
  });
}

/** Strict conflict parser bound to the same status canon. */
export function parseAppTransitionConflict(value: unknown): TransitionConflict {
  return parseTransitionConflict(value, {
    isCanonicalStatus: isCanonicalLocalFulfillmentStatus,
  });
}
