import {
  ProviderAttemptDispatchUncertainError,
  ProviderAttemptInFlightError,
  ProviderAttemptPreDispatchError,
} from "../../shared/preparedProviderAttempt.js";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import {
  startHiddenCheckoutRuntimeResponseSchema,
  type HiddenCheckoutRuntimeReservation,
  type StartHiddenCheckoutRuntimeResponse,
} from "../../../src/domains/commerce/runtimeContracts.js";
import type {
  FinalizedCheckoutOrder,
  PaymentControlRuntimePort,
  TrustedInteractivePreparedAttemptReopenEvidence,
} from "../../../src/domains/commerce/runtimePorts.js";
import type { PaymentExecutionProvider } from "../../../src/domains/payment/types.js";
import { CheckoutOrchestrationError } from "./commerceCheckoutOrchestrationError.js";
import {
  providerAttemptFailureLogFields,
  type ProviderAttemptDispatchState,
  type ProviderAttemptFailureDiagnostic,
} from "../../shared/providerAttemptFailureDiagnostic.js";

type ProviderAttemptFailure =
  | ProviderAttemptInFlightError
  | ProviderAttemptPreDispatchError
  | ProviderAttemptDispatchUncertainError;

/** Carries only sanitized facts to the checkout recovery/control-plane seam. */
export class CheckoutProviderAttemptFailure extends CheckoutOrchestrationError {
  readonly paymentAttemptId: string | null;
  readonly phase: string;
  readonly code: string;
  readonly dispatchState: ProviderAttemptDispatchState;
  readonly retryCount: number;
  readonly failureDiagnostic: ProviderAttemptFailureDiagnostic | null;

  constructor(error: ProviderAttemptFailure) {
    const notDispatched = error instanceof ProviderAttemptPreDispatchError;
    super(
      notDispatched
        ? "start_runtime: provider transaction was not dispatched"
        : "start_runtime: provider attempt remains in flight",
      null,
      notDispatched ? "provider_attempt_not_dispatched" : "provider_attempt_in_flight",
    );
    this.name = "CheckoutProviderAttemptFailure";
    this.paymentAttemptId = error.paymentAttemptId;
    this.phase = error.phase;
    this.code = error instanceof ProviderAttemptDispatchUncertainError ? error.errorCode : error.code;
    this.dispatchState = error.dispatchState;
    this.retryCount = error instanceof ProviderAttemptPreDispatchError ? error.retryCount : 0;
    this.failureDiagnostic = error instanceof ProviderAttemptDispatchUncertainError
      ? error.failureDiagnostic
      : null;
  }
}

export function checkoutProviderAttemptFailure(error: unknown): CheckoutProviderAttemptFailure | null {
  if (
    error instanceof ProviderAttemptInFlightError ||
    error instanceof ProviderAttemptPreDispatchError ||
    error instanceof ProviderAttemptDispatchUncertainError
  ) {
    return new CheckoutProviderAttemptFailure(error);
  }
  return null;
}

export function logCheckoutProviderAttemptFailure(error: CheckoutProviderAttemptFailure): void {
  console.error("checkout_provider_attempt_failure", JSON.stringify(providerAttemptFailureLogFields(error)));
}

/** Re-proves the evidence at the control-plane seam instead of trusting the error that carried it.
 * Each grade is matched whole - state, phase and reason code - so a partially populated error
 * satisfies neither, and an unrecognized combination returns `null` rather than the weaker claim. */
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

export function buildReopenedPreparedAttemptResponse(input: {
  order: FinalizedCheckoutOrder;
  reservations: HiddenCheckoutRuntimeReservation[];
  intent: { paymentIntentId: string; paymentId: string };
  paymentAttemptId: string;
  provider: PaymentExecutionProvider;
}): StartHiddenCheckoutRuntimeResponse {
  return startHiddenCheckoutRuntimeResponseSchema.parse({
    contractVersion: COMMERCE_CONTRACT_VERSION,
    runtime: {
      orderId: input.order.orderId,
      orderRef: input.order.orderRef,
      mode: input.order.mode,
      clientId: input.order.clientId,
      petId: input.order.petId,
      shippingAddressId: input.order.shippingAddressId,
      total: input.order.total,
      finalizedReplayed: input.order.replayed,
      reservations: input.reservations,
      payment: {
        paymentIntentId: input.intent.paymentIntentId,
        paymentId: input.intent.paymentId,
        paymentAttemptId: input.paymentAttemptId,
        status: "failed",
        attemptStatus: "failed",
        provider: input.provider,
        providerAttemptId: null,
        providerClientSecret: null,
        providerRedirectUrl: null,
        providerNextActionKind: null,
        continuationActionOrigin: null,
      },
      readiness: {
        omsEligibility: { allowed: false, reason: "order_not_paid" },
        fulfillmentCreate: { allowed: false, reason: "order_not_paid", omsReason: "order_not_paid" },
      },
      nextAction: { kind: "await_hidden_payment_result", provider: input.provider },
    },
  });
}

type PreDispatchReopenGate = {
  paymentAttemptId: string;
  evidence: TrustedInteractivePreparedAttemptReopenEvidence;
  reopen: NonNullable<PaymentControlRuntimePort["reopenInteractivePreparedAttempt"]>;
};

interface PreDispatchReopenIdentity {
  paymentIntentId: string;
  orderId: string;
  subscriptionId: string | null;
  subscriptionCycleId: string | null;
}

/**
 * Proves the failure is reopenable and the capability is present. Deliberately
 * separate from the write below so a caller may run its own fallible response
 * construction between the two, while a failure there is still harmless.
 */
