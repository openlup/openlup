import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import {
  adminCommerceOrderPaymentLinkRequestSchema,
  adminCommerceOrderPaymentLinkResponseSchema,
  type AdminCommerceOrderPaymentLinkRefusal,
} from "../../../src/domains/commerce/omsContracts.js";
import { authorize, type BaseDeps } from "./commerceOmsHandlers.js";
import {
  EXPIRED_CHECKOUT_RECOVERY_WINDOW_MS,
  classifyOrderRecoveryEligibility,
} from "./checkoutExpiredRecoveryPolicy.js";
import type {
  CheckoutRecoveryOrderReadPort,
  CheckoutRecoveryOrderSnapshot,
} from "./checkoutRecoveryOrderPort.js";
import {
  generateCheckoutRecoveryToken,
  hashCheckoutRecoveryToken,
} from "./checkoutRecoveryToken.js";
import type { CheckoutPaymentLinkTokenStore } from "../../adapters/managed/commerce/checkoutPaymentLinkTokenStore.js";

/**
 * POST /api/bff/admin/commerce/orders/payment-link — the operator's entry point
 * onto the existing checkout-recovery rail.
 *
 * Support gets a copyable deep-link for an order the customer never managed to
 * pay. Nothing about redeem, pay or status changes: this mints the SAME token the
 * recovery emails carry, with the SAME hash canon, judged by the SAME eligibility
 * predicate the redeem side uses (`classifyOrderRecoveryEligibility`). A link
 * this route hands over and a link the rail refuses cannot diverge, because there
 * is one implementation of the question.
 *
 * Refusals use a closed vocabulary so the operator surface can render a sentence
 * per reason and no database text ever reaches a screen.
 *
 * The link travels one of two ways, chosen by `delivery`. `copy` hands it back
 * for the operator to paste. `email` also puts it on the transactional recovery
 * rail addressed to the order's own customer — the SAME event type, template and
 * dispatcher the recovery nudges already use, so this route adds a producer and
 * not a second delivery path.
 */

/**
 * A week is long enough for a support conversation to finish and short enough
 * that a forwarded email does not stay redeemable for a month.
 */
export const ADMIN_PAYMENT_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AdminCheckoutPaymentLinkHandlerDeps extends BaseDeps {
  orderPort: Pick<CheckoutRecoveryOrderReadPort, "getRecoveryOrder">;
  tokenStore: CheckoutPaymentLinkTokenStore;
  /**
   * The redeem side's own frozen-vs-fresh commercial check, run BEFORE minting so
   * the operator learns here — not the customer on a dead page — that the order's
   * prices or contents no longer reprice to what was agreed. Read-only: it quotes
   * and compares, it recreates nothing. Optional so the domain stays testable
   * without a pricing rail; absent means the check is skipped.
   */
  validateRecreate?: (order: CheckoutRecoveryOrderSnapshot) => Promise<boolean>;
  generateToken?: () => string;
  now?: () => Date;
}

