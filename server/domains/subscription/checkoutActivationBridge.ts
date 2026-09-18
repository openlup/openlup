import type { HiddenSubscriptionRuntimePort } from "../../../src/domains/subscription/runtimePorts.js";
import type { ActivateSubscriptionFromPaidCheckoutOrderResponse } from "../../../src/domains/subscription/runtimeContracts.js";

export type CheckoutActivationKind = "one_time" | "subscription_initial";

export interface CheckoutPaymentSucceededInput {
  orderId: string;
  paymentIntentId: string;
  paymentMethodRef: string | null;
  paymentMethodKind: string | null;
  paidAt: string;
}

export interface CheckoutActivationContext {
  checkoutKind: CheckoutActivationKind;
  cadenceDays: number | null;
}

export interface CheckoutActivationContextPort {
  getCheckoutActivationContext(orderId: string): Promise<CheckoutActivationContext>;
}

export interface CheckoutActivationAuditPort {
  recordBlockedSubscriptionActivation(input: {
    idempotencyKey: string;
    orderId: string;
    paymentIntentId: string;
    reason: "missing_reusable_payment_method";
    supportCode: string;
  }): Promise<void>;
}

export type CheckoutPaymentSucceededResult =
  | {
      checkoutKind: "one_time";
      activationStatus: "not_applicable";
    }
  | {
      checkoutKind: "subscription_initial";
      activationStatus: "blocked_missing_payment_method";
      supportCode: string;
    }
  | {
      checkoutKind: "subscription_initial";
      activationStatus: "activated";
      subscriptionActivation: ActivateSubscriptionFromPaidCheckoutOrderResponse["subscriptionActivation"];
    };

export interface CheckoutActivationBridgeDeps {
  contextPort: CheckoutActivationContextPort;
  runtimePort: HiddenSubscriptionRuntimePort;
  auditPort: CheckoutActivationAuditPort;
}

export function createCheckoutActivationBridge({
  contextPort,
  runtimePort,
  auditPort,
}: CheckoutActivationBridgeDeps) {
  return {
    async onCheckoutPaymentSucceeded(
      input: CheckoutPaymentSucceededInput,
    ): Promise<CheckoutPaymentSucceededResult> {
      const context = await contextPort.getCheckoutActivationContext(input.orderId);
      if (context.checkoutKind === "one_time") {
        return { checkoutKind: "one_time", activationStatus: "not_applicable" };
      }

      const idempotencyKey = activationIdempotencyKey(input);
      if (!input.paymentMethodRef || !input.paymentMethodKind) {
        const supportCode = "subscription_activation_missing_reusable_payment_method";
        await auditPort.recordBlockedSubscriptionActivation({
          idempotencyKey: `${idempotencyKey}:blocked`,
          orderId: input.orderId,
          paymentIntentId: input.paymentIntentId,
          reason: "missing_reusable_payment_method",
          supportCode,
        });
        return {
          checkoutKind: "subscription_initial",
          activationStatus: "blocked_missing_payment_method",
          supportCode,
        };
      }

      const response = await runtimePort.activateSubscriptionFromPaidCheckoutOrder({
        idempotencyKey,
        orderId: input.orderId,
        paymentIntentId: input.paymentIntentId,
        paymentMethodRef: input.paymentMethodRef,
        paymentMethodKind: input.paymentMethodKind,
        paidAt: input.paidAt,
      });

      return {
        checkoutKind: "subscription_initial",
        activationStatus: "activated",
        subscriptionActivation: response.subscriptionActivation,
      };
    },
  };
}

function activationIdempotencyKey(input: CheckoutPaymentSucceededInput): string {
  return `checkout-subscription-activation:${input.orderId}:${input.paymentIntentId}`;
}
