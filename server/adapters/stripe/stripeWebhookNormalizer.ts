import { stripeWebhookPayload } from "./stripeFailureEvidence.js";
import { expiryInstantFromMonthYear, type PaymentMethodLifecycleEvent, type PaymentMethodLifecycleEventKind, type PaymentMethodReplacementFacts } from "@openlup/core/payment";
import type { NormalizedProviderPaymentWebhook } from "../../domains/payment/paymentWebhookHandlers.js";
import { methodFactSnapshotKeys, type ProviderWebhookWithMethodLifecycle } from "../../domains/payment/paymentMethodLifecycle.js";

const PROVIDER_KIND = "stripe";

/**
 * Method-family events, mapped to the neutral lifecycle vocabulary. They carry
 * no money and match no local attempt, so they ride the canonical `setup.*`
 * kinds and the ingest ledger's allowlist does not move. `attached` is the
 * first delivery carrying the instrument's own facts (the setup event carries
 * only its id); `automatically_updated` is the network rotating those facts
 * under an UNCHANGED consent, never a death; `detached` is the method leaving
 * the payer's file for good. ⚠️ Deploy note: the endpoint's subscribed event
 * list must include these three names or none of them ever arrive — an
 * operator console change, not a code change.
 */
type MethodLifecycleMapping = { kind: PaymentMethodLifecycleEventKind; canonical: NormalizedProviderPaymentWebhook["eventType"] };
const METHOD_LIFECYCLE_EVENTS: Record<string, MethodLifecycleMapping> = {
  "payment_method.attached": { kind: "method_registered", canonical: "setup.succeeded" },
  "payment_method.automatically_updated": { kind: "method_updated", canonical: "setup.succeeded" },
  "payment_method.detached": { kind: "method_revoked", canonical: "setup.failed" },
};

const SUPPORTED_EVENT_TYPES = new Set<NormalizedProviderPaymentWebhook["eventType"]>([
  "payment.requires_action",
  "payment.succeeded",
  "payment.failed",
  "payment.refunded",
  "payment.disputed",
  "setup.succeeded",
  "setup.failed",
  "setup.requires_action",
]);

/**
 * Convert a verified raw Stripe webhook payload into the plural handler's
 * `NormalizedProviderPaymentWebhook` shape.
 *
 * Reusable method extraction (Wave C): populated for `setup_intent.succeeded`
 * always, and for `payment_intent.succeeded` when `setup_future_usage` was
 * requested at PaymentIntent creation. Requires `metadata.clientId` to be set
 * (the adapter does this when the runtime caller passes `clientId` through
 * `PaymentExecutionInput`). When metadata is missing, `reusableMethod` stays
 * null and the plural handler skips the method-ref upsert — safe degradation
 * rather than crashing the webhook.
 */
export function normalizeStripeWebhookEvent(
  rawPayload: Record<string, unknown>,
): ProviderWebhookWithMethodLifecycle {
  const providerEventId = readString(rawPayload, "id");
  const eventType = readString(rawPayload, "type");
  const data = readObject(rawPayload, "data");
  const object = readObject(data, "object");

  const canonicalEventType = mapStripeEventType(eventType, object);
  const providerPaymentId = resolveLinkagePaymentId(eventType, object);
  // Payment-control compares this against the intent's `amount_cents` (the order
  // total) as a tamper guard, so we want the PaymentIntent's authorized `amount`,
  // not `amount_received`. On a declined/canceled PI Stripe reports
  // `amount_received: 0` while `amount` still holds the full total — and `??`
  // does NOT treat `0` as nullish, so reading `amount_received` first yielded a
  // `0` that tripped the amount-mismatch guard and left every failed event
  // unreconciled (intent stuck `processing`, inventory holds leaked). Prefer
  // `amount`; fall back to `amount_received` only when `amount` is absent.
  const amountMinor =
    readOptionalNumber(object, "amount") ??
    readOptionalNumber(object, "amount_received") ??
    null;
  const currency = readOptionalString(object, "currency")?.toUpperCase() ?? null;
  const occurredAt = readOccurredAt(rawPayload);
  const reusableMethod = extractReusableMethod(canonicalEventType, object);
  const refundKind = resolveRefundKind(canonicalEventType, object);

  return {
    provider: PROVIDER_KIND,
    providerEventId,
    eventType: canonicalEventType,
    providerPaymentId,
    paymentIntentId: null,
    paymentAttemptId: null,
    amountMinor,
    currency,
    occurredAt,
    refundKind,
    rawPayload: stripeWebhookPayload({ eventId: providerEventId, eventType, providerPaymentId, amountMinor, currency }, object),
    reusableMethod,
    methodLifecycle: extractMethodLifecycle(eventType, object, providerEventId, occurredAt),
  };
}

