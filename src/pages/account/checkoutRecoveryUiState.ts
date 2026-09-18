import type {
  CheckoutRecoveryFallback,
  CheckoutRecoveryOrderSummary,
  CheckoutRecoveryPayResponse,
} from "@/domains/commerce/checkoutRecoveryContracts";
import { persistAccountOrderReturn } from "@/checkout/machine/checkoutNavigation";

export type RecoveryTerminalStatus = "paid" | "cancelled" | "order_changed";

export interface RecoveryStripePayState {
  clientSecret: string;
  order: CheckoutRecoveryOrderSummary;
}

export function recoveryTerminalStatusOf(response: unknown): RecoveryTerminalStatus | null {
  if (typeof response !== "object" || response === null || !("terminalStatus" in response)) return null;
  const value = (response as { terminalStatus?: unknown }).terminalStatus;
  return value === "paid" || value === "cancelled" || value === "order_changed" ? value : null;
}

export function paymentOrderAfterStart(
  order: CheckoutRecoveryOrderSummary,
  result: CheckoutRecoveryPayResponse,
): CheckoutRecoveryOrderSummary {
  return {
    ...order,
    orderId: result.orderId,
    orderRef: `order_${result.orderId}`,
    paymentIntentId: result.paymentIntentId,
  };
}

export function recoveryConflictOutcome(
  reason: string | null,
  mode: CheckoutRecoveryOrderSummary["mode"],
): { status: "already_paid" | "cancelled" | "order_changed" | "fallback"; fallback?: CheckoutRecoveryFallback } {
  if (reason === "paid") return { status: "already_paid" };
  if (reason === "cancelled" || reason === "order_changed") {
    return { status: reason, fallback: "fresh_checkout" };
  }
  return {
    status: "fallback",
    fallback: mode === "subscription_cycle" ? "customer_account" : "fresh_checkout",
  };
}

export function redirectRecoveryPayment(order: CheckoutRecoveryOrderSummary, url: string): void {
  persistAccountOrderReturn({
    orderId: order.orderId,
    orderRef: order.orderRef,
    petName: order.petName ?? "",
    isSubscription: order.mode === "subscription_cycle",
  });
  window.location.assign(url);
}
