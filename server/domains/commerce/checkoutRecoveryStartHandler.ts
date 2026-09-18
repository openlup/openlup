import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  CHECKOUT_RECOVERY_CONTRACT_VERSION,
  type CheckoutRecoveryFallback,
  checkoutRecoveryStartRequestSchema,
  checkoutRecoveryStartResponseSchema,
  type CheckoutRecoveryStartResponse,
} from "../../../src/domains/commerce/checkoutRecoveryContracts.js";
import {
  resolveRecoveryDestination,
  type RecoveryDestinationIntent,
} from "../../../src/domains/commerce/ports.js";
import {
  generateCheckoutRecoveryToken,
  type CheckoutRecoveryTokenPort,
} from "./checkoutRecoveryToken.js";
import type {
  CheckoutRecoveryOwnedOrderContext,
  CheckoutRecoveryPendingOrder,
  CheckoutRecoveryStartReadPort,
} from "./checkoutRecoveryStartPort.js";

/**
 * POST /api/bff/customers/checkout-recovery/start (W5).
 *
 * The in-account "Dokończ płatność" CTA for a logged-in customer. Resolves the
 * customer's own unpaid order for the subscription and mints a FRESH W1 recovery
 * token, returning the raw token so the CTA can deep-link into the same W4
 * pay-page used by the recovery emails (one redeem/pay path for both entry
 * points). No unpaid order ⇒ `recoverable:false` with an explicit fallback:
 * account for subscription context, fresh checkout for one-time orders.
 *
 * Token TTL = order.created_at + 24h (matches the W2 cron + the cancel window) so
 * an in-account token never outlives the order, exactly like the email token.
 */

/** Minimal auth result the BFF route adapts `authenticateCustomerUser` into. */
export type CheckoutRecoveryStartAuthResult =
  | { ok: true; userId: string }
  | { ok: false };

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export interface CheckoutRecoveryStartHandlerDeps {
  authenticateUser: () => Promise<CheckoutRecoveryStartAuthResult>;
  readPort: CheckoutRecoveryStartReadPort;
  tokenPort: CheckoutRecoveryTokenPort;
  recoveryEnabled: () => boolean;
  generateToken?: () => string;
}

export function createCheckoutRecoveryStartHandler({
  authenticateUser,
  readPort,
  tokenPort,
  recoveryEnabled,
  generateToken = generateCheckoutRecoveryToken,
}: CheckoutRecoveryStartHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }
    if (!recoveryEnabled()) {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Checkout recovery is disabled", {
        details: {
          feature: "checkout-recovery",
          featureFlag: "COMMERCE_CHECKOUT_RECOVERY_ENABLED",
          reason: "feature_flag_disabled",
        },
      });
      return;
    }

    const parsed = checkoutRecoveryStartRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid recovery start request", {
        details: parsed.error.flatten(),
      });
      return;
    }

    const auth = await authenticateUser();
    if (!auth.ok) {
      sendBffError(res, "UNAUTHORIZED", "Customer session required", {
        details: { reason: "customer_session_required" },
      });
      return;
    }

    const order =
      "orderId" in parsed.data
        ? await readPort.findRecoverableOrderById({
            userId: auth.userId,
            orderId: parsed.data.orderId,
          })
        : await readPort.findRecoverableOrder({
            userId: auth.userId,
            subscriptionId: parsed.data.subscriptionId,
          });
    if (!order) {
      const fallback =
        "subscriptionId" in parsed.data
          ? checkoutFallbackForDestination(resolveRecoveryDestination({
              state: "unrecoverable",
              source: "checkout_recovery",
              requestedSubscriptionContext: true,
            }))
          : checkoutFallbackForDestination(
              resolveRecoveryDestination({
                state: "unrecoverable",
                source: "checkout_recovery",
                ...(await fallbackFactsForOrderId(readPort, auth.userId, parsed.data.orderId)),
              }),
            );
      sendBffSuccess(res, unrecoverable(fallback), { contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION });
      return;
    }

    const rawToken = generateToken();
    const expiresAt = new Date(new Date(order.createdAt).getTime() + TOKEN_TTL_MS).toISOString();

    try {
      await tokenPort.issue({ orderId: order.orderId, rawToken, expiresAt });
    } catch (error) {
      // Race: the order was paid/cancelled between the read and the mint (the
      // SECURITY DEFINER RPC refuses non-`pending_payment` orders). Treat as
      // unrecoverable rather than 500 — the CTA follows the mode-aware fallback.
      if (isOrderNotRecoverable(error)) {
        sendBffSuccess(res, unrecoverable(checkoutFallbackForDestination(resolveRecoveryDestination({
          state: "unrecoverable",
          source: "checkout_recovery",
          orderMode: order.mode,
          hasOrderSubscription: Boolean(order.subscriptionId),
          clientHasLiveOrPendingSubscription: order.clientHasLiveOrPendingSubscription,
        }))), {
          contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION,
        });
        return;
      }
      throw error;
    }

    const response = checkoutRecoveryStartResponseSchema.parse({
      contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION,
      recoverable: true,
      token: rawToken,
      mode: order.mode,
    });
    sendBffSuccess(res, response, { contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION });
  };
}

function isOrderNotRecoverable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /order_not_recoverable|order_not_found/.test(message);
}

function unrecoverable(fallback: CheckoutRecoveryFallback): CheckoutRecoveryStartResponse {
  return {
    contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION,
    recoverable: false,
    fallback,
  };
}

async function fallbackFactsForOrderId(
  readPort: CheckoutRecoveryStartReadPort,
  userId: string,
  orderId: string,
): Promise<{
  orderMode?: CheckoutRecoveryPendingOrder["mode"] | CheckoutRecoveryOwnedOrderContext["mode"] | null;
  hasOrderSubscription?: boolean;
  clientHasLiveOrPendingSubscription?: boolean;
}> {
  const order = await readPort.findOwnedOrderContextById({ userId, orderId });
  if (order) {
    return {
      orderMode: order.mode,
      hasOrderSubscription: Boolean(order.subscriptionId),
      clientHasLiveOrPendingSubscription: order.clientHasLiveOrPendingSubscription,
    };
  }
  return {
    clientHasLiveOrPendingSubscription: await readPort.clientHasLiveOrPendingSubscription({ userId }),
  };
}

function checkoutFallbackForDestination(intent: RecoveryDestinationIntent): CheckoutRecoveryFallback {
  return intent === "fresh_checkout" ? "fresh_checkout" : "customer_account";
}
