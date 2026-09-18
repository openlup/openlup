import type { PaymentPort } from "../../../src/domains/payment/ports.js";
import type {
  CanonicalPaymentEvent,
  InitiatePaymentInput,
  PaymentRefundResult,
  PaymentSession,
} from "../../../src/domains/payment/types.js";

/**
 * No-op PaymentPort adapter. Returns deterministic PaymentSession shapes the FE can
 * render against and emits fake CanonicalPaymentEvents that the W8 happy-path test
 * fixture replays through the ingest pipeline.
 *
 * This adapter is the only thing that proves W7a end-to-end without picking a real PSP.
 * When the business decides on Mollie / PayU / Stripe, the W9 adapter slot replaces this
 * file with a real implementation; the BFF and the domain are unchanged because the
 * port contract is canonical.
 */
export function createNoopPaymentAdapter(): PaymentPort {
  let counter = 0;
  function nextRef(prefix: string): string {
    counter += 1;
    return `${prefix}_${counter.toString().padStart(6, "0")}`;
  }

  return {
    async initiatePayment(input: InitiatePaymentInput): Promise<PaymentSession> {
      return {
        state: "pending",
        client_secret: nextRef("noop_client_secret"),
        next_action_kind: "redirect",
        raw_provider_payload: {
          provider_kind: "noop_payment",
          amount_minor: input.amount_minor,
          currency: input.currency,
          customer_ref: input.customer_ref,
        },
      };
    },

    async capturePayment(sessionRef: string): Promise<PaymentSession> {
      return {
        state: "succeeded",
        raw_provider_payload: {
          provider_kind: "noop_payment",
          captured_session: sessionRef,
        },
      };
    },

    async refundPayment(paymentRef: string, amountMinor?: number): Promise<PaymentRefundResult> {
      return {
        refund_provider_id: nextRef("noop_refund"),
        amount_minor: amountMinor ?? 0,
        state: "succeeded",
      };
    },

    async attachMethodToCustomer(_customerRef: string, _methodToken: string): Promise<void> {
      // no-op: noop_payment treats attach as a successful side effect.
    },

    async getPaymentSessionState(sessionRef: string): Promise<PaymentSession> {
      return {
        state: "succeeded",
        raw_provider_payload: {
          provider_kind: "noop_payment",
          session_ref: sessionRef,
        },
      };
    },

    parseWebhook(rawPayload: Record<string, unknown>): CanonicalPaymentEvent {
      const providerEventId = String(rawPayload.event_id ?? nextRef("noop_event"));
      const eventType =
        (rawPayload.event_type as CanonicalPaymentEvent["event_type"]) ?? "payment.succeeded";
      return {
        provider_event_id: providerEventId,
        event_type: eventType,
        payment_provider_id: String(rawPayload.payment_id ?? "noop_payment_unknown"),
        amount_minor: typeof rawPayload.amount_minor === "number" ? rawPayload.amount_minor : undefined,
        raw_payload: rawPayload,
      };
    },
  };
}
