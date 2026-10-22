import {
  parseNormalizedFulfillmentFact,
  parseTransitionConflict,
  type CompatibleNormalizedFulfillmentFact as CoreCompatibleNormalizedFulfillmentFact,
  type FulfillmentTransitionSnapshot as CoreFulfillmentTransitionSnapshot,
  type NormalizedFulfillmentFact as CoreNormalizedFulfillmentFact,
  type NormalizedFulfillmentFactV0 as CoreNormalizedFulfillmentFactV0,
  type NormalizedFulfillmentFactV1 as CoreNormalizedFulfillmentFactV1,
  type TransitionConflict as CoreTransitionConflict,
} from "./facts.js";
import {
  CANONICAL_LOCAL_FULFILLMENT_STATUSES,
} from "./statusMap.js";
import type { CanonicalLocalFulfillmentStatus } from "./types.js";

/** Application binding: core evidence narrowed to the single Layer B status canon. */
export type CanonicalNormalizedFulfillmentFact =
  CoreNormalizedFulfillmentFact<CanonicalLocalFulfillmentStatus>;
export type CanonicalNormalizedFulfillmentFactV1 =
  CoreNormalizedFulfillmentFactV1<CanonicalLocalFulfillmentStatus>;
export type CanonicalNormalizedFulfillmentFactV0 =
  CoreNormalizedFulfillmentFactV0<CanonicalLocalFulfillmentStatus>;
export type CanonicalCompatibleNormalizedFulfillmentFact =
  CoreCompatibleNormalizedFulfillmentFact<CanonicalLocalFulfillmentStatus>;
export type CanonicalFulfillmentTransitionSnapshot =
  CoreFulfillmentTransitionSnapshot<CanonicalLocalFulfillmentStatus>;
export type CanonicalTransitionConflict =
  CoreTransitionConflict<CanonicalLocalFulfillmentStatus>;

const CANONICAL_STATUSES = new Set<string>(CANONICAL_LOCAL_FULFILLMENT_STATUSES);

export function isCanonicalLocalFulfillmentStatus(
  value: string,
): value is CanonicalLocalFulfillmentStatus {
  return CANONICAL_STATUSES.has(value);
}

/** Strict unknown-input parser bound to the existing status canon. */
export function parseFulfillmentFact(
  value: unknown,
): CanonicalNormalizedFulfillmentFact {
  return parseNormalizedFulfillmentFact(value, {
    isCanonicalStatus: isCanonicalLocalFulfillmentStatus,
  });
}

/** Strict conflict parser bound to the same status canon. */
export function parseFulfillmentTransitionConflict(value: unknown): CanonicalTransitionConflict {
  return parseTransitionConflict(value, {
    isCanonicalStatus: isCanonicalLocalFulfillmentStatus,
  });
}
