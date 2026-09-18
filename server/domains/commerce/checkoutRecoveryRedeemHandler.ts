import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import {
  CHECKOUT_RECOVERY_CONTRACT_VERSION,
  CHECKOUT_RECOVERY_RECREATE_CAPABILITY,
  CHECKOUT_RECOVERY_RESOLVE_ACTIVE_PAYMENT_CAPABILITY,
  checkoutRecoveryRedeemRequestSchema,
  checkoutRecoveryRedeemResponseSchema,
  type CheckoutRecoveryFallback,
  type CheckoutRecoveryMode,
  type CheckoutRecoveryPaymentResolution,
  type CheckoutRecoveryRedeemResponse,
  type CheckoutRecoveryTerminalStatus,
} from "../../../src/domains/commerce/checkoutRecoveryContracts.js";
import type { ExpiredCheckoutRecoveryService } from "./expiredCheckoutRecoveryService.js";
import { classifyExpiredRecovery } from "./checkoutExpiredRecoveryPolicy.js";
import type { CheckoutRecoveryTokenInspection, CheckoutRecoveryTokenPort } from "./checkoutRecoveryToken.js";
import type { CheckoutRecoveryOrderReadPort, CheckoutRecoveryOrderSnapshot } from "./checkoutRecoveryOrderPort.js";
import type { CheckoutRecoverySubscriptionContextPort } from "./checkoutRecoverySubscriptionContextPort.js";
import { fallbackForRecoveryContext } from "./checkoutRecoveryDestination.js";
import { classifyTechnicalExpiryForRedeem, latestRecoveryOrder } from "./checkoutRecoveryTechnicalExpiry.js";

