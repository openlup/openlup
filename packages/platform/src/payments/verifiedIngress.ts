import type { PaymentIngressPort, PaymentVerifyNormalizePort, RefundEvidencePolicy, VerifiedMethodEvidence } from "./contracts/evidence.js";
import { projectVerifiedEvidence } from "./verifiedEvidenceProjection.js";
const PAYMENT_WEBHOOK_EVENT_TYPES = [
  "payment.succeeded",
  "payment.failed",
  "payment.refunded",
  "payment.requires_action",
  "payment.disputed",
  "setup.succeeded",
  "setup.failed",
  "setup.requires_action",
] as const;
type PaymentWebhookEventType = (typeof PAYMENT_WEBHOOK_EVENT_TYPES)[number];
export type ProviderPaymentWebhookKind = PaymentWebhookEventType;

export interface NormalizedProviderPaymentWebhook {
  provider: string;
  providerEventId: string;
  eventType: ProviderPaymentWebhookKind;
  providerPaymentId: string;
  paymentIntentId?: string | null;
  paymentAttemptId?: string | null;
  amountMinor?: number | null;
  currency?: string | null;
  occurredAt: string;

  refundKind?: "full" | "partial" | null;
  rawPayload: Record<string, unknown>;
  reusableMethod?: {
    clientId: string;
    subscriptionId?: string | null;
    providerCustomerRef?: string | null;
    providerMethodRef: string;
    providerMandateRef?: string | null;
    methodKind: string;
    status: "pending_verification" | "active" | "inactive" | "expired" | "revoked";
    consentSnapshot?: Record<string, unknown>;
  } | null;
}

export interface PaymentWebhookControlPort {
  ingestPaymentEvent(input: NormalizedProviderPaymentWebhook): Promise<{
    paymentEventId: string;
    paymentIntentId: string | null;
    paymentAttemptId: string | null;
    replayed: boolean; occurredAt?: string; // Durable instant for application and post-processing.
  }>;
  applyPaymentResult?(input: {
    idempotencyKey: string;
    paymentIntentId: string;
    paymentEventId: string;
    resultStatus: "succeeded" | "failed" | "refunded" | "partially_refunded" | "disputed";
    occurredAt: string;
    failureReason: string | null;
  }): Promise<{ replayed: boolean }>;

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


type IngressResponse = Awaited<ReturnType<PaymentIngressPort["receive"]>>;
type OperationalEventRecorder = (event: { name: string; domain: string; surface: string; details: Record<string, unknown> }) => void;

/** Verified ingress boundary; persistence and transport response writing belong to the host. */
export function createVerifiedPaymentIngress({
  provider, verifyPort, paymentControlPort, methodRefPort, afterProcessed, createPorts, resolveMethodOwner,
  refundEvidencePolicy = "require-evidence", operationalEvents = () => {},
}: {
  provider: string;
  verifyPort: PaymentVerifyNormalizePort;
  paymentControlPort: PaymentWebhookControlPort;
  methodRefPort?: PaymentWebhookMethodRefPort;
  afterProcessed?: PaymentWebhookAfterProcessed;
  createPorts?: (event: NormalizedProviderPaymentWebhook) => PaymentWebhookProcessingPorts | Promise<PaymentWebhookProcessingPorts>;
  /** Host-owned identity; adapter metadata cannot supply client/subscription authority. */
  resolveMethodOwner?: (evidence: VerifiedMethodEvidence) => Promise<{ clientId: string; subscriptionId?: string | null } | null>;
  refundEvidencePolicy?: RefundEvidencePolicy;
  operationalEvents?: OperationalEventRecorder;
}): PaymentIngressPort {
  return { async receive(input) {
    let evidence;
    try { evidence = await verifyPort.verifyAndNormalize(input); }
    catch { return { status: 400, data: { error: "Invalid provider webhook signature" } }; }
    if (evidence.kind === "refusal") {
      return evidence.reason === "unsupported-event"
        ? { status: 200, data: { provider, acknowledged: true, skipped: "unsupported_event" } }
        : { status: 400, data: { error: "Invalid provider webhook signature" } };
    }
    const verifiedEvidence = evidence;
    let event: NormalizedProviderPaymentWebhook | undefined;
    const res: IngressResponse = { status: 503, data: {} };
    const sendSuccess = (target: IngressResponse, data: Record<string, unknown>) => { target.status = 200; target.data = data; };
    const sendBffError = (target: IngressResponse, code: string, error: string) => {
      target.status = code === "BAD_REQUEST" ? 400 : code === "CONFLICT" ? 409 : 503;
      target.data = { error };
    };
    await processEvent();
    return res;
    async function processEvent(): Promise<void> {
    try {
      try { event = projectVerifiedEvidence(verifiedEvidence, input, refundEvidencePolicy); }
      catch (error) {
        if (error instanceof Error && error.message === "payment_control_result_amount_mismatch") throw error;
        sendBffError(res, "BAD_REQUEST", "Invalid provider webhook evidence");
        return;
      }
      if (event.provider !== provider) {
        sendBffError(res, "BAD_REQUEST", "Provider webhook route mismatch");
        return;
      }

      if (verifiedEvidence.kind === "method" && verifiedEvidence.reusableMethod && resolveMethodOwner) {
        const owner = await resolveMethodOwner(verifiedEvidence);
        event = projectVerifiedEvidence(verifiedEvidence, input, refundEvidencePolicy, owner ?? undefined);
      }
      const ports = createPorts
        ? await createPorts(event)
        : { paymentControlPort: paymentControlPort as PaymentWebhookControlPort, methodRefPort, afterProcessed };
      if (!ports.paymentControlPort) throw new Error("Provider webhook port unavailable");
      const ingested = await ports.paymentControlPort.ingestPaymentEvent(event); if (ingested.occurredAt) event = { ...event, occurredAt: ingested.occurredAt };
      const resultStatus = mapResultStatus(event, refundEvidencePolicy);
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
      if (event && /payment_control_result_terminal_intent/.test(message)) {
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
      if (event && /payment_control_result_attempt_(?:mismatch|unresolved)/.test(message)) {
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
            resultStatus: mapResultStatus(event, refundEvidencePolicy),
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
    }
  } };
}

function mapResultStatus(
  event: NormalizedProviderPaymentWebhook,
  refundEvidencePolicy: RefundEvidencePolicy,
): "succeeded" | "failed" | "refunded" | "partially_refunded" | "disputed" | null {
  if (event.eventType === "payment.succeeded") return "succeeded";
  if (event.eventType === "payment.failed") return "failed";
  if (event.eventType === "payment.refunded") {
    if (refundEvidencePolicy === "require-evidence" && (event.refundKind == null || !event.providerPaymentId.trim() || !Number.isSafeInteger(event.amountMinor) || (event.amountMinor ?? 0) <= 0 || !event.currency?.trim())) return null;
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
