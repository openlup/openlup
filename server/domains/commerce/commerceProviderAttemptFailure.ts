import { createCheckoutProviderAttemptFailure } from "@openlup/platform/commerce/server";
import { ProviderAttemptDispatchUncertainError, ProviderAttemptInFlightError, ProviderAttemptPreDispatchError } from "../../shared/preparedProviderAttempt.js";
import { providerAttemptFailureLogFields } from "../../shared/providerAttemptFailureDiagnostic.js";
import { startHiddenCheckoutRuntimeResponseSchema, type HiddenCheckoutRuntimeReservation } from "../../../src/domains/commerce/runtimeContracts.js";
import type { FinalizedCheckoutOrder, TrustedInteractivePreparedAttemptReopenEvidence } from "../../../src/domains/commerce/runtimePorts.js";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
const core = createCheckoutProviderAttemptFailure({
  trustedPreDispatchEvidence,
  isPreDispatch: (error): error is ProviderAttemptPreDispatchError => error instanceof ProviderAttemptPreDispatchError,
  isInFlight: (error): error is ProviderAttemptInFlightError => error instanceof ProviderAttemptInFlightError,
  isUncertain: (error): error is ProviderAttemptDispatchUncertainError => error instanceof ProviderAttemptDispatchUncertainError,
  providerAttemptFailureLogFields,
  responseSchema: startHiddenCheckoutRuntimeResponseSchema,
  runtimeResponseExtension: (order: FinalizedCheckoutOrder) => ({ petId: order.petId }),
  contractVersion: COMMERCE_CONTRACT_VERSION,
});
export const { CheckoutProviderAttemptFailure, checkoutProviderAttemptFailure, logCheckoutProviderAttemptFailure, buildReopenedPreparedAttemptResponse, reopenExhaustedPreDispatchAttempt: reopen, reopenExhaustedPreDispatchRecoveryAttempt } = core;
export type CheckoutProviderAttemptFailure = InstanceType<typeof CheckoutProviderAttemptFailure>;
export function reopenExhaustedPreDispatchAttempt(input: Omit<Parameters<typeof reopen>[0], "reservations"> & { reservations: HiddenCheckoutRuntimeReservation[] }) { return reopen(input); }

export function trustedPreDispatchEvidence(
  error: ProviderAttemptPreDispatchError,
): TrustedInteractivePreparedAttemptReopenEvidence | null {
  if (error.dispatchState === "refused") {
    return error.phase === "response_decode" && error.code === "tpay_request_refused"
      ? { mode: "trusted_provider_refusal", dispatchState: "refused", phase: "response_decode", reasonCode: "tpay_request_refused" }
      : null;
  }
  const phase = error.phase === "oauth" || error.phase === "transaction_dispatch" ? error.phase : null;
  const reasonCode = error.code === "tpay_oauth_failed" || error.code === "tpay_oauth_timeout"
      || error.code === "tpay_oauth_invalid_response" || error.code === "tpay_request_encode_failed"
      || error.code === "tpay_request_deadline_exhausted"
    ? error.code
    : null;
  if (error.dispatchState !== "not_dispatched" || !phase || !reasonCode) return null;
  return { mode: "trusted_pre_dispatch", dispatchState: "not_dispatched", phase, reasonCode };
}
