import {
  createExpiredCheckoutRecoveryService as createPlatformExpiredCheckoutRecoveryService,
  ExpiredCheckoutRecoveryError,
} from "@openlup/platform/commerce/server";
import type { CheckoutPaymentExecution } from "../../../src/domains/commerce/paymentExecutionContracts.js";
import type { CheckoutClientAction } from "../../../src/domains/commerce/checkoutContracts.js";
import type { CreateOrderDraftResponse, CreateQuoteRequest, CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import type {
  CommerceOrderDraftWritePort,
  CommerceQuotePort,
} from "../../../src/domains/commerce/ports.js";
import type { CommerceCheckoutRuntimePort } from "../../../src/domains/commerce/runtimePorts.js";
import type { PaymentExecutionProvider } from "../../../src/domains/payment/types.js";
import { checkoutClientAction, providerFlowFor } from "./commerceCheckoutProviderPayment.js";
import type { CheckoutCompensationPort } from "./commerceCheckoutCompensation.js";
import { quoteRequestForExpiredRecovery } from "./checkoutExpiredRecoveryPolicy.js";
import type { CheckoutRecoveryOrderSnapshot } from "./checkoutRecoveryOrderPort.js";
import {
  ExpiredCheckoutRecoveryConflictError,
  type ExpiredCheckoutRecoveryWritePort,
} from "./checkoutRecoveryOperations.js";
import type { ExpiredCheckoutPaymentSafetyPort } from "./expiredCheckoutPaymentSafety.js";

export { ExpiredCheckoutRecoveryError };

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

export function createExpiredCheckoutRecoveryService(deps: {
  quotePort: CommerceQuotePort;
  orderDraftPort: CommerceOrderDraftWritePort;
  runtimePort: CommerceCheckoutRuntimePort;
  recoveryPort: ExpiredCheckoutRecoveryWritePort;
  compensationPort: CheckoutCompensationPort;
  paymentSafetyPort: ExpiredCheckoutPaymentSafetyPort;
}) {
  const toNativeOrder = (order: CheckoutRecoveryOrderSnapshot) => ({
    ...order,
    initialDeclarationId: null,
    initialActivationState: null,
  });

  const buildCore = (paymentInput?: Pick<ExpiredCheckoutRecoveryInput, "paymentProvider" | "paymentExecution">) =>
    createPlatformExpiredCheckoutRecoveryService<
      CreateQuoteRequest,
      CreateOrderDraftResponse["orderDraft"],
      ExpiredCheckoutRecoveryResult
    >({
      supports: () => true,
      quoteRequest: (order) => quoteRequestForExpiredRecovery(order as unknown as CheckoutRecoveryOrderSnapshot),
      quotePort: {
        createQuote: (request, options) =>
          deps.quotePort.createQuote(request, options as Parameters<CommerceQuotePort["createQuote"]>[1]),
      },
      orderDraftPort: {
        createOrderDraft: (request, options) =>
          deps.orderDraftPort.createOrderDraft(
            request as Parameters<CommerceOrderDraftWritePort["createOrderDraft"]>[0],
            options,
          ),
      },
      recoveryPort: {
        async prepareReplacement(input) {
          try {
            return await deps.recoveryPort.prepareReplacement(input);
          } catch (error) {
            if (error instanceof ExpiredCheckoutRecoveryConflictError) {
              throw new ExpiredCheckoutRecoveryError(
                error.reason === "order_changed" ? "order_changed" : "unavailable",
              );
            }
            throw error;
          }
        },
      },
      paymentSafetyPort: {
        verifyPriorPayment: (order) =>
          deps.paymentSafetyPort.verifyPriorPayment(order as unknown as CheckoutRecoveryOrderSnapshot),
      },
      compensationPort: deps.compensationPort,
      runtimePort: {
        async startRuntime({ idempotencyKey, orderDraft, quoteSnapshot, source, clientId }) {
          const order = source as unknown as CheckoutRecoveryOrderSnapshot;
          const paymentProvider = paymentInput!.paymentProvider;
          const paymentExecution = paymentInput?.paymentExecution;
          const started = await deps.runtimePort.startRuntime({
            idempotencyKey,
            orderDraft: {
              ...orderDraft,
              quoteSnapshot: quoteSnapshot as CreateQuoteResponse,
            },
            mode: order.mode === "subscription_cycle" ? "subscription_cycle" : "one_time",
            saveForFutureUse: order.mode === "subscription_cycle",
            clientId,
            shippingAddressId: order.shippingAddressId!,
            petId: order.petId,
            paymentProvider,
            providerFlow: providerFlowFor(paymentProvider, paymentExecution),
            paymentExecution,
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
          if (paymentProvider === "hidden_rehearsal") {
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
            status: paymentProvider === "hidden_rehearsal" ? "paid" : "processing",
            paymentAttemptId: payment.paymentAttemptId,
            provider: payment.provider,
            providerPaymentId: payment.providerAttemptId ?? null,
            clientAction: action as CheckoutClientAction,
          };
        },
      },
    });

  const validator = buildCore();

  return {
    async validate(order: CheckoutRecoveryOrderSnapshot): Promise<boolean> {
      return validator.validate(toNativeOrder(order));
    },

    async recreate(input: ExpiredCheckoutRecoveryInput): Promise<ExpiredCheckoutRecoveryResult> {
      return buildCore(input).recreate({
        order: toNativeOrder(input.order),
        clientId: input.clientId,
      });
    },
  };
}

export type ExpiredCheckoutRecoveryService = ReturnType<typeof createExpiredCheckoutRecoveryService>;
