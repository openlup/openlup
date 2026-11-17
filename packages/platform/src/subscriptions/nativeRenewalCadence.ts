import { MAX_CADENCE_DAYS } from "@openlup/core/subscription";

/** Fresh execution only; historical terms and frozen receipts retain integer representation. */
export class NativeRenewalCadenceError extends Error {
  readonly reason = "cadence_limit_exceeded";
  readonly maximumCadenceDays = MAX_CADENCE_DAYS;
  constructor(readonly cadenceDays: number) {
    super(`subscription_renewal_cadence_limit_exceeded: ${cadenceDays}; choose a cadence from 1..${MAX_CADENCE_DAYS} before starting a new renewal`);
    this.name = "NativeRenewalCadenceError";
  }
}
export function assertNativeRenewalCadence(cadenceDays: number): void {
  if (cadenceDays > MAX_CADENCE_DAYS) throw new NativeRenewalCadenceError(cadenceDays);
}
