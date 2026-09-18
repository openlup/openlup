import {
  CHECKOUT_CONTRACT_VERSION,
  checkoutResponseSchema,
  type CheckoutKind,
  type CheckoutResponse,
} from "../../../src/domains/commerce/checkoutContracts.js";
import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import type { CommerceResumableOrderReadPort } from "../../../src/domains/commerce/ports.js";
import { resolveDeliverySelectionEvidence } from "../../../src/domains/shipping/contracts.js";
import { safeCommerceDiagnosticValue } from "./commerceDiagnostics.js";
import { subscriptionResponse } from "./commerceCheckoutHandlerHelpers.js";

const DEFAULT_RESUME_WINDOW_MINUTES = 60;

/**
 * Duplicate-charge guard deps (W11.7+). Supplying `resumableOrderPort` is the
 * whole switch: with it, checkout resumes an already in-flight order for the
 * client instead of minting a second order + PaymentIntent; omit it to disable.
 *
 * This is the cross-device / lost-state line, not the first one. The browser's
 * own continuation marker catches same-tab refresh, and the journey-stable
 * idempotency key catches re-submits within one session — the server dedups a
 * same-key submit as an update in place, so a cart edit alone does NOT reach
 * here. What does reach here is a second device, or a browser that lost its
 * session storage.
 */
export interface CheckoutResumeGuardDeps {
  resumableOrderPort?: CommerceResumableOrderReadPort;
  /** How recent an in-flight order must be to be resumable. Defaults to 60 min. */
  resumeWindowMinutes?: number;
}

/**
 * Returns a ready-to-send checkout response that resumes the client's in-flight
 * order, or null to fall through to normal order creation. Fail-OPEN: a lookup
 * failure is logged and returns null — it must never block a real checkout. The
 * resumed response carries no fresh provider action; the FE routes to the
 * persistent payment-status page for the existing order (paid -> thank-you).
 */
export async function resolveResumeOpenOrderResponse(input: {
  deps: CheckoutResumeGuardDeps;
  clientId: string;
  checkoutKind: CheckoutKind;
  intent: ConfiguratorIntent;
  /**
   * The basket the buyer has just accepted a price for, when one exists.
   *
   * ABSENT on exactly one caller: the persist-intent conflict path, which runs
   * before any quote. That path is no longer reached by an ordinary cart edit —
   * `20260714201100_configurator_persist_intent_stable_journey_key.sql` converted
   * "same key, changed payload" from a 23505 into an in-place identity update —
   * so what still reaches it is a genuine double-submit RACE: two concurrent
   * submits of the SAME payload. There is no changed cart to protect against
   * there, and refusing would tell a buyer whose payment may already be in
   * flight to start over. So the two cart-change barriers below apply only when
   * a fresh price exists to compare against; the delivery check applies always.
   */
  acceptedQuote?: QuoteLikeSnapshot;
  now: () => Date;
}): Promise<CheckoutResponse | null> {
  const { deps, clientId, checkoutKind, intent, acceptedQuote, now } = input;
  if (!deps.resumableOrderPort) return null;

  try {
    const resumable = await deps.resumableOrderPort.findResumableOrderForClient({
      clientId,
      withinMinutes: deps.resumeWindowMinutes ?? DEFAULT_RESUME_WINDOW_MINUTES,
      now: now(),
      journeyKey: intent.idempotencyKey,
    });
    if (!resumable) return null;
    if (acceptedQuote && resumable.sameJourney) {
      // The buyer edited their cart; they did not come back on another device.
      // Answering with this order would re-offer the OLD total. Falling through
      // hands the case to `commerce_supersede_pre_payment_order_draft`, which
      // cancels the unpaid order plus its intent, attempt and PROVISIONAL
      // subscription and re-drafts at the new price — and which refuses outright
      // once money has moved, at which point this guard legitimately owns it.
      console.info(
        "checkout_resume_skipped_same_journey",
        JSON.stringify({ orderId: resumable.orderId, status: resumable.status }),
      );
      return null;
    }
    if (!selectedDeliveryMatches(resumable.metadata, intent)) {
      console.info(
        "checkout_resume_skipped_delivery_mismatch",
        JSON.stringify({ orderId: resumable.orderId, status: resumable.status }),
      );
      return null;
    }
    if (acceptedQuote && !quoteMatches(resumable.metadata, acceptedQuote)) {
      // Second, independent barrier. A different journey can still hold a
      // different basket — same buyer, two tabs, two configurations — and money
      // is what the buyer is about to authorize, so it must be the money they
      // were just shown.
      console.info(
        "checkout_resume_skipped_quote_mismatch",
        JSON.stringify({ orderId: resumable.orderId, status: resumable.status }),
      );
      return null;
    }

    const response = checkoutResponseSchema.parse({
      contractVersion: CHECKOUT_CONTRACT_VERSION,
      checkoutKind,
      orderRef: `order_${resumable.orderId}`,
      orderId: resumable.orderId,
      status: resumable.status,
      paymentIntentId: resumable.paymentIntentId,
      clientId,
      clientAction: { kind: "none" },
      statusUrl: `/api/bff/commerce/payment-status?orderId=${encodeURIComponent(resumable.orderId)}&paymentIntentId=${encodeURIComponent(resumable.paymentIntentId)}&clientId=${encodeURIComponent(clientId)}`,
      subscription: subscriptionResponse(intent, checkoutKind),
      payment: { requiresReusablePaymentMethod: checkoutKind === "subscription_initial" },
    });
    console.info(
      "checkout_resumed_open_order",
      JSON.stringify({ orderId: resumable.orderId, status: resumable.status }),
    );
    return response;
  } catch (error) {
    console.warn(
      "checkout_resume_lookup_failed",
      JSON.stringify({
        message: safeCommerceDiagnosticValue(error instanceof Error ? error.message : String(error)),
      }),
    );
    return null;
  }
}

