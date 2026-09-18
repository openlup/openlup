import type {
  CheckoutRecoveryOrderSummary,
  CheckoutRecoveryPayResponse,
} from "@/domains/commerce/checkoutRecoveryContracts";

const STORAGE_KEY_PREFIX = "openlup:checkout-recovery:stripe:v1:";

interface StoredStripeRecoverySession {
  version: 1;
  orderId: string;
  paymentIntentId: string;
  clientId: string;
  confirmationStarted: boolean;
}

function storageKey(orderId: string): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(orderId)}`;
}

export function persistCheckoutRecoveryStripeSession(
  order: CheckoutRecoveryOrderSummary,
  result?: CheckoutRecoveryPayResponse,
): void {
  if (result && !hasCheckoutRecoveryStripeIdentity(order, result)) return;
  const value: StoredStripeRecoverySession = {
    version: 1,
    orderId: order.orderId,
    paymentIntentId: order.paymentIntentId,
    clientId: order.clientId,
    confirmationStarted: false,
  };
  try {
    window.sessionStorage.setItem(storageKey(order.orderId), JSON.stringify(value));
  } catch {
    // In-memory confirmation still works when browser storage is unavailable.
  }
}

export function hasCheckoutRecoveryStripeIdentity(
  order: CheckoutRecoveryOrderSummary,
  result: CheckoutRecoveryPayResponse,
): boolean {
  return result.orderId === order.orderId
    && result.paymentIntentId === order.paymentIntentId
    && result.clientId === order.clientId
    && result.provider === "stripe"
    && result.clientAction.kind === "provider_embedded"
    && result.clientAction.provider === "stripe"
    && Boolean(result.paymentAttemptId)
    && Boolean(result.providerPaymentId);
}

export function checkoutRecoveryStripeConfirmationStarted(
  order: CheckoutRecoveryOrderSummary,
): boolean {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(storageKey(order.orderId)) ?? "null") as
      | Partial<StoredStripeRecoverySession>
      | null;
    return value?.version === 1
      && value.orderId === order.orderId
      && value.paymentIntentId === order.paymentIntentId
      && value.clientId === order.clientId
      && value.confirmationStarted === true;
  } catch {
    clearCheckoutRecoveryStripeSession(order.orderId);
    return false;
  }
}

export function setCheckoutRecoveryStripeConfirmationStarted(
  orderId: string,
  confirmationStarted: boolean,
): void {
  try {
    const key = storageKey(orderId);
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return;
    const value = JSON.parse(raw) as StoredStripeRecoverySession;
    window.sessionStorage.setItem(key, JSON.stringify({ ...value, confirmationStarted }));
  } catch {
    clearCheckoutRecoveryStripeSession(orderId);
  }
}

export function clearCheckoutRecoveryStripeSession(orderId: string): void {
  try {
    window.sessionStorage.removeItem(storageKey(orderId));
  } catch {
    // no-op
  }
}

export function clearAllCheckoutRecoveryStripeSessions(): void {
  try {
    for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(STORAGE_KEY_PREFIX)) window.sessionStorage.removeItem(key);
    }
  } catch {
    // no-op
  }
}
