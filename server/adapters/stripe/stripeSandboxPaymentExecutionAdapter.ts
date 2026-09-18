import { failureEvidencePayload } from "../paymentFailureEvidence.js";
import { declineFromError, declinedExecutionFacts } from "./executionDecline.js";
import { noIssuerWasAsked } from "./stripeIntentConfirmationEvidence.js";
import type { PaymentExecutionPort } from "../../../src/domains/payment/ports.js";
import type {
  CanonicalPaymentEvent,
  PaymentExecutionInput,
  PaymentExecutionResult,
  PaymentNextActionKind,
  PaymentProviderFlow,
} from "../../../src/domains/payment/types.js";

/** The one place this adapter spells its own provider identity. */
export const PROVIDER_KIND = "stripe" as const;

import type { StripeIntentLike } from "./stripeFailureEvidence.js";
export type { StripeIntentLike } from "./stripeFailureEvidence.js";

export interface StripeSandboxClient {
  createPaymentIntent(input: {
    amount: number;
    currency: string;
    customer?: string;
    paymentMethod?: string;
    offSession?: boolean;
    setupFutureUsage?: "off_session";
    metadata: Record<string, string>;
  }, options: { idempotencyKey: string }): Promise<StripeIntentLike>;
  createSetupIntent(input: {
    customer?: string;
    paymentMethod?: string;
    usage: "off_session";
    metadata: Record<string, string>;
  }, options: { idempotencyKey: string }): Promise<StripeIntentLike>;
  /**
   * Ensure-or-create a provider Customer for the client. Required before a
   * `setup_future_usage='off_session'` PaymentIntent (the provider rejects it
   * without a customer). Idempotent via the idempotency key.
   */
  ensureCustomer?(input: {
    clientId: string;
    metadata: Record<string, string>;
  }, options: { idempotencyKey: string }): Promise<string>;
  retrievePaymentIntent?(paymentIntentId: string): Promise<StripeIntentLike>;
}

export interface StripeSandboxAdapterOptions {
  client: StripeSandboxClient;
  defaultFlow?: Extract<
    PaymentProviderFlow,
    "one_time_payment" | "setup_reusable_method" | "off_session_payment"
  >;
}

export function createStripeSandboxPaymentExecutionAdapter({
  client,
  defaultFlow = "one_time_payment",
}: StripeSandboxAdapterOptions): PaymentExecutionPort {
  return {
    async execute(input: PaymentExecutionInput): Promise<PaymentExecutionResult> {
      const flow = stripeFlow(input.providerFlow ?? defaultFlow);
      // A reusable-mandate PaymentIntent (setup_future_usage) requires a Stripe
      // Customer. Ensure-or-create one for the client when none was passed.
      let customerRef = input.customerRef;
      if (!customerRef && input.saveForFutureUse && input.clientId && client.ensureCustomer) {
        customerRef = await client.ensureCustomer(
          { clientId: input.clientId, metadata: { clientId: input.clientId } },
          // A provider attempt is per click; a Stripe Customer is per openlup
          // client. A stable key avoids orphan Customers when checkout recovery
          // is reloaded before the first method webhook stores the reference.
          { idempotencyKey: `openlup:stripe:customer:${input.clientId}` },
        );
      }
      const created = flow === "setup_reusable_method"
        ? await client.createSetupIntent({
            customer: customerRef,
            paymentMethod: input.paymentMethodRef,
            usage: "off_session",
            metadata: metadataFor(input, flow),
          }, { idempotencyKey: input.providerIdempotencyKey })
        : await client.createPaymentIntent({
            amount: input.amountMinor,
            currency: input.currency.toLowerCase(),
            customer: customerRef,
            paymentMethod: input.paymentMethodRef,
            offSession: flow === "off_session_payment" ? true : undefined,
            setupFutureUsage: input.saveForFutureUse ? "off_session" : undefined,
            metadata: metadataFor(input, flow),
          }, { idempotencyKey: input.providerIdempotencyKey }).catch((error: unknown) => {
            // An off-session charge is confirmed inside this call, so the payer's
            // issuer can refuse it here and nowhere else. That refusal is a FACT,
            // not an ambiguous call: rethrowing it makes the renewal orchestrator
            // record an indeterminate outcome, which applies no result, opens no
            // dunning case and tells the customer nothing. Every other error class
            // — network, auth, config, rate limit — keeps throwing, because after
            // those the charge may still have been accepted and only the
            // fail-closed path is safe.
            const decline = flow === "off_session_payment" ? declineFromError(error) : null;
            if (!decline) throw error;
            return decline;
          });
      if ("decline" in created) return { ...executionResultBase(input, flow), ...declinedExecutionFacts(created) };
      const intent = created;

      return {
        ...executionResultBase(input, flow),
        providerAttemptId: intent.id,
        providerSessionId: intent.id,
        attemptStatus: attemptStatusFromStripe(intent),
        nextActionKind: nextActionKindFromStripe(intent),
        // `clientSecret` is the single canonical exit for the FE to confirm with
        // the provider's browser SDK. It MUST NOT be persisted or duplicated
        // into `responsePayload` (the latter is logged); the consumer reads it
        // once from the top-level result and discards.
        clientSecret: intent.client_secret ?? null,
        customerProviderRef: intent.customer ?? null,
        paymentMethodRef: intent.payment_method ?? null,
        webhookExpected: true,
        recoveryRequired: intent.status === "requires_action" && flow === "off_session_payment",
        responsePayload: {
          providerStatus: intent.status,
          providerAttemptId: intent.id,
          providerSessionIdPresent: Boolean(intent.client_secret),
          latestChargePresent: Boolean(intent.latest_charge),
          customerRefPresent: Boolean(intent.customer),
          paymentMethodRefPresent: Boolean(intent.payment_method),
          ...failureEvidencePayload(intent.diagnosticFailureEvidence),
        },
      };
    },
  };
}

