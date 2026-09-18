import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import { WebhookBodyTooLargeError } from "../../_lib/payment/webhookSignature.js";
import {
  noopOperationalEventRecorder,
  type OperationalEventRecorder,
} from "../../_lib/observability/operationalEvents.js";
import type { PaymentWebhookEventType } from "../../../src/domains/payment/types.js";

export type ProviderPaymentWebhookKind = PaymentWebhookEventType;

export interface NormalizedProviderPaymentWebhook {
  provider: "stripe" | "tpay";
  providerEventId: string;
  eventType: ProviderPaymentWebhookKind;
  providerPaymentId: string;
  paymentIntentId?: string | null;
  paymentAttemptId?: string | null;
  amountMinor?: number | null;
  currency?: string | null;
  occurredAt: string;
  /**
   * For `payment.refunded` events only: whether Stripe's `charge.refunded`
   * reported a partial refund (`amount_refunded < amount`) vs. a full one.
   * A partial refund applies as `partially_refunded` (records the partial
   * status without flipping the order to fully `refunded`). Absent/null for
   * non-refund events or when amounts are unavailable (treated as full).
   */
  refundKind?: "full" | "partial" | null;
  rawPayload: Record<string, unknown>;
  reusableMethod?: {
    clientId: string;
    subscriptionId?: string | null;
    providerCustomerRef?: string | null;
    providerMethodRef: string;
    providerMandateRef?: string | null;
    methodKind: "card" | "blik_payid" | "wallet" | "alias";
    status: "pending_verification" | "active" | "inactive" | "expired" | "revoked";
    consentSnapshot?: Record<string, unknown>;
  } | null;
}

export interface PaymentWebhookControlPort {
  ingestPaymentEvent(input: NormalizedProviderPaymentWebhook): Promise<{
    paymentEventId: string;
    paymentIntentId: string | null;
    paymentAttemptId: string | null;
    replayed: boolean;
  }>;
  applyPaymentResult?(input: {
    idempotencyKey: string;
    paymentIntentId: string;
    paymentEventId: string;
    resultStatus: "succeeded" | "failed" | "refunded" | "partially_refunded" | "disputed";
    occurredAt: string;
    failureReason: string | null;
  }): Promise<{ replayed: boolean }>;
  /**
   * Model B: confirm a provisional subscription once its initial cycle is paid.
   * No-ops for any non-subscription_cycle intent. Idempotent + safe to re-deliver;
   * a missing mandate ref yields `awaiting_mandate` (not an error), which the
   * mandate-bearing event later completes. Invoked by route-level `afterProcessed`
   * callbacks (Stripe directly; Tpay via its BLIK-alias activation path).
   */
  confirmSubscriptionActivation?(input: {
    idempotencyKey: string;
    paymentIntentId: string;
    occurredAt: string;
    methodRef: string | null;
    methodKind: string | null;
  }): Promise<{ confirmed: boolean; status: string | null }>;
  recoverPaidSubscriptionActivationWithCard?(input: {
    idempotencyKey: string;
    subscriptionId: string;
    paymentMethodRef: string;
    occurredAt: string;
  }): Promise<{ recovered: boolean; replayed: boolean; reason: string | null }>;
  /**
   * Closes the ledger row of a `setup.*` event once the full setup pipeline
   * resolved. Setup events carry no money result, so applyPaymentResult (the
   * only other processed_at writer) never runs for them.
   */
  markSetupEventProcessed?(input: { paymentEventId: string }): Promise<{ updated: boolean }>;
}

export interface PaymentWebhookMethodRefPort {
  upsertFromWebhook(input: NormalizedProviderPaymentWebhook): Promise<{ replayed: boolean }>;
}

export type PaymentWebhookAfterProcessed = (input: {
  event: NormalizedProviderPaymentWebhook;
  ingested: {
    paymentEventId: string;
    paymentIntentId: string | null;
    paymentAttemptId: string | null;
    replayed: boolean;
  };
  resultStatus: "succeeded" | "failed" | "refunded" | "partially_refunded" | "disputed" | null;
}) => Promise<void>;

export interface PaymentWebhookProcessingPorts {
  paymentControlPort: PaymentWebhookControlPort;
  methodRefPort?: PaymentWebhookMethodRefPort;
  afterProcessed?: PaymentWebhookAfterProcessed;
}