export interface CheckoutRecoveryPaymentResolverPort {
  resolve(input: { orderId: string; paymentIntentId: string | null; intentStatus?: string | null }): Promise<CheckoutRecoveryPaymentResolution | { kind: "paid" }>;
}
export interface CheckoutRecoveryRedeemHandlerDeps {
  tokenPort: CheckoutRecoveryTokenPort;
  orderPort: CheckoutRecoveryOrderReadPort;
  subscriptionContextPort: CheckoutRecoverySubscriptionContextPort;
  recoveryEnabled: () => boolean;
  expiredRecoveryService?: ExpiredCheckoutRecoveryService;
  paymentResolver?: CheckoutRecoveryPaymentResolverPort;
  now?: () => Date;
}
export function createCheckoutRecoveryRedeemHandler(
  { tokenPort, orderPort, subscriptionContextPort, recoveryEnabled, expiredRecoveryService, paymentResolver, now = () => new Date() }:
  CheckoutRecoveryRedeemHandlerDeps,
) {
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

    const parsed = checkoutRecoveryRedeemRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid recovery redeem request", {
        details: parsed.error.flatten(),
      });
      return;
    }

    const supportsExpiredRecreation =
      parsed.data.capabilities?.includes(CHECKOUT_RECOVERY_RECREATE_CAPABILITY) === true;
    const resolvesActivePayment =
      parsed.data.capabilities?.includes(CHECKOUT_RECOVERY_RESOLVE_ACTIVE_PAYMENT_CAPABILITY) === true;
    const resolvePayment = async (
      snapshot: CheckoutRecoveryOrderSnapshot,
    ): Promise<CheckoutRecoveryPaymentResolution | { kind: "paid" } | undefined> => {
      if (!resolvesActivePayment) return undefined;
      if (!paymentResolver) return { kind: "awaiting_provider" };
      return paymentResolver.resolve({
        orderId: snapshot.orderId,
        paymentIntentId: snapshot.paymentIntentId,
        intentStatus: snapshot.paymentIntentStatus,
      });
    };
    const sendRecoverable = async (
      snapshot: CheckoutRecoveryOrderSnapshot,
      clientId: string,
      recoveryKind?: "retry_existing" | "recreate_expired",
      contextMode: string = snapshot.mode,
    ): Promise<void> => {
      const paymentResolution = await resolvePayment(snapshot);
      if (paymentResolution?.kind === "paid") {
        const current = await orderPort.getRecoveryOrder({ orderId: snapshot.orderId });
        sendBffSuccess(res, unrecoverable(
          await fallbackForRecoveryContext(subscriptionContextPort, current ?? snapshot, clientId),
          current?.status === "paid" ? paidOrderFromSnapshot(current, clientId) : undefined,
          "paid",
        ), { contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION });
        return;
      }
      sendBffSuccess(res, recoverable(snapshot, clientId, recoveryKind, contextMode, paymentResolution),
        { contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION });
    };
    const context = await tokenPort.validate(parsed.data.token);
    if (!context) {
      const inspection = await tokenPort.inspect(parsed.data.token);
      let snapshot: CheckoutRecoveryOrderSnapshot | null = null;
      if (supportsExpiredRecreation && inspection && expiredRecoveryService) {
        snapshot = await latestRecoveryOrder(orderPort, inspection.orderId);
        if (
          snapshot?.status === "pending_payment" &&
          snapshot.paymentIntentId &&
          snapshot.clientId === inspection.clientId &&
          snapshot.technicallyExpired !== true
        ) {
          await sendRecoverable(snapshot, inspection.clientId, "retry_existing");
          return;
        }
        const eligibility = classifyExpiredRecovery({ inspection, order: snapshot, now: now() });
        if (eligibility.kind === "paid") {
          sendBffSuccess(res, unrecoverable(
            await fallbackForRecoveryContext(subscriptionContextPort, snapshot ?? inspection),
            snapshot?.status === "paid"
              ? paidOrderFromSnapshot(snapshot, inspection.clientId)
              : await readPaidOrder(orderPort, inspection.orderId, inspection.clientId),
            "paid",
          ), {
            contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION,
          });
          return;
        }
        if (eligibility.kind === "cancelled") {
          sendBffSuccess(res, unrecoverable(
            await fallbackForRecoveryContext(subscriptionContextPort, snapshot ?? inspection),
            undefined,
            "cancelled",
          ), {
            contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION,
          });
          return;
        }
        if (eligibility.kind === "eligible" && snapshot) {
          const unchanged = await expiredRecoveryService.validate(snapshot);
          if (!unchanged) {
            sendBffSuccess(res, unrecoverable(
              await fallbackForRecoveryContext(subscriptionContextPort, snapshot, inspection.clientId),
              undefined,
              "order_changed",
            ), {
              contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION,
            });
            return;
          }
          await sendRecoverable(snapshot, inspection.clientId, "recreate_expired");
          return;
        }
      }
      const paidOrder = inspection?.status === "paid"
        ? await readPaidOrder(orderPort, inspection.orderId, inspection.clientId)
        : undefined;
      // Dead token/order (expired, paid, or swept). The fallback is success-shaped
      // (HTTP 200) so the page can branch on `recoverable` rather than catching a
      // network error — a 404 would be indistinguishable from a route mismatch.
      sendBffSuccess(res, unrecoverable(
        await fallbackForRecoveryContext(subscriptionContextPort, inspection),
        paidOrder,
        terminalStatusForRecoveryContext(snapshot ?? inspection),
      ), {
        contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION,
      });
      return;
    }

    let snapshot = await orderPort.getRecoveryOrder({ orderId: context.orderId });
    if (!snapshot || snapshot.status !== "pending_payment" || !snapshot.paymentIntentId) {
      const terminalContext = snapshot ?? context;
      const paidOrder = snapshot?.status === "paid"
        ? paidOrderFromSnapshot(snapshot, context.clientId)
        : undefined;
      sendBffSuccess(res, unrecoverable(
        await fallbackForRecoveryContext(subscriptionContextPort, terminalContext, context.clientId),
        paidOrder,
        terminalStatusForRecoveryContext(terminalContext),
      ), {
        contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION,
      });
      return;
    }

    if (snapshot.technicallyExpired === true) {
      if (!supportsExpiredRecreation || !expiredRecoveryService) {
        sendBffSuccess(res, unrecoverable(
          await fallbackForRecoveryContext(subscriptionContextPort, snapshot, context.clientId),
          undefined,
          "order_changed",
        ), { contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION });
        return;
      }
      const outcome = await classifyTechnicalExpiryForRedeem({
        rawToken: parsed.data.token,
        context,
        tokenPort,
        orderPort,
        expiredRecoveryService,
        now: now(),
      });
      snapshot = outcome.snapshot;
      if (outcome.kind === "retry_existing" || outcome.kind === "recreate_expired") {
        await sendRecoverable(snapshot!, outcome.inspection.clientId, outcome.kind);
        return;
      }
      if (outcome.kind === "paid") {
        sendBffSuccess(res, unrecoverable(
          await fallbackForRecoveryContext(subscriptionContextPort, snapshot ?? outcome.inspection),
          snapshot?.status === "paid"
            ? paidOrderFromSnapshot(snapshot, outcome.inspection.clientId)
            : await readPaidOrder(orderPort, outcome.inspection.orderId, outcome.inspection.clientId),
          "paid",
        ), { contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION });
        return;
      }
      sendBffSuccess(res, unrecoverable(
        await fallbackForRecoveryContext(subscriptionContextPort, snapshot ?? outcome.inspection),
        undefined,
        outcome.kind,
      ), { contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION });
      return;
    }

    await sendRecoverable(snapshot, context.clientId,
      supportsExpiredRecreation ? "retry_existing" : undefined, context.mode);
  };
}

