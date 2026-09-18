import type { CheckoutPaymentExecution } from "../../../src/domains/commerce/paymentExecutionContracts.js";
import type { CheckoutClientAction } from "../../../src/domains/commerce/checkoutContracts.js";
import {
  CommerceOrderDraftPriceChangedError,
  type CommerceOrderDraftWritePort,
  type CommerceQuotePort,
} from "../../../src/domains/commerce/ports.js";
import type { CommerceCheckoutRuntimePort } from "../../../src/domains/commerce/runtimePorts.js";
import type { PaymentExecutionProvider } from "../../../src/domains/payment/types.js";
import { createOrderDraftSnapshotFromQuoteSnapshot } from "../../../src/domains/commerce/orderDraftSnapshotContracts.js";
import { checkoutClientAction, providerFlowFor } from "./commerceCheckoutProviderPayment.js";
import type { CheckoutCompensationPort } from "./commerceCheckoutCompensation.js";
import { isStockUnavailableCheckoutConflict } from "./checkoutConflictClassifiers.js";
import {
  quoteRequestForExpiredRecovery,
  quotesMatchForRecovery,
} from "./checkoutExpiredRecoveryPolicy.js";
import type { CheckoutRecoveryOrderSnapshot } from "./checkoutRecoveryOrderPort.js";
import {
  ExpiredCheckoutRecoveryConflictError,
  type ExpiredCheckoutRecoveryWritePort,
} from "./checkoutRecoveryOperations.js";
import type { ExpiredCheckoutPaymentSafetyPort } from "./expiredCheckoutPaymentSafety.js";

export interface ExpiredCheckoutRecoveryInput {
  order: CheckoutRecoveryOrderSnapshot;
  clientId: string;
  paymentProvider: PaymentExecutionProvider;
  paymentExecution?: CheckoutPaymentExecution;
}

export interface ExpiredCheckoutRecoveryResult {
  orderId: string;
  paymentIntentId: string;
  clientId: string;
  status: "processing" | "paid";
  paymentAttemptId: string | null;
  provider: string;
  providerPaymentId: string | null;
  clientAction: CheckoutClientAction;
}

export class ExpiredCheckoutRecoveryError extends Error {
  constructor(public readonly reason: "paid" | "order_changed" | "unavailable" | "execution_failed") {
    super(`expired_checkout_recovery_${reason}`);
    this.name = "ExpiredCheckoutRecoveryError";
  }
}

