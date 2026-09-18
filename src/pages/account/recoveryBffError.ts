import { recoveryErrorReason } from "./recoveryErrorCopy";

export function isBffConflict(reason: unknown): boolean {
  return (
    typeof reason === "object" &&
    reason !== null &&
    "code" in reason &&
    (reason as { code?: string }).code === "CONFLICT"
  );
}

export function isRecoveryInFlightConflict(reason: unknown): boolean {
  const code = recoveryErrorReason(reason);
  return code === "provider_attempt_in_flight" || code === "payment_intent_in_flight";
}
