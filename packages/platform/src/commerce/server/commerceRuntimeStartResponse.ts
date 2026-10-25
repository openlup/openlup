import type { z } from "zod";
import type { FinalizedCheckoutOrder, CommerceRuntimeReadinessPort } from "../contracts/index.js";
import type { CheckoutRuntimeExecutionResult } from "./checkoutRuntimeTypes.js";
export function createRuntimeStartResponse<Order extends FinalizedCheckoutOrder<string>, Reservation, PaymentPort, Execution extends CheckoutRuntimeExecutionResult, Readiness, Response>(bindings: {
  contractVersion: string; responseSchema: z.ZodType<Response>;
  runtimeResponseExtension(order: Order): object;
  finalizeDeclinedAttempt(port: PaymentPort, input: { idempotencyKey: string; orderId: string; paymentIntentId: string; fallbackAttemptId: string; decline: NonNullable<Execution["providerDecline"]> }): Promise<{ paymentAttemptId: string; status: string }>;
}) {

async function buildStartedRuntimeResponse(input: {
  paymentExecutionIdempotencyKey: string;
  order: Order;
  reservations: Reservation[];
  intent: { paymentIntentId: string; paymentId: string; status: string };
  execution: Execution;
  attempt: { paymentAttemptId: string; status: string };
  continuationActionOrigin: "fresh_execution" | null;
  paymentPort: PaymentPort;
  readinessPort: CommerceRuntimeReadinessPort<Readiness>;
}): Promise<Response> {
  let attempt = input.attempt;
  if (input.execution.providerDecline) {
    attempt = await bindings.finalizeDeclinedAttempt(input.paymentPort, {
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

return { buildStartedRuntimeResponse };
}
