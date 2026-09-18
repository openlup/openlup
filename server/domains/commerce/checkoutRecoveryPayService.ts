import { classifyDecline, declineFailureReason } from "../../shared/finalizeDeclinedAttempt.js";
import { recordPaymentAttempt } from "../../shared/recordPaymentAttempt.js";
import { deriveAsyncCheckoutStatus } from "../../../src/domains/commerce/paymentStatus.js";
import type {
  PaymentAttemptStatus,
  PaymentExecutionProvider,
  PaymentExecutionResult,
  PaymentIntentStatus,
} from "../../../src/domains/payment/types.js";
import type { PaymentExecutionPort } from "../../../src/domains/payment/ports.js";
import type {
  PaymentControlRuntimePort,
  CommerceCheckoutRuntimePort,
} from "../../../src/domains/commerce/runtimePorts.js";
import type { CheckoutPaymentExecution } from "../../../src/domains/commerce/paymentExecutionContracts.js";
import type { CheckoutClientAction } from "../../../src/domains/commerce/checkoutContracts.js";
import {
  checkoutClientAction,
  providerFlowFor,
} from "./commerceCheckoutProviderPayment.js";
import type { CheckoutRecoveryOrderSnapshot } from "./checkoutRecoveryOrderPort.js";
import {
  executePreparedProviderAttempt,
  preparedProviderAttemptPort,
  ProviderAttemptPreDispatchError,
  requiresPreparedProviderAttempt,
} from "../../shared/preparedProviderAttempt.js";
import { reopenExhaustedPreDispatchRecoveryAttempt } from "./commerceProviderAttemptFailure.js";
import { buildRecoveryProviderExecution } from "./checkoutRecoveryProviderExecution.js";

/**
 * Re-pay orchestration for the recovery pay-page (W4).
 *
 * Unlike the full checkout saga (commerceCheckoutOrchestration), the order,
 * intent, and reservations ALREADY exist — this records a FRESH provider attempt
 * on the SAME internal intent and, for the local rehearsal/simulator path,
 * applies the succeeded result. It NEVER finalizes a new order or re-reserves
 * inventory.
 *
 * The provider artifact is minted for the caller's per-click idempotency key,
 * so a re-press resumes the same attempt rather than double-charging.
 */

export interface CheckoutRecoveryPayInput {
  order: CheckoutRecoveryOrderSnapshot;
  clientId: string;
  paymentProvider: PaymentExecutionProvider;
  paymentExecution: CheckoutPaymentExecution | undefined;
  idempotencyKey: string;
  exactInlineRetry?: {
    expectedPaymentAttemptId: string;
    retryRequestId: string;
    purchaseContext: "one_time" | "subscription_initial";
  };
  payer?: {
    email: string;
    name: string;
    ip?: string | null;
    userAgent?: string | null;
  };
}

export interface CheckoutRecoveryPayResult {
  orderId: string;
  paymentIntentId: string;
  clientId: string;
  status: "pending_provider_action" | "requires_action" | "processing" | "paid" | "failed" | "expired";
  paymentAttemptId: string | null;
  provider: string;
  providerPaymentId: string | null;
  failureReason?: string | null;
  clientAction: CheckoutClientAction;
}

export interface CheckoutRecoveryPayServiceDeps {
  paymentControlPort: PaymentControlRuntimePort;
  runtimePort: CommerceCheckoutRuntimePort;
  resolveExecutionPort: (providerKind: string) => PaymentExecutionPort;
  now?: () => Date;
}

export interface CheckoutRecoveryPayService {
  pay(input: CheckoutRecoveryPayInput): Promise<CheckoutRecoveryPayResult>;
}

