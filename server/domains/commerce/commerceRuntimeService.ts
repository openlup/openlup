import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import {
  applyHiddenCheckoutPaymentResultResponseSchema,
  type ApplyHiddenCheckoutPaymentResultRequest,
  type ApplyHiddenCheckoutPaymentResultResponse,
  type StartHiddenCheckoutRuntimeRequest,
  type StartHiddenCheckoutRuntimeResponse,
} from "../../../src/domains/commerce/runtimeContracts.js";
import {
  CommerceRuntimeConflictError,
  type CommerceCheckoutRuntimeOrderPort,
  type CommerceCheckoutRuntimePort,
  type CommerceRuntimeReadinessPort,
  type InventoryCheckoutReservationPort,
  type PaymentControlRuntimePort,
} from "../../../src/domains/commerce/runtimePorts.js";
import type { PaymentExecutionPort } from "../../../src/domains/payment/ports.js";
import type { TpayTransientProviderInput } from "../../../src/domains/payment/types.js";
import { buildProviderAttemptIdentity } from "../../../src/lib/providerAttemptIdempotency.js";
import {
  executePreparedProviderAttempt,
  preserveProviderDispatchUncertainty,
  preparedProviderAttemptPort,
  ProviderAttemptPreDispatchError,
  requiresPreparedProviderAttempt,
} from "../../shared/preparedProviderAttempt.js";
import { recordPaymentAttempt } from "../../shared/recordPaymentAttempt.js";
import { tpayTransientInput } from "../../shared/tpayTransientInput.js";
import { buildStartedRuntimeResponse } from "./commerceRuntimeStartResponse.js";
import type {
  CommerceOrderDraftWritePort,
  CommerceQuotePort,
} from "../../../src/domains/commerce/ports.js";
import type {
  CheckoutCommandRuntimePort,
  CheckoutCommandPersistencePort,
} from "../../../src/domains/commerce/runtimePorts.js";
import { executeCheckoutCommand } from "./commerceCheckoutCommandExecution.js";
import type { CheckoutCompensationPort } from "./commerceCheckoutCompensation.js";
import { reopenExhaustedPreDispatchAttempt } from "./commerceProviderAttemptFailure.js";

/** No-provider fallback; composition injects a registry adapter for real PSPs. */
const defaultPaymentExecutionPort: PaymentExecutionPort = {
  async execute(input) {
    return {
      provider: "hidden_rehearsal",
      providerAttemptId: null,
      providerSessionId: null,
      attemptStatus: "processing",
      nextActionKind: null,
      requestPayload: {
        source: "commerce.runtime.hidden.v0",
        providerIdempotencyKey: input.providerIdempotencyKey,
        providerRequestFingerprint: input.providerRequestFingerprint,
      },
      responsePayload: { providerCall: false },
    };
  },
};

export interface CommerceRuntimeServiceDeps {
  orderPort: CommerceCheckoutRuntimeOrderPort;
  inventoryPort: InventoryCheckoutReservationPort;
  paymentPort: PaymentControlRuntimePort;
  readinessPort: CommerceRuntimeReadinessPort;
  /** Per-request resolver takes precedence over the fixed no-provider fallback. */
  executionPort?: PaymentExecutionPort;
  resolveExecutionPort?: (providerKind: string) => PaymentExecutionPort;
  /**
   * The command entry remains uncomposed until a caller explicitly supplies
   * these existing ports. This keeps a missing composition from writing a draft.
   */
  quotePort?: CommerceQuotePort;
  persistencePort?: CheckoutCommandPersistencePort;
  orderDraftPort?: CommerceOrderDraftWritePort;
  /** Compensation capability for a command failure after `startRuntime`. */
  compensationPort?: CheckoutCompensationPort;
  /** Clock for the command path's settle step; composition may freeze it. */
  now?: () => Date;
}

export function createCommerceRuntimeService({
  orderPort,
  inventoryPort,
  paymentPort,
  readinessPort,
  executionPort = defaultPaymentExecutionPort,
  resolveExecutionPort,
  quotePort,
  persistencePort,
  orderDraftPort,
  compensationPort,
  now,
}: CommerceRuntimeServiceDeps): CommerceCheckoutRuntimePort & CheckoutCommandRuntimePort {
  const pickExecutionPort = (providerKind: string): PaymentExecutionPort =>
    resolveExecutionPort ? resolveExecutionPort(providerKind) : executionPort;

  const startRuntime = async (
    request: StartHiddenCheckoutRuntimeRequest,
    resolvedExecutionPort?: PaymentExecutionPort,
  ): Promise<StartHiddenCheckoutRuntimeResponse> => {
    const paymentProvider = request.paymentProvider ?? "hidden_rehearsal";
    const providerFlow = request.providerFlow ?? "one_time_payment";
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
          petId: order.petId,
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
      const providerAttemptIdentity = buildProviderAttemptIdentity({
        provider: paymentProvider,
        localExecutionIdempotencyKey: paymentExecutionIdempotencyKey,
        paymentIntentId: intent.paymentIntentId,
        amountMinor: order.total.amountMinor,
        currency: order.total.currency,
        mode: order.mode,
        orderRef: order.orderRef,
      });
      const executionInput: Parameters<PaymentExecutionPort["execute"]>[0] = {
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
        petId: order.petId,
        orderId: order.orderId,
        paymentMethodRef: request.paymentMethodRef,
        paymentMethodAliasType: request.paymentMethodAliasType,
        paymentMethodRecurringModel: request.paymentMethodRecurringModel,
        payer: request.providerPayer,
        // Request a reusable mandate for subscription_initial. The Stripe adapter
        // ensures-or-creates a customer when this is set with no customerRef, so
        // setup_future_usage='off_session' is accepted.
        saveForFutureUse: request.saveForFutureUse,
        returnContext: request.returnContext,
        transientProviderInput: tpayTransientInput(request.paymentExecution),
      };

      if (requiresPreparedProviderAttempt(paymentProvider)) {
        const preparedPaymentPort = preparedProviderAttemptPort(paymentPort, paymentProvider);
        const preparedExecution = await executePreparedProviderAttempt({
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
            recurringModel: providerFlow === "blik_recurring_activation"
              ? "O"
              : request.paymentMethodRecurringModel,
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
          if (!(error instanceof ProviderAttemptPreDispatchError)) throw error;
          return reopenExhaustedPreDispatchAttempt({
            error, paymentPort, paymentExecutionIdempotencyKey,
            order, reservations, intent, provider: paymentProvider,
          });
        });
        if ("runtime" in preparedExecution) return preparedExecution;
        return preserveProviderDispatchUncertainty(() => buildStartedRuntimeResponse({
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
      const attempt = await recordPaymentAttempt(paymentPort, {
        idempotencyKey: `${request.idempotencyKey}:payment-attempt`,
        paymentIntentId: intent.paymentIntentId,
        execution,
      });
      return buildStartedRuntimeResponse({
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
      request: ApplyHiddenCheckoutPaymentResultRequest,
    ): Promise<ApplyHiddenCheckoutPaymentResultResponse> => {
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

      return applyHiddenCheckoutPaymentResultResponseSchema.parse({
        contractVersion: COMMERCE_CONTRACT_VERSION,
        paymentResult,
        reservationRelease,
        readiness,
      });
  };

  return {
    startRuntime,
    applyPaymentResult,
    startCheckoutCommand: (request) => executeCheckoutCommand(request, {
      quotePort, persistencePort, orderDraftPort, resolveExecutionPort,
      compensationPort, now, startRuntime, applyPaymentResult,
    }),
  };
}