/** The neutral transition this delivery reports, or null when it reports none. */
function extractMethodLifecycle(
  rawEventType: string,
  object: Record<string, unknown>,
  providerEventId: string,
  occurredAt: string,
): PaymentMethodLifecycleEvent | null {
  const mapping = METHOD_LIFECYCLE_EVENTS[rawEventType];
  // On a method-family event the webhook object IS the method, so its own id is
  // the reference the stored row is keyed by.
  const providerMethodRef = readOptionalString(object, "id");
  if (!mapping || !providerMethodRef) return null;
  const replacement = readMethodFacts(object);
  return { kind: mapping.kind, providerKind: PROVIDER_KIND, providerMethodRef, providerEventId, occurredAt, replacement };
}

/**
 * Scheme label, trailing digits and expiry, from whichever of the three shapes
 * the payload carries them in: the method object itself at the top level, an
 * expanded method one level down, or a charge-shaped object's method details.
 * A payload carrying none of them yields null, not a row of empty facts.
 */
function readMethodFacts(object: Record<string, unknown>): PaymentMethodReplacementFacts | null {
  const card = readOptionalObject(object, "card")
    ?? readOptionalObject(readOptionalObject(object, "payment_method") ?? {}, "card")
    ?? readOptionalObject(readOptionalObject(object, "payment_method_details") ?? {}, "card");
  if (!card) return null;
  const schemeLabel = readOptionalString(card, "brand") ?? null;
  const lastDigits = readOptionalString(card, "last4") ?? null;
  const expiresAt = expiryInstantFromMonthYear(readOptionalNumber(card, "exp_month") ?? null, readOptionalNumber(card, "exp_year") ?? null);
  if (!schemeLabel && !lastDigits && !expiresAt) return null;
  return { schemeLabel, lastDigits, expiresAt };
}

/**
 * Classify a `charge.refunded` event as a full or partial refund from the
 * charge's `amount` vs `amount_refunded`. Stripe fires `charge.refunded` for
 * both; without this, a partial dashboard refund would apply as a full refund
 * and wrongly flip the order to `refunded`. A partial refund instead applies as
 * `partially_refunded` (recorded on the intent/payment, order stays `paid`).
 * Returns null for non-refund events or when amounts are unavailable — the
 * handler then treats it as a full refund (the conservative prior behaviour).
 */
function resolveRefundKind(
  canonicalEventType: NormalizedProviderPaymentWebhook["eventType"],
  object: Record<string, unknown>,
): NormalizedProviderPaymentWebhook["refundKind"] {
  if (canonicalEventType !== "payment.refunded") return null;
  const amount = readOptionalNumber(object, "amount");
  const amountRefunded = readOptionalNumber(object, "amount_refunded");
  if (amount === undefined || amountRefunded === undefined) return "full";
  return amountRefunded < amount ? "partial" : "full";
}

/**
 * Resolve the provider payment id used to LINK this event to the local payment
 * attempt. Payment-control matches inbound events to an attempt by
 * `commerce_payment_attempts.provider_attempt_id`, which holds the Stripe
 * PaymentIntent id (`pi_…`).
 *
 * For `payment_intent.*` events the webhook object IS the PaymentIntent, so its
 * `id` is already the linkage key. For `charge.*` (incl. `charge.dispute.*`)
 * the object is a Charge (`ch_…`) or Dispute (`dp_…`) whose own id never
 * matches an attempt — but it carries `payment_intent` pointing back at the PI.
 * Using that field is what lets `charge.refunded` / `charge.dispute.created`
 * resolve to the order and drive `applyPaymentResult`; without it refunds and
 * disputes were ingested but silently never applied. Falls back to the object
 * id when `payment_intent` is absent (defensive — keeps the event recordable).
 */
function resolveLinkagePaymentId(
  stripeEventType: string,
  object: Record<string, unknown>,
): string {
  if (stripeEventType.startsWith("charge.")) {
    const paymentIntentId = readOptionalString(object, "payment_intent");
    if (paymentIntentId) return paymentIntentId;
  }
  return readString(object, "id");
}

