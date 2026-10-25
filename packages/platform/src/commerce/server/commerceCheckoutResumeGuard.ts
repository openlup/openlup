import type { z } from "zod";
import type { CheckoutKind, CommerceResumableOrderReadPort, ResumableOrderSnapshot } from "../contracts/index.js";
import { resolveDeliverySelectionEvidence } from "../../shipping/index.js";
import { CHECKOUT_CONTRACT_VERSION } from "../checkoutSchemas.js";
import { safeCommerceDiagnosticValue } from "./commerceDiagnostics.js";
export function subscriptionResponse(intent: { cadenceDays: number | null }, checkoutKind: CheckoutKind) {
  return checkoutKind === "one_time" ? { requested: false, cadenceDays: null, activationStatus: "not_applicable" as const }
    : { requested: true, cadenceDays: intent.cadenceDays, activationStatus: "pending_payment_success" as const };
}

const DEFAULT_RESUME_WINDOW_MINUTES = 60;

export interface CheckoutResumeGuardDeps {
  resumableOrderPort?: CommerceResumableOrderReadPort;
    resumeWindowMinutes?: number;
}

export function selectedDeliveryMatches(
  orderMetadata: Record<string, unknown> | null | undefined,
  intent: { selectedDelivery?: unknown },
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

export interface QuoteLikeSnapshot {
  currency: string;
  totalGross: { amountMinor: number; currency: string };
  lines: ReadonlyArray<{ sku: string; quantity: number }>;
}

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

export function createCheckoutResumeGuard<Intent extends { idempotencyKey: string; cadenceDays: number | null; selectedDelivery?: unknown }, Response>(bindings: {
  responseSchema: z.ZodType<Response>;
  statusUrl(orderId: string, paymentIntentId: string, clientId: string): string;
}) {
function buildSavedOrderResumeResponse(input: {
  resumable: ResumableOrderSnapshot;
  clientId: string;
  checkoutKind: CheckoutKind;
  intent: Intent;
}): Response {
  const { resumable, clientId, checkoutKind, intent } = input;
  return bindings.responseSchema.parse({
      contractVersion: CHECKOUT_CONTRACT_VERSION,
      checkoutKind,
      orderRef: `order_${resumable.orderId}`,
      orderId: resumable.orderId,
      status: resumable.status,
      paymentIntentId: resumable.paymentIntentId,
      clientId,
      clientAction: { kind: "none" },
      statusUrl: bindings.statusUrl(resumable.orderId, resumable.paymentIntentId, clientId),
      subscription: subscriptionResponse(intent, checkoutKind),
      payment: { requiresReusablePaymentMethod: checkoutKind === "subscription_initial" },
    });
}

async function resolveResumeOpenOrderResponse(input: {
  deps: CheckoutResumeGuardDeps;
  clientId: string;
  checkoutKind: CheckoutKind;
  intent: Intent;
    acceptedQuote?: QuoteLikeSnapshot;
  now: () => Date;
}): Promise<Response | null> {
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

    const response = buildSavedOrderResumeResponse({ resumable, clientId, checkoutKind, intent });
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


return { resolveResumeOpenOrderResponse, buildSavedOrderResumeResponse };
}
