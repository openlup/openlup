import { withObservedRoute } from "../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import { readCommerceServiceDataGateway } from "./serviceDataGateway.js";
import {
  createCheckoutPaymentContinuationCodec,
  type CheckoutPaymentContinuationClaims,
} from "../../domains/commerce/checkoutPaymentContinuationCredential.js";
import {
  createSupabaseCheckoutRecoveryTokenPort,
  type CheckoutRecoveryTokenSupabaseClient,
} from "../../adapters/supabase/commerce/checkoutRecoveryToken.js";
import {
  createSupabaseCheckoutRecoveryOrderPort,
  type CheckoutRecoveryOrderSupabaseClient,
} from "../../adapters/supabase/commerce/checkoutRecoveryOrder.js";
import {
  generateCheckoutRecoveryToken,
  type CheckoutRecoveryTokenPort,
} from "../../domains/commerce/checkoutRecoveryToken.js";
import type { CheckoutRecoveryOrderReadPort } from "../../domains/commerce/checkoutRecoveryOrderPort.js";
import {
  createBuyerCheckoutRecoveryEnqueue,
  type BuyerCheckoutRecoveryOutboxClient,
  type BuyerCheckoutRecoveryOutboxRow,
} from "../../adapters/managed/commerce/checkoutPaymentLinkTokenStore.js";

/**
 * POST /api/bff/commerce/checkout-payment-link — the buyer's own escape hatch off
 * a payment step that will not finish.
 *
 * Every card checkout that ended `failed` in the 30 days to 2026-09-03 had, at the
 * provider, no payment method attached and no error: the card never left the
 * browser, and two thirds of those buyers were inside an in-app webview. Nothing
 * on the page can rescue that, because the surface that would report the dead end
 * IS the surface that failed. What rescues it is leaving the webview entirely, and
 * the one door out that costs the buyer nothing is an email to themselves.
 *
 * Authority is the continuation cookie `payment-status` already verifies: signed,
 * HttpOnly, SameSite=Strict, short-lived, and bound to ONE order. There is no
 * request body at all, so there is nothing to authorize beyond that cookie and
 * nothing an attacker can aim: the only order a caller can ever mint a link for is
 * the order their own cookie names. Without valid claims the answer is `401` and
 * no read happens.
 *
 * The mint is the CUSTOMER rail (`commerce_checkout_recovery_token_issue`), never
 * the operator store. Two reasons, both load-bearing. The customer rail admits
 * only a `pending_payment` order, which is exactly the state a stuck buyer is in
 * and the only state this hatch should serve. And it never REVOKES what it
 * replaces: a buyer who taps twice keeps the first email's link working, where the
 * operator store's revoke-then-insert would silently break it.
 *
 * The send is deduped by the outbox table rather than by this route. The
 * idempotency key buckets to ten minutes, so however many times the control is
 * tapped, at most one email per order exists per bucket — the second tap mints a
 * token and enqueues a row the table discards. That ordering matters: a route that
 * decided for itself whether to send would have to read before writing, and two
 * taps racing that read is how one buyer gets two emails.
 */

/**
 * The rail's own TTL, not a new one. The enqueue cron
 * (`20260708090001_checkout_recovery_enqueue.sql`) and the in-account start
 * handler (`checkoutRecoveryStartHandler.ts`) both expire a customer recovery
 * token at `order.created_at + 24h`, which is also the window the abandonment
 * sweep works in. A hatch token that outlived that would be a link to an order
 * already cancelled underneath it.
 */
const CHECKOUT_RECOVERY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * One bucket, one email. Ten minutes is long enough that a buyer tapping through
 * a webview's own lag cannot mail themselves twice, and short enough that someone
 * who genuinely lost the first mail can ask again inside the same checkout.
 */
const BUYER_SEND_BUCKET_MS = 10 * 60 * 1000;

const CHECKOUT_RECOVERY_EVENT_TYPE = "commerce.checkout_recovery";
const BUYER_IDEMPOTENCY_PREFIX = "checkout_recovery:buyer:";
const BUYER_EVENT_SOURCE = "buyer_payment_link";

export interface CheckoutPaymentLinkHandlerDeps {
  /** Continuation claims for this request, or null when the cookie is absent/invalid. */
  readClaims: (cookieHeader: unknown) => CheckoutPaymentContinuationClaims | null;
  orderPort: Pick<CheckoutRecoveryOrderReadPort, "getRecoveryOrder">;
  tokenPort: Pick<CheckoutRecoveryTokenPort, "issue">;
  enqueue: (row: BuyerCheckoutRecoveryOutboxRow) => Promise<void>;
  generateToken?: () => string;
  now?: () => Date;
}