function mapStripeEventType(
  stripeEventType: string,
  object: Record<string, unknown>,
): NormalizedProviderPaymentWebhook["eventType"] {
  if (stripeEventType === "payment_intent.succeeded") return "payment.succeeded";
  if (stripeEventType === "payment_intent.payment_failed") return "payment.failed";
  if (stripeEventType === "payment_intent.canceled") return "payment.failed";
  if (stripeEventType === "payment_intent.requires_action") return "payment.requires_action";
  if (stripeEventType === "setup_intent.succeeded") return "setup.succeeded";
  if (stripeEventType === "setup_intent.setup_failed") return "setup.failed";
  if (stripeEventType === "setup_intent.requires_action") return "setup.requires_action";
  if (stripeEventType === "charge.refunded") return "payment.refunded";
  if (stripeEventType.startsWith("charge.dispute.")) return "payment.disputed";
  const methodLifecycle = METHOD_LIFECYCLE_EVENTS[stripeEventType];
  if (methodLifecycle) return methodLifecycle.canonical;
  const status = readOptionalString(object, "status");
  if (status === "requires_action") return "payment.requires_action";
  const guess = `payment.${stripeEventType}` as NormalizedProviderPaymentWebhook["eventType"];
  if (SUPPORTED_EVENT_TYPES.has(guess)) return guess;
  throw new Error(`Unsupported Stripe webhook event: ${stripeEventType}`);
}

function extractReusableMethod(
  canonicalEventType: NormalizedProviderPaymentWebhook["eventType"],
  object: Record<string, unknown>,
): NormalizedProviderPaymentWebhook["reusableMethod"] {
  const isSetupSucceeded = canonicalEventType === "setup.succeeded";
  const isPaymentSucceededWithSaveCard =
    canonicalEventType === "payment.succeeded" &&
    readOptionalString(object, "setup_future_usage") === "off_session";
  if (!isSetupSucceeded && !isPaymentSucceededWithSaveCard) return null;

  const customer = readOptionalString(object, "customer");
  // The method arrives as a bare id, or as an expanded object when the payload
  // also carries its facts; both address the same stored method.
  const paymentMethod = readOptionalString(object, "payment_method")
    ?? readOptionalString(readOptionalObject(object, "payment_method") ?? {}, "id");
  const metadata = readOptionalObject(object, "metadata");
  const clientId = metadata ? readOptionalString(metadata, "clientId") : undefined;
  const subscriptionId = metadata ? readOptionalString(metadata, "subscriptionId") : undefined;
  const mode = metadata ? readOptionalString(metadata, "mode") : undefined;
  const recoveryCaseId = metadata ? readOptionalString(metadata, "recoveryCaseId") : undefined;
  const metadataSource = metadata ? readOptionalString(metadata, "source") : undefined;
  if (!customer || !paymentMethod || !clientId) return null;

  return {
    clientId,
    // W11.7 Wave D-4a — recovery setup-method flow tags `subscriptionId` in
    // SetupIntent metadata so this upsert binds the new method to the
    // subscription the dunning case targets. One-time + initial save-card
    // (Wave C) flows leave the field null because no subscription exists yet.
    subscriptionId: subscriptionId ?? null,
    providerCustomerRef: customer,
    providerMethodRef: paymentMethod,
    providerMandateRef: null,
    methodKind: "card",
    status: "active",
    consentSnapshot: {
      source: "stripe_webhook",
      eventType: canonicalEventType,
      checkoutMode: mode ?? null,
      recoveryCaseId: recoveryCaseId ?? null,
      metadataSource: metadataSource ?? null,
      // Additive facts only, and only when the payload actually carried them.
      // The setup event carries the method's id and nothing else, so this is
      // usually empty there and filled later by the method-family delivery.
      ...methodFactSnapshotKeys(readMethodFacts(object)),
    },
  };
}

function readOccurredAt(rawPayload: Record<string, unknown>): string {
  const created = rawPayload.created;
  if (typeof created === "number" && Number.isFinite(created)) {
    return new Date(created * 1000).toISOString();
  }
  if (typeof created === "string") {
    const parsed = new Date(created);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  // Stripe always sends `created` on event payloads; fall back defensively if
  // missing rather than refusing the event — downstream RPC still records the
  // signature-verified facts.
  return new Date(0).toISOString();
}

function readObject(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const raw = value[key];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Stripe payload missing object ${key}`);
  }
  return raw as Record<string, unknown>;
}

function readOptionalObject(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const raw = value[key];
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function readString(value: Record<string, unknown>, key: string): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`Stripe payload missing string ${key}`);
  }
  return raw;
}

function readOptionalString(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function readOptionalNumber(value: Record<string, unknown>, key: string): number | undefined {
  const raw = value[key];
  return typeof raw === "number" ? raw : undefined;
}
