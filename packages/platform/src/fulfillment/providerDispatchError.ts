import type { FulfillmentDispatchResult } from "./contracts/index.js";

/** Adapters translate structured provider failures into the port result before returning.
 * An unclassified throw after invoking dispatch can follow a successful POST. */
export function unknownDispatchFailure(): Extract<FulfillmentDispatchResult, { kind: "unknown" }> {
  return { kind: "unknown", effectMayHaveSucceeded: true, refusal: { reason: "io_failure", phase: "dispatch", retryable: true } };
}