export function createCheckoutPaymentLinkHandler({
  readClaims,
  orderPort,
  tokenPort,
  enqueue,
  generateToken = generateCheckoutRecoveryToken,
  now = () => new Date(),
}: CheckoutPaymentLinkHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    const claims = readClaims(req.headers.cookie);
    if (!claims) {
      // One reason for "no secret configured" and "no valid cookie" on purpose.
      // They are the same fact to the caller — this browser cannot prove which
      // order it is finishing — and telling them apart would say whether the
      // deployment holds the signing secret.
      sendBffError(res, "UNAUTHORIZED", "Checkout continuation required", {
        details: { feature: "checkout-payment-link", reason: "continuation_missing" },
      });
      return;
    }

    try {
      const order = await orderPort.getRecoveryOrder({ orderId: claims.orderId });
      // The cookie is signed over one order AND one client. A row that now names
      // a different client is not the order this credential authorizes, whatever
      // the signature says, so it is refused as unrecoverable rather than served.
      if (!order || order.clientId !== claims.clientId) {
        refuseNotRecoverable(res);
        return;
      }

      const rawToken = generateToken();
      const at = now();
      const expiresAt = new Date(
        Date.parse(order.createdAt) + CHECKOUT_RECOVERY_TOKEN_TTL_MS,
      ).toISOString();
      // The mint is the authority on recoverability, not a status read here: the
      // RPC takes the order row FOR UPDATE and refuses anything that is not
      // `pending_payment`, so an order paid between the read above and this line
      // is refused rather than mailed a link to a settled order.
      await tokenPort.issue({ orderId: order.orderId, rawToken, expiresAt });

      await enqueue({
        aggregate_type: "commerce_order",
        aggregate_id: order.orderId,
        event_type: CHECKOUT_RECOVERY_EVENT_TYPE,
        idempotency_key: `${BUYER_IDEMPOTENCY_PREFIX}${order.orderId}:${sendBucket(at)}`,
        payload: {
          orderId: order.orderId,
          recoveryToken: rawToken,
          // The order's own vocabulary, read off the row exactly as the enqueue
          // cron reads it, so a buyer's email and a cron nudge describe the same
          // order the same way.
          mode: order.subscriptionCycleId ? "subscription_cycle" : "one_time",
          // The marker the delivery side keys the buyer case on. Without it the
          // handler would judge this row by the cron's politeness rule and defer
          // it as `payment_session_active` — which is the exact state every buyer
          // who taps this control is in, so the hatch would send nothing, ever.
          buyerRequested: true,
        },
        metadata: { source: BUYER_EVENT_SOURCE },
      });

      sendBffSuccess(res, { sent: true });
    } catch (error) {
      if (isOrderNotRecoverable(error)) {
        refuseNotRecoverable(res);
        return;
      }
      // The provider/database message never reaches the browser: this route is
      // reachable by anyone holding a checkout cookie, and a raw error text is
      // schema and state disclosure for the price of one failed tap.
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Checkout payment link failed", {
        details: { feature: "checkout-payment-link", reason: "mint_failed" },
      });
    }
  };
}

/** Ten-minute bucket; the whole dedupe policy, expressed once. */
function sendBucket(at: Date): number {
  return Math.floor(at.getTime() / BUYER_SEND_BUCKET_MS);
}

function refuseNotRecoverable(res: VercelResponse): void {
  sendBffError(res, "CONFLICT", "Checkout payment link refused", {
    details: { reason: "order_not_recoverable" },
  });
}

/**
 * Matched on the RPC's own two raised conditions, the way
 * `checkoutRecoveryStartHandler` matches them. Anything else is an outage, not a
 * refusal, and must not be flattened into a `409` the client reads as "this order
 * is settled".
 */
function isOrderNotRecoverable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /order_not_recoverable|order_not_found/.test(message);
}

function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const gateway = readCommerceServiceDataGateway();
  if (!gateway) {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Checkout payment link is not configured", {
      details: { feature: "checkout-payment-link", requiredEnv: "SUPABASE_SERVICE_ROLE_KEY" },
    });
    return Promise.resolve();
  }

  return gateway.asService((client) => {
    // Absent signing secret ⇒ no codec ⇒ no claims ⇒ 401, the same answer a
    // missing cookie gets. Fail-closed, and the browser's own retry copy covers it.
    const codec = createCheckoutPaymentContinuationCodec(
      process.env.COMMERCE_CHECKOUT_RESUME_TOKEN_SECRET,
    );
    return createCheckoutPaymentLinkHandler({
      readClaims: (cookieHeader) => (codec ? codec.verifyCookieHeader(cookieHeader) : null),
      orderPort: createSupabaseCheckoutRecoveryOrderPort(
        client as unknown as CheckoutRecoveryOrderSupabaseClient,
      ),
      tokenPort: createSupabaseCheckoutRecoveryTokenPort(
        client as unknown as CheckoutRecoveryTokenSupabaseClient,
      ),
      enqueue: createBuyerCheckoutRecoveryEnqueue(
        client as unknown as BuyerCheckoutRecoveryOutboxClient,
      ),
    })(req, res);
  });
}

export default withObservedRoute({
  route: "/api/bff/commerce/checkout-payment-link",
  domain: "commerce",
  surface: "hidden",
  risk: "mutation",
  featureFlags: ["COMMERCE_PROVIDER_PAYMENTS_ENABLED"],
}, handler);