export function createAdminCheckoutPaymentLinkHandler({
  authorizeAdmin,
  orderPort,
  tokenStore,
  validateRecreate,
  generateToken = generateCheckoutRecoveryToken,
  now = () => new Date(),
}: AdminCheckoutPaymentLinkHandlerDeps) {
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const auth = await authorize(req, res, authorizeAdmin);
    if (!auth) return;

    const request = adminCommerceOrderPaymentLinkRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid admin commerce payment link request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const order = await orderPort.getRecoveryOrder({ orderId: request.data.orderId });
      if (!order) return refuse(res, "order_not_found");

      const at = now();
      const refusal = eligibilityRefusal(order.status, order, at);
      if (refusal) return refuse(res, refusal);

      // The link must buy the SAME basket at the SAME sum the customer agreed to.
      // `pending_payment` is exempt by construction: redeem returns that very
      // order, with its own frozen totals, and never reprices. Every other state
      // redeems by RECREATING the order from its quote snapshot, so if the
      // catalogue, a price or a promotion has moved since, the recreate the
      // customer would hit refuses — and the operator would have handed over a
      // link that dead-ends. Asking the redeem rail's own check first turns that
      // into a refusal the operator can read and act on.
      if (order.status !== "pending_payment" && validateRecreate && !(await validateRecreate(order))) {
        return refuse(res, "order_changed");
      }

      // A link must never outlive the window the redeem side will still recreate
      // an expired order inside, so the shorter of the two deadlines wins.
      const expiresAtMs = Math.min(
        at.getTime() + ADMIN_PAYMENT_LINK_TTL_MS,
        Date.parse(order.createdAt) + EXPIRED_CHECKOUT_RECOVERY_WINDOW_MS,
      );
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= at.getTime()) {
        return refuse(res, "order_not_recoverable");
      }
      const expiresAt = new Date(expiresAtMs).toISOString();

      const rawToken = generateToken();
      // ⛔ Revoke BEFORE inserting, never after. If the process dies between the
      // two writes the order is left with zero live links — the operator clicks
      // again and gets one. The other order leaves two live bearer links on a
      // failure, and the one nobody knows about is the one that stays redeemable.
      await tokenStore.revokeActive(order.orderId);
      const tokenId = await tokenStore.insert({
        orderId: order.orderId,
        clientId: order.clientId,
        tokenHash: hashCheckoutRecoveryToken(rawToken),
        expiresAt,
      });

      const emailRequested = request.data.delivery === "email";
      if (emailRequested) {
        // Enqueued AFTER the mint, and its failure is a failure of the whole
        // command: `emailQueued: true` beside a link that was never handed to the
        // rail is the one outcome worse than no button, because the operator then
        // tells the customer to expect an email nobody will ever send. A throw
        // here lands in the catch below as UPSTREAM_UNAVAILABLE.
        //
        // The retry is safe because it re-mints: the key is per TOKEN ROW, and the
        // operator's second click writes a new row, so it enqueues under a new key
        // rather than colliding with the row this attempt may already have written.
        await tokenStore.enqueueRecoveryEmail({
          orderId: order.orderId,
          tokenId,
          rawToken,
          // The vocabulary the recovery rail's own producer uses, read off the
          // order rather than restated, so an operator email and a cron nudge
          // describe the same order the same way.
          mode: order.subscriptionCycleId ? "subscription_cycle" : "one_time",
          expiresAt,
        });
      }

      const response = adminCommerceOrderPaymentLinkResponseSchema.safeParse({
        token: rawToken,
        expiresAt,
        orderRef: order.orderRef,
        // Always present rather than present-when-true: an absent field cannot be
        // told apart from an older deployment that never queues, and the operator
        // surface has to say something definite about what just happened.
        emailQueued: emailRequested,
      });
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Admin commerce payment link returned invalid response");
        return;
      }
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin commerce payment link failed");
    }
  };
}

/**
 * `pending_payment` is the ordinary case and needs no recovery judgement: the
 * order is still waiting to be paid exactly as checkout left it. Everything else
 * is asked of the shared predicate, so an expired order the rail would refuse is
 * refused here too, before a token exists.
 */
function eligibilityRefusal(
  status: string,
  order: Parameters<typeof classifyOrderRecoveryEligibility>[0],
  at: Date,
): AdminCommerceOrderPaymentLinkRefusal | null {
  if (status === "paid") return "order_paid";
  if (status === "pending_payment") return null;
  const eligibility = classifyOrderRecoveryEligibility(order, at);
  if (eligibility.kind === "eligible") return null;
  if (eligibility.kind === "paid") return "order_paid";
  if (eligibility.kind === "cancelled") return "order_cancelled";
  return "order_not_recoverable";
}

function refuse(res: HttpResponse, reason: AdminCommerceOrderPaymentLinkRefusal): void {
  // `order_not_found` is the only refusal that is about the address rather than
  // the order's state, so it is the only 404; the rest are conflicts with a
  // state the operator can see on the same screen.
  const code = reason === "order_not_found" ? "NOT_FOUND" : "CONFLICT";
  sendBffError(res, code, "Admin commerce payment link refused", { details: { reason } });
}
