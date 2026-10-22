import type { FulfillmentObservation } from "./contracts/index.js";

/** Host decoding supplies known domain reasons, never a raw provider error message. */
export async function quarantineReconciliationStateConflict(
  error: unknown,
  observation: FulfillmentObservation,
  classify: (error: unknown) => "fulfillment_not_found" | "stock_consumed_requires_label" | null,
  record: (observation: FulfillmentObservation, reason: "state_conflict", detail: "fulfillment_not_found" | "stock_consumed_requires_label") => Promise<{ replayed: boolean }>,
  result: { quarantined: number; replayed: number; stateConflicts: number },
): Promise<unknown | null> {
  const reason = classify(error);
  if (!reason) return error;
  try {
    const quarantine = await record(observation, "state_conflict", reason);
    if (quarantine.replayed) result.replayed += 1;
    result.quarantined += quarantine.replayed ? 0 : 1;
    result.stateConflicts += 1;
    return null;
  } catch (quarantineError) { return quarantineError; }
}
