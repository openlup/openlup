import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import {
  startHiddenCheckoutRuntimeResponseSchema,
  type HiddenCheckoutRuntimeReservation,
  type StartHiddenCheckoutRuntimeResponse,
} from "../../../src/domains/commerce/runtimeContracts.js";
import type {
  CommerceRuntimeReadinessPort,
  FinalizedCheckoutOrder,
  PaymentControlRuntimePort,
} from "../../../src/domains/commerce/runtimePorts.js";
import type {
  PaymentAttemptStatus,
  PaymentExecutionResult,
  PaymentIntentStatus,
} from "../../../src/domains/payment/types.js";
import { finalizeDeclinedAttempt } from "../../shared/finalizeDeclinedAttempt.js";

/**
 * Completes the local response after a runtime has either recorded a provider
 * attempt or the hidden rehearsal result. Real-provider callers wrap this
 * helper in their post-dispatch uncertainty boundary.
 */
export async function buildStartedRuntimeResponse(input: {
  paymentExecutionIdempotencyKey: string;
  order: FinalizedCheckoutOrder;
  reservations: HiddenCheckoutRuntimeReservation[];
  intent: { paymentIntentId: string; paymentId: string; status: PaymentIntentStatus };
  execution: PaymentExecutionResult;
  attempt: { paymentAttemptId: string; status: PaymentAttemptStatus };
  continuationActionOrigin: "fresh_execution" | null;
  paymentPort: PaymentControlRuntimePort;
  readinessPort: CommerceRuntimeReadinessPort;
}): Promise<StartHiddenCheckoutRuntimeResponse> {
  let attempt = input.attempt;
  if (input.execution.providerDecline) {
    attempt = await finalizeDeclinedAttempt(input.paymentPort, {
      idempotencyKey: `${input.paymentExecutionIdempotencyKey}:payment-declined`,
      orderId: input.order.orderId,
      paymentIntentId: input.intent.paymentIntentId,
      fallbackAttemptId: attempt.paymentAttemptId,
      decline: input.execution.providerDecline,
    });
  }
  const readiness = await input.readinessPort.evaluateOrderReadiness({
    orderId: input.order.orderId,
    fallbackOrderItemCount: input.order.items.length,
    allOrderItemsHaveSku: true,
  });

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
        paymentAttemptId: attempt.paymentAttemptId,
        // finalizeDeclinedAttempt above already applied the canonical failed
        // result to the durable intent/payment/attempt. Reflect that result
        // instead of returning the stale pre-execution "created" snapshot.
        status: input.execution.providerDecline ? "failed" : input.intent.status,
        ...(input.execution.providerDecline?.mandateUnsupported ? { declineMandateUnsupported: true } : {}),
        attemptStatus: attempt.status,
        provider: input.execution.provider,
        providerAttemptId: input.execution.providerAttemptId,
        providerClientSecret: input.execution.clientSecret ?? null,
        providerRedirectUrl: input.execution.redirectUrl ?? null,
        providerNextActionKind: input.execution.nextActionKind ?? null,
        continuationActionOrigin: input.continuationActionOrigin,
      },
      readiness,
      nextAction: {
        kind: "await_hidden_payment_result",
        provider: input.execution.provider,
      },
    },
  });
}