function recoverable(
  snapshot: CheckoutRecoveryOrderSnapshot,
  clientId: string,
  recoveryKind: "retry_existing" | "recreate_expired" | undefined,
  contextMode: string = snapshot.mode,
  paymentResolution?: Exclude<CheckoutRecoveryPaymentResolution, { kind: "paid" }>,
): CheckoutRecoveryRedeemResponse {
  return checkoutRecoveryRedeemResponseSchema.parse({
    contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION,
    recoverable: true,
    ...(recoveryKind ? { recoveryKind } : {}),
    ...(paymentResolution ? { paymentResolution } : {}),
    order: {
      orderId: snapshot.orderId,
      orderRef: snapshot.orderRef,
      orderNumber: snapshot.orderNumber,
      clientId,
      paymentIntentId: snapshot.paymentIntentId,
      mode: normalizeMode(snapshot.mode, contextMode),
      total: { amountMinor: snapshot.totalMinor, currency: snapshot.currency },
      petName: snapshot.petName,
      cadenceDays: snapshot.cadenceDays,
      createdAt: snapshot.createdAt,
    },
  });
}

function normalizeMode(snapshotMode: CheckoutRecoveryMode, contextMode: string): CheckoutRecoveryMode {
  // The order row mode is authoritative; the token context mode is a fallback.
  if (snapshotMode === "subscription_cycle" || snapshotMode === "one_time_order") {
    return snapshotMode;
  }
  return contextMode === "subscription_cycle" ? "subscription_cycle" : "one_time_order";
}

function unrecoverable(
  fallback: CheckoutRecoveryFallback,
  paidOrder?: { orderId: string; orderRef: string; clientId: string },
  terminalStatus?: CheckoutRecoveryTerminalStatus,
): CheckoutRecoveryRedeemResponse {
  return checkoutRecoveryRedeemResponseSchema.parse({
    contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION,
    recoverable: false,
    fallback,
    ...(paidOrder ? { paidOrder } : {}),
    ...(terminalStatus ? { terminalStatus } : {}),
  });
}
function terminalStatusForRecoveryContext(
  context:
    | CheckoutRecoveryTokenInspection
    | CheckoutRecoveryOrderSnapshot
    | { status?: string | null }
    | null,
): CheckoutRecoveryTerminalStatus | undefined {
  return context?.status === "paid" ? "paid" : context?.status === "pending_payment" && "technicallyExpired" in context && context.technicallyExpired === true ? "order_changed" : undefined;
}

async function readPaidOrder(
  orderPort: CheckoutRecoveryOrderReadPort,
  orderId: string,
  clientId: string,
): Promise<{ orderId: string; orderRef: string; clientId: string } | undefined> {
  const snapshot = await orderPort.getRecoveryOrder({ orderId });
  return snapshot?.status === "paid" ? paidOrderFromSnapshot(snapshot, clientId) : undefined;
}

function paidOrderFromSnapshot(
  snapshot: CheckoutRecoveryOrderSnapshot,
  clientId: string,
): { orderId: string; orderRef: string; clientId: string } {
  return { orderId: snapshot.orderId, orderRef: snapshot.orderRef, clientId };
}