export function parseStripePaymentWebhookEvent(rawPayload: Record<string, unknown>): CanonicalPaymentEvent {
  const eventId = readString(rawPayload, "id");
  const eventType = readString(rawPayload, "type");
  const data = readObject(rawPayload, "data");
  const object = readObject(data, "object");
  const providerPaymentId = readString(object, "id");
  const amount = readOptionalNumber(object, "amount_received") ?? readOptionalNumber(object, "amount");
  const currency = readOptionalString(object, "currency")?.toUpperCase();

  return {
    provider_event_id: eventId,
    event_type: canonicalStripeEventType(eventType, object),
    payment_provider_id: providerPaymentId,
    amount_minor: amount,
    next_action_kind: nextActionKindFromStripe({
      status: readOptionalString(object, "status") ?? "",
      next_action: readOptionalObject(object, "next_action"),
    }) ?? undefined,
    raw_payload: {
      provider: PROVIDER_KIND,
      eventId,
      eventType,
      providerPaymentId,
      amountMinor: amount,
      currency,
    },
  };
}

/** The facts every result of this adapter carries, whatever the provider answered. */
function executionResultBase(
  input: PaymentExecutionInput,
  flow: string,
): Pick<PaymentExecutionResult, "provider" | "requestPayload"> {
  return {
    provider: PROVIDER_KIND,
    requestPayload: {
      providerIdempotencyKey: input.providerIdempotencyKey,
      providerRequestFingerprint: input.providerRequestFingerprint,
      providerFlow: flow,
      amountMinor: input.amountMinor,
      currency: input.currency,
      orderRef: input.orderRef,
    },
  };
}

function stripeFlow(flow: PaymentProviderFlow): "one_time_payment" | "setup_reusable_method" | "off_session_payment" {
  if (flow === "one_time_payment" || flow === "setup_reusable_method" || flow === "off_session_payment") {
    return flow;
  }
  throw new Error(`Unsupported Stripe provider flow: ${flow}`);
}

function metadataFor(input: PaymentExecutionInput, flow: string): Record<string, string> {
  const metadata: Record<string, string> = {
    source: "openlup.payment-control",
    paymentIntentId: input.paymentIntentId,
    orderRef: input.orderRef,
    providerRequestFingerprint: input.providerRequestFingerprint,
    providerFlow: flow,
  };
  if (input.clientId) metadata.clientId = input.clientId;
  if (input.mode === "subscription_cycle") metadata.mode = input.mode;
  return metadata;
}

/**
 * What the durable attempt row is allowed to claim about this execution.
 *
 * Takes the intent, not just its status, because the two states sharing
 * `requires_payment_method` differ only in what else is on the object: a fresh
 * intent the payer never confirmed, and one an issuer has just refused (which
 * carries a payment error and usually a charge).
 *
 * `processing` claims money is moving, and a catch-all used to reach it — so a
 * never-confirmed intent was recorded as a charge in flight, and a payer was
 * told their payment was already processing when no issuer had been asked (that
 * incident is recorded in `docs/BACKEND.md`). `sent_to_provider` is the truth:
 * the request reached the provider, no outcome is known. It belongs to every
 * live-attempt set the platform keeps, so the correction costs no watchdog
 * coverage, and it is fail-closed at the provider-attempt admission gate exactly
 * as `processing` is — admission does not widen by one state.
 *
 * The catch-all stays `processing` on purpose: an unrecognised provider status is
 * not evidence that nothing happened.
 */
function attemptStatusFromStripe(
  intent: StripeIntentLike,
): NonNullable<PaymentExecutionResult["attemptStatus"]> {
  if (intent.status === "requires_action" || intent.status === "requires_confirmation") {
    return "requires_action";
  }
  if (noIssuerWasAsked(intent)) return "sent_to_provider";
  return "processing";
}

function nextActionKindFromStripe(intent: Pick<StripeIntentLike, "status" | "next_action">): PaymentNextActionKind | null {
  if (intent.status !== "requires_action" && intent.status !== "requires_confirmation") return null;
  if (intent.next_action?.type === "redirect_to_url") return "redirect";
  if (intent.next_action?.type === "use_stripe_sdk") return "3ds_challenge";
  return "sca_required";
}

function canonicalStripeEventType(
  stripeEventType: string,
  object: Record<string, unknown>,
): CanonicalPaymentEvent["event_type"] {
  if (stripeEventType === "payment_intent.succeeded") return "payment.succeeded";
  if (stripeEventType === "payment_intent.payment_failed" || stripeEventType === "payment_intent.canceled") {
    return "payment.failed";
  }
  if (stripeEventType === "payment_intent.requires_action") return "payment.requires_action";
  if (stripeEventType === "charge.refunded") return "payment.refunded";
  if (stripeEventType.startsWith("charge.dispute.")) return "payment.disputed";
  const status = readOptionalString(object, "status");
  if (status === "requires_action") return "payment.requires_action";
  throw new Error(`Unsupported Stripe webhook event: ${stripeEventType}`);
}

function readObject(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const raw = value[key];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Stripe payload missing object ${key}`);
  }
  return raw as Record<string, unknown>;
}

function readOptionalObject(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const raw = value[key];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
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
