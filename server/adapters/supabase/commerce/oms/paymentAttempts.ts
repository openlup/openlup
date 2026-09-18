import type { OmsPaymentAttemptRow, OmsPaymentIntentRow } from "../../../../../src/domains/commerce/omsReadModel.js";
import { CommerceOmsPersistenceError } from "../../../../../src/domains/commerce/omsPorts.js";
import type { CommerceOmsClient } from "./types.js";

export async function readActivePaymentAttempts(
  client: CommerceOmsClient,
  paymentIntents: OmsPaymentIntentRow[],
): Promise<OmsPaymentAttemptRow[]> {
  const attemptIds = paymentIntents
    .map((intent) => intent.active_attempt_id)
    .filter((id): id is string => Boolean(id));
  if (attemptIds.length === 0) return [];
  const result = await client
    .from("commerce_payment_attempts")
    .select("id, payment_intent_id, status, provider, provider_attempt_id, next_action_kind, updated_at")
    .in("id", attemptIds);
  if (result.error) throw new CommerceOmsPersistenceError("Commerce OMS payment attempt list read failed");
  return (result.data ?? []) as OmsPaymentAttemptRow[];
}
