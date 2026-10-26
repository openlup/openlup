import type { z } from "zod";
import type { FinalizedCheckoutOrder } from "../contracts/index.js";
import { CheckoutOrchestrationError } from "./commerceCheckoutOrchestrationError.js";
type ProviderAttemptDispatchState = "not_dispatched" | "refused" | "unknown";
export interface CheckoutAttemptFailureFacts extends Error { paymentAttemptId: string | null; phase: string; dispatchState: ProviderAttemptDispatchState }
export interface CheckoutPreDispatchFailure extends CheckoutAttemptFailureFacts { code: string; retryCount: number }
export interface CheckoutInFlightFailure extends CheckoutAttemptFailureFacts { code: string }
export interface CheckoutUncertainFailure<Diagnostic> extends CheckoutAttemptFailureFacts { errorCode: string; failureDiagnostic: Diagnostic | null }
interface ReopenPaymentPort<Evidence> {
  reopenInteractivePreparedAttempt?(input: { idempotencyKey: string; paymentIntentId: string; paymentAttemptId: string; expectedOrderId: string; expectedSubscriptionId: string | null; expectedSubscriptionCycleId: string | null; evidence: Evidence }): Promise<{ paymentAttemptId: string; paymentIntentId: string }>;
}
export function createCheckoutProviderAttemptFailure<Order extends FinalizedCheckoutOrder<string>, Reservation, Response, Diagnostic, PreDispatch extends CheckoutPreDispatchFailure, InFlight extends CheckoutInFlightFailure, Uncertain extends CheckoutUncertainFailure<Diagnostic>, Evidence>(bindings: {
  trustedPreDispatchEvidence(error: PreDispatch): Evidence | null;
  isPreDispatch(error: unknown): error is PreDispatch;
  isInFlight(error: unknown): error is InFlight;
  isUncertain(error: unknown): error is Uncertain;
  providerAttemptFailureLogFields(error: { paymentAttemptId: string | null; phase: string; code: string; dispatchState: ProviderAttemptDispatchState; retryCount: number; failureDiagnostic: Diagnostic | null }): unknown;
  responseSchema: z.ZodType<Response>;
  runtimeResponseExtension(order: Order): object;
  contractVersion: string;
}) {

type ProviderAttemptFailure =
  | InFlight
  | PreDispatch
  | Uncertain;

class CheckoutProviderAttemptFailure extends CheckoutOrchestrationError {
  readonly paymentAttemptId: string | null;
  readonly phase: string;
  readonly code: string;
  readonly dispatchState: ProviderAttemptDispatchState;
  readonly retryCount: number;
  readonly failureDiagnostic: Diagnostic | null;

  constructor(error: ProviderAttemptFailure) {
    const notDispatched = bindings.isPreDispatch(error);
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
    this.code = bindings.isUncertain(error) ? error.errorCode : error.code;
    this.dispatchState = error.dispatchState;
    this.retryCount = bindings.isPreDispatch(error) ? error.retryCount : 0;
    this.failureDiagnostic = bindings.isUncertain(error)
      ? error.failureDiagnostic
      : null;
  }
}

function checkoutProviderAttemptFailure(error: unknown): CheckoutProviderAttemptFailure | null {
  if (
    bindings.isInFlight(error) ||
    bindings.isPreDispatch(error) ||
    bindings.isUncertain(error)
  ) {
    return new CheckoutProviderAttemptFailure(error);
  }
  return null;
}

function logCheckoutProviderAttemptFailure(error: CheckoutProviderAttemptFailure): void {
  console.error("checkout_provider_attempt_failure", JSON.stringify(bindings.providerAttemptFailureLogFields(error)));
}

const trustedPreDispatchEvidence = bindings.trustedPreDispatchEvidence;

function buildReopenedPreparedAttemptResponse(input: {
  order: Order;
  reservations: Reservation[];
  intent: { paymentIntentId: string; paymentId: string };
  paymentAttemptId: string;
  provider: string;
}): Response {
  return bindings.responseSchema.parse({
    contractVersion: bindings.contractVersion,
    runtime: {
      orderId: input.order.orderId,
      orderRef: input.order.orderRef,
      mode: input.order.mode,
      clientId: input.order.clientId,
      ...bindings.runtimeResponseExtension(input.order),
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
  evidence: Evidence;
  reopen: NonNullable<ReopenPaymentPort<Evidence>["reopenInteractivePreparedAttempt"]>;
};

interface PreDispatchReopenIdentity {
  paymentIntentId: string;
  orderId: string;
  subscriptionId: string | null;
  subscriptionCycleId: string | null;
}

function preDispatchReopenGate(
  error: PreDispatch,
  paymentPort: ReopenPaymentPort<Evidence>,
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

async function writePreDispatchReopen(input: {
  gate: PreDispatchReopenGate;
  error: PreDispatch;
  paymentPort: ReopenPaymentPort<Evidence>;
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

async function reopenExhaustedPreDispatchAttempt(input: {
  error: PreDispatch;
  paymentPort: ReopenPaymentPort<Evidence>;
  paymentExecutionIdempotencyKey: string;
  order: Order;
  reservations: Reservation[];
  intent: { paymentIntentId: string; paymentId: string };
  provider: string;
}): Promise<Response> {
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

async function reopenExhaustedPreDispatchRecoveryAttempt(input: {
  error: PreDispatch;
  paymentPort: ReopenPaymentPort<Evidence>;
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
  error: PreDispatch,
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

return { CheckoutProviderAttemptFailure, checkoutProviderAttemptFailure, logCheckoutProviderAttemptFailure, trustedPreDispatchEvidence, buildReopenedPreparedAttemptResponse, reopenExhaustedPreDispatchAttempt, reopenExhaustedPreDispatchRecoveryAttempt };
}
