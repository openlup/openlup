import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  CHECKOUT_RECOVERY_CONTRACT_VERSION,
  CHECKOUT_RECOVERY_RECREATE_CAPABILITY,
  checkoutRecoveryPayRequestSchema,
  checkoutRecoveryPayResponseSchema,
} from "../../../src/domains/commerce/checkoutRecoveryContracts.js";
import type { CheckoutRecoveryTokenPort } from "./checkoutRecoveryToken.js";
import type { CheckoutRecoveryOrderReadPort } from "./checkoutRecoveryOrderPort.js";
import {
  CheckoutRecoveryPayError,
  type CheckoutRecoveryPayService,
} from "./checkoutRecoveryPayService.js";
import { CommerceRuntimeConflictError } from "../../../src/domains/commerce/runtimePorts.js";
import {
  ExpiredCheckoutRecoveryError,
  type ExpiredCheckoutRecoveryService,
} from "./expiredCheckoutRecoveryService.js";
import { classifyExpiredRecovery } from "./checkoutExpiredRecoveryPolicy.js";

/**
 * POST /api/bff/commerce/checkout-recovery/pay (W4).
 *
 * Validates the W1 token, loads the durable order, and orchestrates a FRESH
 * provider attempt on the SAME internal intent. For the rehearsal/simulator the
 * service applies the succeeded result so the order flips paid + the sub
 * activates; real PSPs return processing + a clientAction the FE drives.
 *
 * Capability-aware clients may recreate an eligible system-expired checkout as
 * a fresh order/runtime. Manual cancellations and money-moved states remain
 * terminal and never dispatch a provider attempt.
 */

export interface CheckoutRecoveryPayHandlerDeps {
  tokenPort: CheckoutRecoveryTokenPort;
  orderPort: CheckoutRecoveryOrderReadPort;
  payService: CheckoutRecoveryPayService;
  recoveryEnabled: () => boolean;
  expiredRecoveryService?: ExpiredCheckoutRecoveryService;
  now?: () => Date;
}

