import type { OutboxHandler } from "../../domains/commerce/contracts.js";
import {
  createCapturedCheckoutReminderHandler,
  type ReminderDeliveryAuthorizationPort,
} from "../../domains/commerce/checkoutRecoveryOperations.js";
import type { Env } from "../emailDelivery/outboxStoreBinding.js";
import {
  resolveTransactionalDeliveryBinding,
  type TransactionalDeliveryAction,
  type TransactionalDeliveryBindingOptions,
} from "../communications/transactionalBinding.js";
import {
  resolveCheckoutRecoveryOperationsBinding,
  type CheckoutRecoveryOperationsBindingOptions,
} from "./checkoutRecoveryOperationsBinding.js";
import {
  COMMERCE_CHECKOUT_RECOVERY_EVENT_TYPE,
  COMMERCE_ORDER_DRAFT_ABANDONED_1H_EVENT_TYPE,
  COMMERCE_ORDER_DRAFT_ABANDONED_24H_EVENT_TYPE,
  COMMERCE_ORDER_DRAFT_ABANDONED_72H_EVENT_TYPE,
} from "../../../src/domains/commerce/outboxEventContracts.js";

export interface CheckoutRecoveryOutboxHandlerScope {
  readonly requested: boolean;
  run<T>(work: (handlers: OutboxHandler[]) => Promise<T>): Promise<T>;
}

export type CheckoutRecoveryOutboxHandlerScopeResolution =
  | { scope: CheckoutRecoveryOutboxHandlerScope; error?: never }
  | { scope?: never; error: string };

export function resolveCheckoutRecoveryOutboxHandlerScope(
  env: Env,
  options: {
    transactionalBinding?: TransactionalDeliveryBindingOptions;
    operationsBinding?: CheckoutRecoveryOperationsBindingOptions;
  } = {},
): CheckoutRecoveryOutboxHandlerScopeResolution {
  const requested = env.COMMERCE_ABANDONED_CART_ENABLED === "true"
    || env.COMMERCE_CHECKOUT_RECOVERY_ENABLED === "true";
  if (!requested) {
    return { scope: { requested: false, run: (work) => work([]) } };
  }
  const operations = resolveCheckoutRecoveryOperationsBinding(env, options.operationsBinding);
  if (!operations.binding) return { error: operations.error };
  const delivery = resolveTransactionalDeliveryBinding(env, options.transactionalBinding);
  if (!delivery.binding) return { error: delivery.error };
  return {
    scope: {
      requested: true,
      run: (work) => delivery.binding.run((action) => operations.binding.run(({ deliveryAuthorization }) => {
        if (!deliveryAuthorization) throw new Error("checkout_reminder_authorization_unavailable");
        return work(buildHandlers(env, deliveryAuthorization, action));
      })),
    },
  };
}

function buildHandlers(
  env: Env,
  authorization: ReminderDeliveryAuthorizationPort,
  delivery: TransactionalDeliveryAction,
): OutboxHandler[] {
  const eventTypes = [
    ...(env.COMMERCE_ABANDONED_CART_ENABLED === "true" ? [
      COMMERCE_ORDER_DRAFT_ABANDONED_1H_EVENT_TYPE,
      COMMERCE_ORDER_DRAFT_ABANDONED_24H_EVENT_TYPE,
      COMMERCE_ORDER_DRAFT_ABANDONED_72H_EVENT_TYPE,
    ] : []),
    ...(env.COMMERCE_CHECKOUT_RECOVERY_ENABLED === "true"
      ? [COMMERCE_CHECKOUT_RECOVERY_EVENT_TYPE] : []),
  ];
  return eventTypes.map((eventType) => createCapturedCheckoutReminderHandler({
    eventType,
    authorization,
    delivery,
  }));
}