export function createCheckoutRecoveryPayService({
  paymentControlPort,
  runtimePort,
  resolveExecutionPort,
  now = () => new Date(),
}: CheckoutRecoveryPayServiceDeps) {
  return {
    async pay(input: CheckoutRecoveryPayInput): Promise<CheckoutRecoveryPayResult> {
      const { order, paymentProvider } = input;
      const paymentIntentId = order.paymentIntentId;
      if (!paymentIntentId) {
        throw new CheckoutRecoveryPayError("no_open_intent", order.orderId);
      }
      if (!isRecoveryRetryableIntentStatus(order.paymentIntentStatus)) {
        throw new CheckoutRecoveryPayError("payment_intent_in_flight", order.orderId);
      }

      const executionPort = resolveExecutionPort(paymentProvider);
      const providerFlow = providerFlowFor(paymentProvider, input.paymentExecution);
      const { executionIdempotencyKey, identity, executionInput } = buildRecoveryProviderExecution({
        order,
        clientId: input.clientId,
        paymentProvider,
        paymentExecution: input.paymentExecution,
        idempotencyKey: input.idempotencyKey,
        providerFlow,
        paymentIntentId,
        payer: input.payer,
      });

      let execution: PaymentExecutionResult;
      let attempt: { paymentAttemptId: string; status: PaymentAttemptStatus };
      if (requiresPreparedProviderAttempt(paymentProvider)) {
        const preparedPaymentPort = preparedProviderAttemptPort(
          paymentControlPort,
          paymentProvider,
          () => new CheckoutRecoveryPayError(
            "payment_control_prepared_attempt_unavailable",
            order.orderId,
          ),
        );
        const preparedExecution = await executePreparedProviderAttempt({
          paymentPort: preparedPaymentPort,
          executionPort,
          provider: paymentProvider,
          paymentIntentId,
          executionInput,
          prepareIdempotencyKey: `${executionIdempotencyKey}:prepare-attempt`,
          finalizeIdempotencyKey: `${executionIdempotencyKey}:finalize-attempt`,
          providerIdempotencyKey: identity.providerIdempotencyKey,
          providerRequestFingerprint: identity.providerRequestFingerprint,
          providerFlow,
          paymentMethodRef: null,
          prepareRequestPayload: {
            source: input.exactInlineRetry
              ? "commerce.checkout-inline-recovery.prepare.v1"
              : "commerce.recovery.provider-attempt.prepare.v0",
            providerIdempotencyKey: identity.providerIdempotencyKey,
            providerRequestFingerprint: identity.providerRequestFingerprint,
            providerFlow,
            recurringModel: providerFlow === "blik_recurring_activation" ? "O" : undefined,
            amountMinor: order.totalMinor,
            currency: order.currency,
            orderRef: order.orderRef,
            recoveryPayIdempotencyKey: input.idempotencyKey,
            ...(input.exactInlineRetry ?? {}),
          },
          validateExecution: (result) => {
            if (paymentProvider === "stripe" && !result.clientSecret) {
              throw recoveryPayError("stripe_client_secret_missing", order.orderId);
            }
          },
          replayError: () => recoveryPayError("provider_attempt_in_flight", order.orderId),
          executionError: (error) =>
            error instanceof CheckoutRecoveryPayError
              ? error
              : recoveryPayError("provider_execution_failed", order.orderId),
          // The PSP may have accepted the payment even though the durable
          // acknowledgement write timed out. Keep the same order/token fenced
          // behind its prepared attempt rather than surfacing a raw 500.
          finalizationError: () => recoveryPayError("provider_attempt_in_flight", order.orderId),
        }).catch(async (error: unknown): Promise<never> => {
          // A twice-proven pre-dispatch failure never reaches `executionError`:
          // the raw error is what carries the attempt id, phase and code the
          // reopen boundary gates on, so the rescue has to run first. Without it
          // the prepared attempt strands `created`, which the recovery resolver
          // reads as live and which then refuses every later self-serve retry
          // while the dunning ladder keeps burning.
          if (!(error instanceof ProviderAttemptPreDispatchError)) throw error;
          await reopenExhaustedPreDispatchRecoveryAttempt({
            error,
            paymentPort: paymentControlPort,
            paymentExecutionIdempotencyKey: executionIdempotencyKey,
            paymentIntentId,
            order,
          });
          // Structured either way. A refused reopen leaves the same stranded
          // attempt we have today, but never an unhandled 500 on the pay-page.
          throw recoveryPayError("provider_execution_failed", order.orderId);
        });
        execution = preparedExecution.execution;
        attempt = preparedExecution.attempt;
      } else {
        execution = await executionPort.execute(executionInput);
        attempt = await recordPaymentAttempt(paymentControlPort, {
          idempotencyKey: `${input.idempotencyKey}:payment-attempt`,
          paymentIntentId,
          execution,
        });
      }

      // A synchronous refusal has no later callback. Return it as a recoverable
      // result; throwing would misclassify the still-payable order as a conflict.
      if (execution.providerDecline) {
        const failureReason = declineFailureReason(execution.providerDecline);
        await runtimePort.applyPaymentResult({
          idempotencyKey: `${input.idempotencyKey}:payment-declined`,
          orderId: order.orderId,
          paymentIntentId,
          resultStatus: "failed",
          occurredAt: now().toISOString(),
          failureReason,
          failureClassification: classifyDecline(execution.providerDecline),
        });
        return {
          orderId: order.orderId,
          paymentIntentId,
          clientId: input.clientId,
          status: "failed",
          paymentAttemptId: attempt.paymentAttemptId,
          provider: execution.provider,
          providerPaymentId: execution.providerAttemptId,
          failureReason,
          clientAction: { kind: "none" },
        };
      }

      // Rehearsal no-op provider settles synchronously — apply the succeeded
      // result so the existing success path flips order→paid, activates the sub
      // (pending_activation→active), and pins reservations. Real PSPs return
      // processing and rely on the webhook (no auto-success here).
      if (paymentProvider === "hidden_rehearsal") {
        await runtimePort.applyPaymentResult({
          idempotencyKey: `${input.idempotencyKey}:apply-result`,
          orderId: order.orderId,
          paymentIntentId,
          resultStatus: "succeeded",
          occurredAt: now().toISOString(),
        });
        return {
          orderId: order.orderId,
          paymentIntentId,
          clientId: input.clientId,
          status: "paid",
          paymentAttemptId: attempt.paymentAttemptId,
          provider: execution.provider,
          providerPaymentId: execution.providerAttemptId,
          clientAction: { kind: "none" },
        };
      }

      const status = deriveAsyncCheckoutStatus({
        intentStatus: "processing" as PaymentIntentStatus,
        attemptStatus: attempt.status as PaymentAttemptStatus,
        orderStatus: order.status,
      });

      const action = checkoutClientAction({
        provider: execution.provider,
        status: status === "paid" ? "paid" : "processing",
        providerClientSecret: execution.clientSecret ?? null,
        providerRedirectUrl: execution.redirectUrl ?? null,
      });

      return {
        orderId: order.orderId,
        paymentIntentId,
        clientId: input.clientId,
        status,
        paymentAttemptId: attempt.paymentAttemptId,
        provider: execution.provider,
        providerPaymentId: execution.providerAttemptId,
        clientAction: action as CheckoutClientAction,
      };
    },
  };
}

export class CheckoutRecoveryPayError extends Error {
  constructor(
    public readonly code: string,
    public readonly orderId: string,
  ) {
    super(`checkout_recovery_pay_${code}`);
    this.name = "CheckoutRecoveryPayError";
  }
}

function recoveryPayError(code: string, orderId: string): CheckoutRecoveryPayError {
  return new CheckoutRecoveryPayError(code, orderId);
}

function isRecoveryRetryableIntentStatus(status: PaymentIntentStatus | null): boolean {
  return status === "created" || status === "failed";
}