export interface PaymentWebhookHandlerDeps {
  provider: "stripe" | "tpay";
  webhooksEnabled: () => boolean;
  verifyAndNormalize: (req: VercelRequest) => Promise<NormalizedProviderPaymentWebhook>;
  paymentControlPort?: PaymentWebhookControlPort;
  methodRefPort?: PaymentWebhookMethodRefPort;
  afterProcessed?: PaymentWebhookAfterProcessed;
  createPorts?: (event: NormalizedProviderPaymentWebhook) => PaymentWebhookProcessingPorts | Promise<PaymentWebhookProcessingPorts>;
  sendSuccess?: (res: VercelResponse, data: Record<string, unknown>) => void;
  /**
   * Vendor-neutral operational-event recorder. Defaults to no-op (OSS/test
   * purity); the runtime routes wire `consoleOperationalEventRecorder`. Used to
   * surface out-of-band provider payments that carry no local intent.
   */
  operationalEvents?: OperationalEventRecorder;
}

export function createProviderPaymentWebhookHandler({
  provider,
  webhooksEnabled,
  verifyAndNormalize,
  paymentControlPort,
  methodRefPort,
  afterProcessed,
  createPorts,
  sendSuccess = sendBffSuccess,
  operationalEvents = noopOperationalEventRecorder,
}: PaymentWebhookHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    if (!webhooksEnabled()) return sendBffError(res, "FORBIDDEN", "Provider webhooks are disabled");

    let event: NormalizedProviderPaymentWebhook;
    try {
      event = await verifyAndNormalize(req);
    } catch (error) {
      if (error instanceof WebhookBodyTooLargeError) {
        sendBffError(res, "BAD_REQUEST", "Webhook body too large", {
          status: 413,
          details: { code: "PAYLOAD_TOO_LARGE" },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      // A valid-signature event of a type we do not map (e.g. a new provider
      // event kind) is acknowledged with 200 so the provider stops retrying it
      // for days. Signature / parse failures stay 400.
      if (/unsupported .* webhook event/i.test(message)) {
        sendSuccess(res, { provider, acknowledged: true, skipped: "unsupported_event" });
        return;
      }
      sendBffError(res, "BAD_REQUEST", "Invalid provider webhook signature");
      return;
    }

    if (event.provider !== provider) {
      sendBffError(res, "BAD_REQUEST", "Provider webhook route mismatch");
      return;
    }

    try {
      const ports = createPorts
        ? await createPorts(event)
        : { paymentControlPort: paymentControlPort as PaymentWebhookControlPort, methodRefPort, afterProcessed };
      if (!ports.paymentControlPort) throw new Error("Provider webhook port unavailable");
      const ingested = await ports.paymentControlPort.ingestPaymentEvent(event);
      const resultStatus = mapResultStatus(event);
      if (resultStatus && ingested.paymentIntentId && ports.paymentControlPort.applyPaymentResult) {
        await ports.paymentControlPort.applyPaymentResult({
          idempotencyKey: `provider-webhook:${provider}:${event.providerEventId}:apply`,
          paymentIntentId: ingested.paymentIntentId,
          paymentEventId: ingested.paymentEventId,
          resultStatus,
          occurredAt: event.occurredAt,
          failureReason: event.eventType === "payment.failed" ? "provider_webhook_failed" : null,
        });
      } else if (isMoneyMoved(resultStatus) && !ingested.paymentIntentId && !ingested.replayed) {
        // Operator policy: payments should only originate at the storefront
        // checkout. A money-moved provider event (succeeded / refunded /
        // disputed) that matched no local intent is an out-of-band payment
        // (provider panel payment-link, dashboard link/invoice, wallet, card
        // terminal). It is recorded in inbound_provider_events and ACKed, but
        // there is no order to settle, invoice, or fulfill — the safe no-op above
        // is intentional and preserved. Emit a vendor-neutral, non-paging
        // reconciliation signal so the money is never silently lost.
        // Fires once per unique provider event (`!replayed`): the ingest RPC is
        // idempotent on (provider, provider_event_id), so PSP re-delivery is a
        // natural throttle.
        operationalEvents({
          name: "provider_payment_unmatched_out_of_band",
          domain: "payment",
          surface: "webhook",
          details: {
            provider,
            providerPaymentId: event.providerPaymentId,
            eventType: event.eventType,
            resultStatus,
            amountMinor: event.amountMinor ?? null,
            currency: event.currency ?? null,
            occurredAt: event.occurredAt,
          },
        });
      }
      if (ports.methodRefPort) {
        await ports.methodRefPort.upsertFromWebhook(event);
      }
      if (ports.afterProcessed) {
        await ports.afterProcessed({ event, ingested, resultStatus });
      }
      // Reached only when every setup mutation above resolved (a throw 5xx's →
      // provider redelivers into a still-'received' row). Runs on replays too,
      // so redelivery self-heals rows stuck from before this closer existed.
      if (resultStatus === null && event.eventType.startsWith("setup.") && ports.paymentControlPort.markSetupEventProcessed) {
        await ports.paymentControlPort.markSetupEventProcessed({ paymentEventId: ingested.paymentEventId });
      }
      sendSuccess(res, {
        provider,
        providerEventId: event.providerEventId,
        paymentEventId: ingested.paymentEventId,
        replayed: ingested.replayed,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A genuine idempotency conflict (same key, different payload) is a client
      // 409, not a transient 5xx — a 503 would make the provider retry a request
      // that can never succeed. The method-ref RPC raises this on a fingerprint
      // mismatch (SQLSTATE 23505).
      if (/payment_method_ref_idempotency_conflict|commerce_idempotency_conflict|\b23505\b/.test(message)) {
        sendBffError(res, "CONFLICT", "Webhook idempotency conflict");
        return;
      }
      // A `succeeded` result that arrives AFTER the provisional-subscription
      // sweep has already terminalized the intent (cancelled/refunded/…) is
      // rejected by `apply_result` with `payment_control_result_terminal_intent`
      // (ERRCODE 22023). The money question is already settled from the control
      // plane's perspective, so this is a "no work left to do" outcome, not a
      // transient upstream failure — ACK 200 so the provider stops
      // retrying for days (retry-storm / charge-without-fulfillment risk). We
      // match the RPC's exception text specifically, NOT the bare 22023 code,
      // because 22023 is also raised for genuine mismatches (amount / currency /
      // intent-not-found) that must still surface as 503.
      if (/payment_control_result_terminal_intent/.test(message)) {
        operationalEvents({
          name: "provider_payment_result_after_terminal_intent",
          domain: "payment",
          surface: "webhook",
          details: {
            provider,
            providerEventId: event.providerEventId,
            providerPaymentId: event.providerPaymentId,
            eventType: event.eventType,
            occurredAt: event.occurredAt,
          },
        });
        sendSuccess(res, {
          provider,
          providerEventId: event.providerEventId,
          acknowledged: true,
          skipped: "result_terminal_intent",
        });
        return;
      }
      // The event cannot be attributed to the intent's exact active attempt:
      // either it named another attempt (the slow-webhook shape and possible
      // double charge) or ingest could not correlate it at all. Neither answer
      // changes on redelivery, so ACK 200 instead of creating an endless retry
      // loop. The durable inbound event and this reason route operator recovery.
      // Match named reasons only, never the shared 22023 SQLSTATE.
      if (/payment_control_result_attempt_(?:mismatch|unresolved)/.test(message)) {
        const reason = message.includes("payment_control_result_attempt_unresolved")
          ? "attempt_unresolved"
          : "attempt_mismatch";
        operationalEvents({
          name: "provider_payment_result_attempt_mismatch",
          domain: "payment",
          surface: "webhook",
          // `providerPaymentId`, not `providerEventId`, is the operator's handle:
          // the detail allowlist carries the former and drops the latter, and it
          // is the value `ingest_event` correlated the attempt from.
          details: {
            provider,
            providerPaymentId: event.providerPaymentId,
            eventType: event.eventType,
            resultStatus: mapResultStatus(event),
            occurredAt: event.occurredAt,
            reason,
          },
        });
        sendSuccess(res, {
          provider,
          providerEventId: event.providerEventId,
          acknowledged: true,
          skipped: "result_attempt_mismatch",
        });
        return;
      }
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Provider webhook processing failed");
    }
  };
}

function mapResultStatus(
  event: NormalizedProviderPaymentWebhook,
): "succeeded" | "failed" | "refunded" | "partially_refunded" | "disputed" | null {
  if (event.eventType === "payment.succeeded") return "succeeded";
  if (event.eventType === "payment.failed") return "failed";
  if (event.eventType === "payment.refunded") {
    return event.refundKind === "partial" ? "partially_refunded" : "refunded";
  }
  if (event.eventType === "payment.disputed") return "disputed";
  return null;
}

// "Money moved" for reconciliation purposes: a settled charge, a refund, or a
// chargeback/dispute. `failed` (no money moved) and `null` (setup / non-money
// events) are excluded — an unmatched failed/setup event needs no reconciliation.
function isMoneyMoved(
  resultStatus: "succeeded" | "failed" | "refunded" | "partially_refunded" | "disputed" | null,
): boolean {
  return resultStatus !== null && resultStatus !== "failed";
}