export function createCheckoutRecoveryPayHandler({
  tokenPort,
  orderPort,
  payService,
  recoveryEnabled,
  expiredRecoveryService,
  now = () => new Date(),
}: CheckoutRecoveryPayHandlerDeps) {
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

    const parsed = checkoutRecoveryPayRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid recovery pay request", {
        details: parsed.error.flatten(),
      });
      return;
    }

    let context = await tokenPort.validate(parsed.data.token);
    let snapshot = context
      ? await orderPort.getRecoveryOrder({ orderId: context.orderId })
      : null;
    const supportsExpiredRecreation = parsed.data.capabilities?.includes(
      CHECKOUT_RECOVERY_RECREATE_CAPABILITY,
    ) === true;

    if (supportsExpiredRecreation && expiredRecoveryService && (!context || snapshot?.technicallyExpired === true)) {
      const inspected = await tokenPort.inspect(parsed.data.token);
      // validate() can still return an active token for an order whose payment
      // metadata later became technically expired. If inspect unexpectedly fails,
      // the active validation context still proves token/client/order authority;
      // use it only to classify/recreate, never to make a dead order payable.
      const inspection = inspected ?? (context
        ? {
          tokenId: context.tokenId,
          orderId: context.orderId,
          clientId: context.clientId,
          mode: context.mode,
          status: context.status,
          subscriptionId: null,
          tokenState: "active",
        }
        : null);
      snapshot = inspection
        ? await latestRecoveryOrder(orderPort, inspection.orderId)
        : snapshot;
      if (
        inspection &&
        snapshot?.status === "pending_payment" &&
        snapshot.paymentIntentId &&
        snapshot.clientId === inspection.clientId &&
        snapshot.technicallyExpired !== true
      ) {
        context = {
          tokenId: inspection.tokenId,
          orderId: snapshot.orderId,
          clientId: inspection.clientId,
          mode: snapshot.mode,
          status: snapshot.status,
        };
      } else {
        const eligibility = classifyExpiredRecovery({ inspection, order: snapshot, now: now() });
        if (eligibility.kind === "eligible" && inspection && snapshot) {
          try {
            const result = await expiredRecoveryService.recreate({
              order: snapshot,
              clientId: inspection.clientId,
              paymentProvider: parsed.data.paymentProvider,
              paymentExecution: parsed.data.paymentExecution,
            });
            sendPayResponse(res, result);
          } catch (error) {
            if (error instanceof ExpiredCheckoutRecoveryError) {
              const unavailable = error.reason === "execution_failed";
              sendBffError(
                res,
                unavailable ? "UPSTREAM_UNAVAILABLE" : "CONFLICT",
                "Expired checkout could not be recreated",
                { details: { reason: error.reason } },
              );
              return;
            }
            throw error;
          }
          return;
        }
        if (eligibility.kind === "paid" || eligibility.kind === "cancelled") {
          sendBffError(res, "CONFLICT", "Order can no longer be recovered", {
            details: { reason: eligibility.kind },
          });
          return;
        }
        // A technically expired order must never fall through to payService.pay.
        // Missing quote/shipping/catalog evidence is intentionally treated as a
        // changed order so the customer starts a fresh, stock-checked checkout.
        sendBffError(res, "CONFLICT", "Order can no longer be recovered", {
          details: { reason: "order_changed" },
        });
        return;
      }
    }

    if (!context) {
      sendBffError(res, "CONFLICT", "Recovery link is no longer valid", {
        details: { reason: "token_expired_or_consumed" },
      });
      return;
    }

    if (snapshot?.technicallyExpired === true) {
      sendBffError(res, "CONFLICT", "Order can no longer be recovered", {
        details: { reason: "order_changed" },
      });
      return;
    }

    if (!snapshot || snapshot.status !== "pending_payment" || !snapshot.paymentIntentId) {
      sendBffError(res, "CONFLICT", "Order can no longer be recovered", {
        details: { reason: "order_not_recoverable" },
      });
      return;
    }

    try {
      const result = await payService.pay({
        order: snapshot,
        clientId: context.clientId,
        paymentProvider: parsed.data.paymentProvider,
        paymentExecution: parsed.data.paymentExecution,
        idempotencyKey: parsed.data.idempotencyKey,
      });

      sendPayResponse(res, result);
    } catch (error) {
      if (error instanceof CheckoutRecoveryPayError) {
        // A prepared/current attempt conflict does not invalidate the recovery
        // token or order. Surface a retry-later error so the customer stays on
        // this same-order flow; 409 is reserved for genuinely dead authority.
        const upstreamUnavailable =
          error.code === "provider_execution_failed" ||
          error.code === "provider_attempt_in_flight" ||
          error.code === "payment_intent_in_flight" ||
          error.code === "stripe_client_secret_missing";
        const errorCode = upstreamUnavailable ? "UPSTREAM_UNAVAILABLE" : "CONFLICT";
        sendBffError(res, errorCode, "Recovery payment could not be started", {
          details: { reason: error.code },
        });
        return;
      }
      if (error instanceof CommerceRuntimeConflictError) {
        if (error.details.reason === "payment_control_subscription_not_chargeable") {
          sendBffError(res, "CONFLICT", "Order can no longer be recovered", {
            details: { reason: "order_not_recoverable" },
          });
          return;
        }
        sendBffError(res, "UPSTREAM_UNAVAILABLE", "Recovery payment could not be started", {
          details: { reason: "payment_control_conflict" },
        });
        return;
      }
      throw error;
    }
  };
}

function latestRecoveryOrder(
  orderPort: CheckoutRecoveryOrderReadPort,
  orderId: string,
) {
  return orderPort.getLatestRecoveryOrder
    ? orderPort.getLatestRecoveryOrder({ orderId })
    : orderPort.getRecoveryOrder({ orderId });
}

function sendPayResponse(
  res: VercelResponse,
  result: {
    orderId: string;
    paymentIntentId: string;
    clientId: string;
    status: string;
    paymentAttemptId: string | null;
    provider: string;
    providerPaymentId: string | null;
    failureReason?: string | null;
    clientAction: unknown;
  },
): void {
  const response = checkoutRecoveryPayResponseSchema.parse({
    contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION,
    ...result,
  });
  sendBffSuccess(res, response, { contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION });
}