export function createExpiredCheckoutRecoveryService(deps: {
  quotePort: CommerceQuotePort;
  orderDraftPort: CommerceOrderDraftWritePort;
  runtimePort: CommerceCheckoutRuntimePort;
  recoveryPort: ExpiredCheckoutRecoveryWritePort;
  compensationPort: CheckoutCompensationPort;
  paymentSafetyPort: ExpiredCheckoutPaymentSafetyPort;
}) {
  return {
    async validate(order: CheckoutRecoveryOrderSnapshot): Promise<boolean> {
      return validateQuote(deps.quotePort, order);
    },

    async recreate(input: ExpiredCheckoutRecoveryInput): Promise<ExpiredCheckoutRecoveryResult> {
      const { order } = input;
      if (!order.quoteSnapshot || !order.shippingAddressId) {
        throw new ExpiredCheckoutRecoveryError("unavailable");
      }
      const priorPayment = await deps.paymentSafetyPort.verifyPriorPayment(order);
      if (priorPayment !== "safe") {
        throw new ExpiredCheckoutRecoveryError(priorPayment);
      }
      const freshQuote = await freshMatchingQuote(deps.quotePort, order);
      const idempotencyKey = `checkout-recovery-recreate:${order.orderId}`;
      let replacementOrderId: string | null = null;
      let runtimeStarted = false;
      try {
        const draft = await deps.orderDraftPort.createOrderDraft(
          { idempotencyKey, quoteSnapshot: freshQuote },
          { clientId: input.clientId },
        );
        replacementOrderId = draft.orderDraft.orderId.replace(/^order_/, "");
        await deps.recoveryPort.prepareReplacement({
          idempotencyKey,
          sourceOrderId: order.orderId,
          replacementOrderId,
        });

        runtimeStarted = true;
        const started = await deps.runtimePort.startRuntime({
          idempotencyKey,
          orderDraft: {
            ...draft.orderDraft,
            quoteSnapshot: freshQuote,
          },
          mode: order.mode === "subscription_cycle" ? "subscription_cycle" : "one_time",
          saveForFutureUse: order.mode === "subscription_cycle",
          clientId: input.clientId,
          shippingAddressId: order.shippingAddressId,
          petId: order.petId,
          paymentProvider: input.paymentProvider,
          providerFlow: providerFlowFor(input.paymentProvider, input.paymentExecution),
          paymentExecution: input.paymentExecution,
          returnContext: "public",
          providerPayer: order.customerEmail
            ? { email: order.customerEmail, name: order.customerName ?? order.customerEmail }
            : undefined,
          metadata: {
            ...order.runtimeMetadata,
            invoiceBuyerSnapshot: order.invoiceBuyerSnapshot,
            recoveryRootOrderId: order.recoveryRootOrderId,
            recreatedFromOrderId: order.orderId,
            recoveryReason: "expired_checkout_recreate",
          },
        });

        const payment = started.runtime.payment;
        if (payment.provider === "stripe" && !payment.providerClientSecret) {
          throw new ExpiredCheckoutRecoveryError("execution_failed");
        }
        if (input.paymentProvider === "hidden_rehearsal") {
          await deps.runtimePort.applyPaymentResult({
            idempotencyKey: `${idempotencyKey}:apply-result`,
            orderId: started.runtime.orderId,
            paymentIntentId: payment.paymentIntentId,
            resultStatus: "succeeded",
            occurredAt: new Date().toISOString(),
          });
        }
        const action = checkoutClientAction({
          provider: payment.provider,
          status: "processing",
          providerClientSecret: payment.providerClientSecret ?? null,
          providerRedirectUrl: payment.providerRedirectUrl ?? null,
        });
        return {
          orderId: started.runtime.orderId,
          paymentIntentId: payment.paymentIntentId,
          clientId: started.runtime.clientId,
          status: input.paymentProvider === "hidden_rehearsal" ? "paid" : "processing",
          paymentAttemptId: payment.paymentAttemptId,
          provider: payment.provider,
          providerPaymentId: payment.providerAttemptId ?? null,
          clientAction: action as CheckoutClientAction,
        };
      } catch (error) {
        if (replacementOrderId) {
          await compensate(deps.compensationPort, idempotencyKey, replacementOrderId, runtimeStarted);
        }
        if (error instanceof ExpiredCheckoutRecoveryError) throw error;
        if (error instanceof ExpiredCheckoutRecoveryConflictError) {
          throw new ExpiredCheckoutRecoveryError(
            error.reason === "order_changed" ? "order_changed" : "unavailable",
          );
        }
        if (error instanceof CommerceOrderDraftPriceChangedError) {
          throw new ExpiredCheckoutRecoveryError("order_changed");
        }
        if (isStockUnavailableCheckoutConflict(error)) {
          throw new ExpiredCheckoutRecoveryError("order_changed");
        }
        throw new ExpiredCheckoutRecoveryError("execution_failed");
      }
    },
  };
}

export type ExpiredCheckoutRecoveryService = ReturnType<typeof createExpiredCheckoutRecoveryService>;

async function validateQuote(
  quotePort: CommerceQuotePort,
  order: CheckoutRecoveryOrderSnapshot,
): Promise<boolean> {
  try {
    await freshMatchingQuote(quotePort, order);
    return true;
  } catch (error) {
    if (error instanceof ExpiredCheckoutRecoveryError) return false;
    throw error;
  }
}

async function freshMatchingQuote(
  quotePort: CommerceQuotePort,
  order: CheckoutRecoveryOrderSnapshot,
) {
  if (!order.quoteSnapshot) throw new ExpiredCheckoutRecoveryError("unavailable");
  const fresh = await quotePort.createQuote(
    quoteRequestForExpiredRecovery(order),
    {
      clientId: order.clientId,
      // The policy assignment is trusted order state, not a caller-controlled
      // selector. Recovery must compare like-for-like: omitting this silently
      // re-quotes an offer-policy-v2 order through the default v1 engine and
      // falsely reports commercial drift. The browser token is deliberately
      // absent from persisted snapshots and is not needed by this internal port.
      ...(order.quoteSnapshot.quote.context?.pricingPolicy
        ? { pricingPolicy: order.quoteSnapshot.quote.context.pricingPolicy }
        : {}),
    },
  );
  if (!quotesMatchForRecovery(order.quoteSnapshot, fresh)) {
    throw new ExpiredCheckoutRecoveryError("order_changed");
  }
  return fresh;
}

async function compensate(
  port: CheckoutCompensationPort,
  idempotencyKey: string,
  orderId: string,
  runtimeStarted: boolean,
): Promise<void> {
  if (runtimeStarted) {
    await port.cancelAbandonedOrder({
      idempotencyKey,
      orderId,
      reason: "expired_checkout_recovery_failed",
    }).catch(() => undefined);
  }
  await port.cancelUnstartedPromotionOrder({
    idempotencyKey,
    orderId,
    reason: "expired_checkout_recovery_failed",
  }).catch(() => undefined);
}
