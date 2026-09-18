import type { CheckoutRecoveryMode } from "../../../src/domains/commerce/checkoutRecoveryContracts.js";

export interface CheckoutRecoveryPendingOrder {
  orderId: string;
  createdAt: string;
  mode: CheckoutRecoveryMode;
  subscriptionId: string | null;
  clientHasLiveOrPendingSubscription: boolean;
}

export interface CheckoutRecoveryOwnedOrderContext {
  orderId: string;
  mode: CheckoutRecoveryMode;
  subscriptionId: string | null;
  clientHasLiveOrPendingSubscription: boolean;
}

export interface CheckoutRecoveryStartReadPort {
  findRecoverableOrder(input: { userId: string; subscriptionId: string }): Promise<CheckoutRecoveryPendingOrder | null>;
  findRecoverableOrderById(input: { userId: string; orderId: string }): Promise<CheckoutRecoveryPendingOrder | null>;
  findOwnedOrderContextById(input: { userId: string; orderId: string }): Promise<CheckoutRecoveryOwnedOrderContext | null>;
  clientHasLiveOrPendingSubscription(input: { userId: string }): Promise<boolean>;
}