function selectedDeliveryMatches(
  orderMetadata: Record<string, unknown> | null | undefined,
  intent: ConfiguratorIntent,
): boolean {
  const existing = resolveDeliverySelectionEvidence({ orderMetadata }).selection;
  const fresh = resolveDeliverySelectionEvidence({
    orderMetadata: { selectedDelivery: intent.selectedDelivery },
  }).selection;
  if (!existing || !fresh) return false;
  return deliveryKey(existing) === deliveryKey(fresh);
}

function deliveryKey(selection: Record<string, unknown>): string {
  const pickupPoint = selection.pickupPoint && typeof selection.pickupPoint === "object"
    ? selection.pickupPoint as Record<string, unknown>
    : {};
  return [
    text(selection.providerKind),
    text(selection.carrierKind),
    text(selection.carrierCode),
    text(selection.serviceCode ?? selection.service),
    text(selection.deliveryKind ?? selection.kind),
    text(pickupPoint.id ?? pickupPoint.pointId),
  ].join("|");
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** The parts of a quote a resume must match. Structural, so the guard needs no
 *  dependency on the quote port's own types. */
export interface QuoteLikeSnapshot {
  currency: string;
  totalGross: { amountMinor: number; currency: string };
  lines: ReadonlyArray<{ sku: string; quantity: number }>;
}

/**
 * Does the order we are about to resume hold the same basket the buyer just
 * accepted a price for?
 *
 * Compared against `metadata.quoteSnapshot`, which the order-draft producer
 * persists on the order (`commerce_orders.metadata`, alongside `paymentStatus`
 * and `orderDraftSnapshot`). Absent or unreadable => NO resume: an order whose
 * basket cannot be established is exactly the one not to re-offer.
 *
 * Currency and total alone are not enough — two different baskets can total the
 * same — so the line multiset is compared as well. Order is not significant,
 * quantity is.
 */
function quoteMatches(
  orderMetadata: Record<string, unknown> | null | undefined,
  accepted: QuoteLikeSnapshot,
): boolean {
  const stored = readStoredQuote(orderMetadata);
  if (!stored) return false;
  return stored.currency === accepted.currency
    && stored.totalGross.currency === accepted.totalGross.currency
    && stored.totalGross.amountMinor === accepted.totalGross.amountMinor
    && lineKey(stored.lines) === lineKey(accepted.lines);
}

function readStoredQuote(
  orderMetadata: Record<string, unknown> | null | undefined,
): QuoteLikeSnapshot | null {
  // The producer stores the whole envelope, so the quote sits one level down.
  const snapshot = orderMetadata?.quoteSnapshot;
  const quote = isRecord(snapshot) ? snapshot.quote : undefined;
  if (!isRecord(quote)) return null;
  const total = quote.totalGross;
  const lines = quote.lines;
  if (typeof quote.currency !== "string" || !isRecord(total) || !Array.isArray(lines)) return null;
  if (typeof total.amountMinor !== "number" || typeof total.currency !== "string") return null;
  const parsed: { sku: string; quantity: number }[] = [];
  for (const line of lines) {
    if (!isRecord(line) || typeof line.sku !== "string" || typeof line.quantity !== "number") {
      return null;
    }
    parsed.push({ sku: line.sku, quantity: line.quantity });
  }
  return {
    currency: quote.currency,
    totalGross: { amountMinor: total.amountMinor, currency: total.currency },
    lines: parsed,
  };
}

function lineKey(lines: ReadonlyArray<{ sku: string; quantity: number }>): string {
  return lines.map((line) => `${line.sku}x${line.quantity}`).sort().join("|");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