function preDispatchReopenGate(
  error: ProviderAttemptPreDispatchError,
  paymentPort: PaymentControlRuntimePort,
): PreDispatchReopenGate | null {
  const evidence = trustedPreDispatchEvidence(error);
  const paymentAttemptId = error.paymentAttemptId;
  const reopen = paymentPort.reopenInteractivePreparedAttempt;
  if (!evidence || !paymentAttemptId || typeof reopen !== "function") {
    logPreDispatchReopenFailure(error, "capability_unavailable");
    return null;
  }
  return { paymentAttemptId, evidence, reopen };
}

/**
 * The control write is itself idempotent and gets one same-payload retry for a
 * lost RPC response. A `false` means the write stayed uncertain: the RPC may
 * already have committed, so no caller may compensate the order on it.
 */
async function writePreDispatchReopen(input: {
  gate: PreDispatchReopenGate;
  error: ProviderAttemptPreDispatchError;
  paymentPort: PaymentControlRuntimePort;
  paymentExecutionIdempotencyKey: string;
  identity: PreDispatchReopenIdentity;
}): Promise<boolean> {
  const { gate, identity } = input;
  const request = {
    idempotencyKey: `${input.paymentExecutionIdempotencyKey}:reopen-not-dispatched`,
    paymentIntentId: identity.paymentIntentId,
    paymentAttemptId: gate.paymentAttemptId,
    expectedOrderId: identity.orderId,
    expectedSubscriptionId: identity.subscriptionId,
    expectedSubscriptionCycleId: identity.subscriptionCycleId,
    evidence: gate.evidence,
  };
  const call = async () => {
    const result = await gate.reopen.call(input.paymentPort, request);
    if (result.paymentAttemptId !== gate.paymentAttemptId || result.paymentIntentId !== identity.paymentIntentId) {
      throw new Error("interactive_prepared_attempt_reopen_identity_mismatch");
    }
  };
  try {
    await call();
    return true;
  } catch {
    console.error("provider_attempt_predispatch_reopen_retry", JSON.stringify({
      paymentAttemptId: gate.paymentAttemptId,
      retryOrdinal: 1,
    }));
    try {
      await call();
      return true;
    } catch {
      logPreDispatchReopenFailure(input.error, "rpc_unavailable");
      return false;
    }
  }
}

/**
 * Terminalizes an exhausted, provably pre-dispatch Tpay attempt for the initial
 * checkout saga and answers with the runtime response that leaves the order
 * payable. Any uncertainty rethrows the original non-compensatable error: the
 * RPC may already have committed, so generic order cancellation is unsafe.
 */
export async function reopenExhaustedPreDispatchAttempt(input: {
  error: ProviderAttemptPreDispatchError;
  paymentPort: PaymentControlRuntimePort;
  paymentExecutionIdempotencyKey: string;
  order: FinalizedCheckoutOrder;
  reservations: HiddenCheckoutRuntimeReservation[];
  intent: { paymentIntentId: string; paymentId: string };
  provider: PaymentExecutionProvider;
}): Promise<StartHiddenCheckoutRuntimeResponse> {
  const gate = preDispatchReopenGate(input.error, input.paymentPort);
  if (!gate) throw input.error;
  // Build and validate the response before the mutation. No fallible work may
  // follow a successful reopen, or a schema/readiness error could compensate a
  // now-payable order whose old provider attempt is already terminal.
  const response = buildReopenedPreparedAttemptResponse({
    order: input.order,
    reservations: input.reservations,
    intent: input.intent,
    paymentAttemptId: gate.paymentAttemptId,
    provider: input.provider,
  });
  const reopened = await writePreDispatchReopen({
    gate,
    error: input.error,
    paymentPort: input.paymentPort,
    paymentExecutionIdempotencyKey: input.paymentExecutionIdempotencyKey,
    identity: {
      paymentIntentId: input.intent.paymentIntentId,
      orderId: input.order.orderId,
      subscriptionId: input.order.subscriptionId,
      subscriptionCycleId: input.order.subscriptionCycleId,
    },
  });
  if (!reopened) throw input.error;
  return response;
}

/**
 * The recovery pay-page counterpart. The order, intent and reservations already
 * exist and stay untouched, so there is no response to build and nothing to
 * compensate — the caller only needs to know whether the stranded `created`
 * attempt was terminalized, and surfaces its own structured refusal either way.
 * Left un-terminalized, that attempt reads as live in
 * `checkoutRecoveryPaymentResolver` and blocks every later self-serve retry.
 */
export async function reopenExhaustedPreDispatchRecoveryAttempt(input: {
  error: ProviderAttemptPreDispatchError;
  paymentPort: PaymentControlRuntimePort;
  paymentExecutionIdempotencyKey: string;
  paymentIntentId: string;
  order: { orderId: string; subscriptionId: string | null; subscriptionCycleId: string | null };
}): Promise<boolean> {
  const gate = preDispatchReopenGate(input.error, input.paymentPort);
  if (!gate) return false;
  return writePreDispatchReopen({
    gate,
    error: input.error,
    paymentPort: input.paymentPort,
    paymentExecutionIdempotencyKey: input.paymentExecutionIdempotencyKey,
    identity: {
      paymentIntentId: input.paymentIntentId,
      orderId: input.order.orderId,
      subscriptionId: input.order.subscriptionId,
      subscriptionCycleId: input.order.subscriptionCycleId,
    },
  });
}

function logPreDispatchReopenFailure(
  error: ProviderAttemptPreDispatchError,
  reason: "capability_unavailable" | "rpc_unavailable",
): void {
  console.error("provider_attempt_predispatch_reopen_failed", JSON.stringify({
    paymentAttemptId: error.paymentAttemptId,
    phase: error.phase,
    code: error.code,
    dispatchState: error.dispatchState,
    reason,
  }));
}
