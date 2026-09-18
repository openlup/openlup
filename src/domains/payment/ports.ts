import type {
  CanonicalPaymentEvent,
  InitiatePaymentInput,
  PaymentExecutionInput,
  PaymentExecutionResult,
  PaymentRefundResult,
  PaymentSession,
} from "./types.js";

/**
 * Canonical PaymentPort interface every concrete PSP adapter implements (Mollie / PayU /
 * Adyen / Stripe / noop). Schema-agnostic: the BFF never knows which provider it is
 * calling — routing is data-driven from the `providers` registry + per-customer
 * `customer_external_refs.active` flag.
 *
 * Per plan §6 Gemini fix #5 — PaymentSession state machine carries client_secret /
 * redirect_url / next_action_kind so asymmetric provider flows (Stripe PaymentIntents
 * 3DS, Mollie redirect, PayU BLIK code prompt) collapse onto one shape the FE renders.
 */
export interface PaymentPort {
  initiatePayment(input: InitiatePaymentInput): Promise<PaymentSession>;
  capturePayment(sessionRef: string): Promise<PaymentSession>;
  refundPayment(paymentRef: string, amountMinor?: number): Promise<PaymentRefundResult>;
  attachMethodToCustomer(customerRef: string, methodToken: string): Promise<void>;
  getPaymentSessionState(sessionRef: string): Promise<PaymentSession>;
  parseWebhook(rawPayload: Record<string, unknown>): CanonicalPaymentEvent;
}

/**
 * Payment execution seam (W11.0). A real PSP adapter (W11.7) implements
 * `execute` to make its external call and return the attempt facts; the no-op returns
 * `providerCall:false`. Distinct from the dead canonical `PaymentPort` above — this is
 * the surface the hidden checkout saga actually invokes.
 */
export interface PaymentExecutionPort {
  /** Pure local validation used before a durable provider attempt is prepared. */
  validateInput?(input: PaymentExecutionInput): void;
  execute(input: PaymentExecutionInput): Promise<PaymentExecutionResult>;
}

/**
 * Ledger facts returned by ingesting one canonical provider event. `replayed`
 * reports that the ingest RPC recognised an already-seen (provider,
 * provider_event_id) pair; a null `paymentIntentId` is an event that matched no
 * local intent.
 */
export interface IngestedPaymentEvent {
  paymentEventId: string;
  paymentIntentId: string | null;
  paymentAttemptId: string | null;
  replayed: boolean;
}

/** Outcome of applying one ingested event's money result to its intent. */
export interface AppliedPaymentResult {
  paymentIntentId: string;
  paymentEventId: string;
  status: "succeeded" | "failed" | "expired" | "refunded" | "partially_refunded" | "disputed";
  replayed: boolean;
}

/**
 * Canonical-event webhook port: ingest one verified provider event, then apply
 * its money result. Implemented by the Supabase payment adapters
 * (`createSupabasePaymentWebhookPort`, `createPaymentWebhookPortViaGateway`) and
 * consumed by the Tpay simulator settlement path.
 *
 * ⛔ `occurredAt` MUST carry the provider event's own timestamp, never a fresh
 * clock read. The `commerce.payment_result.apply` fingerprint hashes
 * `p_occurred_at::text`, so a clock-derived value makes re-presenting the same
 * `idempotencyKey` unable to replay — it can only raise 23505. That shape caused
 * the 2026-08-04 production renewal poison pill; see
 * `docs/PAYMENT_IDEMPOTENCY.md` §4.
 */
export interface PaymentWebhookPort {
  ingestEvent(input: {
    event: CanonicalPaymentEvent;
    signatureVerified: true;
    rawPayload: Record<string, unknown>;
  }): Promise<IngestedPaymentEvent>;
  applyEventResult(input: {
    idempotencyKey: string;
    paymentIntentId: string;
    paymentEventId: string;
    resultStatus: AppliedPaymentResult["status"];
    occurredAt: string;
    failureReason: string | null;
  }): Promise<AppliedPaymentResult>;
}

export class PaymentProviderNotConfiguredError extends Error {
  constructor(providerKind: string) {
    super(`No PaymentPort adapter wired for provider_kind=${providerKind}`);
    this.name = "PaymentProviderNotConfiguredError";
  }
}
