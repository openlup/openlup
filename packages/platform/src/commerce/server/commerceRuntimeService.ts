import type { z } from "zod";
import type { FinalizedCheckoutOrder, CommerceCheckoutRuntimeOrderPort, InventoryCheckoutReservationPort, CommerceRuntimeReadinessPort } from "../contracts/index.js";
import { CommerceRuntimeConflictError } from "../runtimeErrors.js";
import type { CheckoutRuntimeRequest, CheckoutRuntimeExecutionInput, CheckoutRuntimeExecutionResult, CheckoutRuntimeExecutionPort, CheckoutRuntimePaymentPort, CheckoutRuntimeResultRequest, CheckoutRuntimeResponse, CheckoutExecutionProvider } from "./checkoutRuntimeTypes.js";
export function createCommerceRuntimeService<Request extends CheckoutRuntimeRequest, Order extends FinalizedCheckoutOrder<string>, Reservation, PaymentPort extends CheckoutRuntimePaymentPort, Execution extends CheckoutRuntimeExecutionResult, Transient, ExecutionPort extends CheckoutRuntimeExecutionPort<Execution, Transient, Request["providerFlow"], NonNullable<Request["paymentMethodAliasType"]>, NonNullable<Request["paymentMethodRecurringModel"]>>, PreparedPort, PreDispatch, Readiness, Response extends CheckoutRuntimeResponse, ResultRequest extends CheckoutRuntimeResultRequest, ResultResponse, PreparedProvider extends Request["paymentProvider"]>(bindings: {
  defaultPaymentProvider: Request["paymentProvider"]; defaultProviderFlow: Request["providerFlow"];
  preparedRecurringModel(request: Request): string | undefined;
  contractVersion: string; resultResponseSchema: z.ZodType<ResultResponse>; defaultExecutionPort: ExecutionPort;
  executionSubject(order: Order): object; paymentMetadataExtension(order: Order): object;
  buildProviderAttemptIdentity(input: { provider: Request["paymentProvider"]; localExecutionIdempotencyKey: string; paymentIntentId: string; amountMinor: number; currency: string; mode: "one_time" | "subscription_cycle"; orderRef: string }): { providerIdempotencyKey: string; providerRequestFingerprint: string };
  transientProviderInput(execution: Request["paymentExecution"]): Transient | null;
  requiresPreparedProviderAttempt(provider: Request["paymentProvider"]): provider is PreparedProvider;
  preparedProviderAttemptPort(port: PaymentPort, provider: Request["paymentProvider"]): PreparedPort;
  executePreparedProviderAttempt(input: { paymentPort: PreparedPort; executionPort: ExecutionPort; provider: PreparedProvider; paymentIntentId: string; executionInput: CheckoutRuntimeExecutionInput<Transient, Request["providerFlow"], NonNullable<Request["paymentMethodAliasType"]>, NonNullable<Request["paymentMethodRecurringModel"]>>; prepareIdempotencyKey: string; finalizeIdempotencyKey: string; providerIdempotencyKey: string; providerRequestFingerprint: string; providerFlow: string; paymentMethodRef?: string | null; prepareRequestPayload: Record<string, unknown> }): Promise<{ execution: Execution; attempt: { paymentAttemptId: string; status: string } }>;
  isPreDispatch(error: unknown): error is PreDispatch;
  reopenExhaustedPreDispatchAttempt(input: { error: PreDispatch; paymentPort: PaymentPort; paymentExecutionIdempotencyKey: string; order: Order; reservations: Reservation[]; intent: { paymentIntentId: string; paymentId: string }; provider: Request["paymentProvider"] }): Promise<Response>;
  preserveProviderDispatchUncertainty<T>(operation: () => Promise<T>, paymentAttemptId: string): Promise<T>;
  recordPaymentAttempt(port: PaymentPort, input: { idempotencyKey: string; paymentIntentId: string; execution: Execution }): Promise<{ paymentAttemptId: string; status: string }>;
  buildStartedRuntimeResponse(input: { paymentExecutionIdempotencyKey: string; order: Order; reservations: Reservation[]; intent: { paymentIntentId: string; paymentId: string; status: string }; execution: Execution; attempt: { paymentAttemptId: string; status: string }; continuationActionOrigin: "fresh_execution" | null; paymentPort: PaymentPort; readinessPort: CommerceRuntimeReadinessPort<Readiness> }): Promise<Response>;
}) {
  type CommerceRuntimeServiceDeps = {
    orderPort: CommerceCheckoutRuntimeOrderPort<Request, Order>;
    inventoryPort: InventoryCheckoutReservationPort<Order, "created", Reservation>;
    paymentPort: PaymentPort; readinessPort: CommerceRuntimeReadinessPort<Readiness>;
    executionPort?: ExecutionPort; resolveExecutionPort?: (provider: string) => ExecutionPort;
  };

function createService({
  orderPort,
  inventoryPort,
  paymentPort,
  readinessPort,
  executionPort = bindings.defaultExecutionPort,
  resolveExecutionPort,
}: CommerceRuntimeServiceDeps) {
  const pickExecutionPort = (providerKind: string): ExecutionPort =>
    resolveExecutionPort ? resolveExecutionPort(providerKind) : executionPort;

  const startRuntime = async (
    request: Request,
    resolvedExecutionPort?: ExecutionPort,
  ): Promise<Response> => {
    const paymentProvider = request.paymentProvider ?? bindings.defaultPaymentProvider;
    const providerFlow = request.providerFlow ?? bindings.defaultProviderFlow;
    const executionPortForRequest = resolvedExecutionPort ?? pickExecutionPort(paymentProvider);
      const order = await orderPort.finalizeOrderForCheckout(request);
      const reservations = await inventoryPort.reserveOrderItems({
        idempotencyKey: `${request.idempotencyKey}:inventory`,
        order,
        paymentStatus: "created",
        metadata: request.metadata,
      });
      const targetKind = order.mode === "subscription_cycle" ? "subscription_cycle" : "one_time_order";
      const intent = await paymentPort.createIntent({
        idempotencyKey: `${request.idempotencyKey}:payment-intent`,
        targetKind,
        orderId: order.orderId,
        subscriptionId: order.subscriptionId,
        subscriptionCycleId: order.subscriptionCycleId,
        amountMinor: order.total.amountMinor,
        currency: order.total.currency,
        metadata: {
          ...request.metadata,
          source: "commerce.runtime.hidden.v0",
          runtimeIdempotencyKey: request.idempotencyKey,
          ...bindings.paymentMetadataExtension(order),
        },
      });
      // Attempt-scoped, not journey-scoped: a retry after a terminal decline —
      // and above all a switch to another provider — needs a fresh provider
      // attempt identity on the SAME order. Sequence 0 keeps the historic key
      // byte-identical.
      const attemptSequence = request.paymentAttemptSequence ?? 0;
      const paymentExecutionIdempotencyKey = attemptSequence > 0
        ? `${request.idempotencyKey}:payment-execution:attempt:${attemptSequence}`
        : `${request.idempotencyKey}:payment-execution`;
      const providerAttemptIdentity = bindings.buildProviderAttemptIdentity({
        provider: paymentProvider,
        localExecutionIdempotencyKey: paymentExecutionIdempotencyKey,
        paymentIntentId: intent.paymentIntentId,
        amountMinor: order.total.amountMinor,
        currency: order.total.currency,
        mode: order.mode,
        orderRef: order.orderRef,
      });
      const executionInput: CheckoutRuntimeExecutionInput<Transient, Request["providerFlow"], NonNullable<Request["paymentMethodAliasType"]>, NonNullable<Request["paymentMethodRecurringModel"]>> = {
        idempotencyKey: paymentExecutionIdempotencyKey,
        providerIdempotencyKey: providerAttemptIdentity.providerIdempotencyKey,
        providerRequestFingerprint: providerAttemptIdentity.providerRequestFingerprint,
        paymentIntentId: intent.paymentIntentId,
        amountMinor: order.total.amountMinor,
        currency: order.total.currency,
        mode: order.mode,
        orderRef: order.orderRef,
        providerFlow,
        clientId: order.clientId,
        ...bindings.executionSubject(order),
        orderId: order.orderId,
        paymentMethodRef: request.paymentMethodRef,
        paymentMethodAliasType: request.paymentMethodAliasType,
        paymentMethodRecurringModel: request.paymentMethodRecurringModel,
        payer: request.providerPayer,
        // The host execution adapter owns reusable-method policy.
        saveForFutureUse: request.saveForFutureUse,
        returnContext: request.returnContext,
        transientProviderInput: bindings.transientProviderInput(request.paymentExecution),
      };

      if (bindings.requiresPreparedProviderAttempt(paymentProvider)) {
        const preparedPaymentPort = bindings.preparedProviderAttemptPort(paymentPort, paymentProvider);
        const preparedExecution = await bindings.executePreparedProviderAttempt({
          paymentPort: preparedPaymentPort,
          executionPort: executionPortForRequest,
          provider: paymentProvider,
          paymentIntentId: intent.paymentIntentId,
          executionInput,
          prepareIdempotencyKey: `${paymentExecutionIdempotencyKey}:prepare-attempt`,
          finalizeIdempotencyKey: `${paymentExecutionIdempotencyKey}:finalize-attempt`,
          providerIdempotencyKey: providerAttemptIdentity.providerIdempotencyKey,
          providerRequestFingerprint: providerAttemptIdentity.providerRequestFingerprint,
          providerFlow,
          paymentMethodRef: request.paymentMethodRef ?? null,
          prepareRequestPayload: {
            source: "commerce.runtime.provider-attempt.prepare.v0",
            providerIdempotencyKey: providerAttemptIdentity.providerIdempotencyKey,
            providerRequestFingerprint: providerAttemptIdentity.providerRequestFingerprint,
            providerFlow,
            paymentMethodRef: request.paymentMethodRef ?? null,
            recurringModel: bindings.preparedRecurringModel(request),
            // Audit only: recorded so a refusal can be attributed to an issuer
            // later. It is not part of the execution object, so it cannot reach
            // the provider request built below.
            declaredBankId: request.declaredBankId ?? null,
            amountMinor: order.total.amountMinor,
            currency: order.total.currency,
            orderRef: order.orderRef,
            runtimeIdempotencyKey: request.idempotencyKey,
          },
        }).catch((error: unknown) => {
          if (!(bindings.isPreDispatch(error))) throw error;
          return bindings.reopenExhaustedPreDispatchAttempt({
            error, paymentPort, paymentExecutionIdempotencyKey,
            order, reservations, intent, provider: paymentProvider,
          });
        });
        if ("runtime" in preparedExecution) return preparedExecution;
        return bindings.preserveProviderDispatchUncertainty(() => bindings.buildStartedRuntimeResponse({
          paymentExecutionIdempotencyKey,
          order,
          reservations,
          intent,
          execution: preparedExecution.execution,
          attempt: preparedExecution.attempt,
          continuationActionOrigin: "fresh_execution",
          paymentPort,
          readinessPort,
        }), preparedExecution.attempt.paymentAttemptId);
      }
      const execution = await executionPortForRequest.execute(executionInput);
      const attempt = await bindings.recordPaymentAttempt(paymentPort, {
        idempotencyKey: `${request.idempotencyKey}:payment-attempt`,
        paymentIntentId: intent.paymentIntentId,
        execution,
      });
      return bindings.buildStartedRuntimeResponse({
        paymentExecutionIdempotencyKey,
        order,
        reservations,
        intent,
        execution,
        attempt,
        continuationActionOrigin: null,
        paymentPort,
        readinessPort,
      });
  };

  const applyPaymentResult = async (
      request: ResultRequest,
    ): Promise<ResultResponse> => {
      const paymentResult = await paymentPort.applyResult(request);
      if (paymentResult.orderId !== request.orderId) {
        throw new CommerceRuntimeConflictError("Payment result order mismatch", {
          requestOrderId: request.orderId,
          paymentResultOrderId: paymentResult.orderId,
          paymentIntentId: request.paymentIntentId,
        });
      }

      // Interactive PSP declines remain payable on the same order/payment
      // intent. Releasing their stock here creates a paid-without-reservation
      // path on the next recovery attempt. Expiry and genuinely terminal
      // failures still release through this single boundary.
      const shouldRelease = request.resultStatus === "expired" ||
        (request.resultStatus === "failed" && paymentResult.kind !== "recoverable_decline");
      const reservationRelease = shouldRelease
        ? {
            attempted: true,
            ...(await inventoryPort.releaseOrderReservations({
              idempotencyKey: `${request.idempotencyKey}:inventory-release`,
              orderId: request.orderId,
              reason: `payment_${request.resultStatus}`,
            })),
          }
        : { attempted: false, releasedCount: 0 };
      const readiness = shouldRelease
        ? null
        : await readinessPort.evaluateOrderReadiness({
            orderId: request.orderId,
            fallbackOrderItemCount: null,
            allOrderItemsHaveSku: true,
          });

      return bindings.resultResponseSchema.parse({
        contractVersion: bindings.contractVersion,
        paymentResult,
        reservationRelease,
        readiness,
      });
  };

  return {
    startRuntime,
    applyPaymentResult,
  };
}

return createService;
}
