// Local port interfaces used by commerce marketing outbox handlers.
// Types only: domain handlers stay free of infra and cross-domain imports; the
// cron composition root wires Resend, consent evaluation, and unsubscribe URLs.

export const OUTBOX_REVIEW_REQUEST_TEMPLATE_SLUG = "commerce-order-review-request";

export interface MarketingEmailSendInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  templateSlug: string;
  outboxEventId: string;
  decisionId?: string | null;
  /** Optional abort signal so a worker timeout can cancel an in-flight POST. */
  signal?: AbortSignal;
}

export interface MarketingEmailSendOutcome {
  ok: boolean;
  resendId: string | null;
  // 0 = network-level failure (no HTTP response).
  httpStatus: number;
  providerError: string | null;
  // True when the POST was cancelled by the handler-timeout AbortSignal.
  aborted: boolean;
  /** Terminal intentional non-send; callers must not count it as sent. */
  skipReason?: "admin_disabled" | "egress_suppressed" | null;
}

export interface MarketingEmailPort {
  findExistingSend(templateSlug: string, outboxEventId: string): Promise<boolean>;
  send(input: MarketingEmailSendInput): Promise<MarketingEmailSendOutcome>;
}

export interface ConsentEvaluationInput {
  email: string;
  purpose: string;
  recipientKind?:
    | "external_contact"
    | "tester"
    | "customer"
    | "lead"
    | "admin_internal";
  sourceTable?:
    | "testers"
    | "waitlist"
    | "clients"
    | "b2b_inquiries"
    | "notification_recipients";
  sourceId?: string | null;
}

export interface ConsentEvaluation {
  allowed: boolean;
  reason: string;
  decisionId: string | null;
}

export interface ConsentEvaluatorPort {
  evaluate(input: ConsentEvaluationInput): Promise<ConsentEvaluation>;
}

/**
 * Thrown when the consent evaluation yields no authoritative allow/deny
 * decision. The outbox worker maps this to a retry, so the send is deferred
 * (fail closed), never sent without consent. Named so callers/tests can
 * distinguish it from a real deny.
 *
 * It sits with the port it belongs to rather than with any one implementation:
 * "no decision" is a contract outcome every evaluator implementation owes its
 * caller, not an artifact of how one of them reads the answer.
 */
export class ConsentEvaluationUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ConsentEvaluationUnavailableError";
  }
}

export type UnsubscribeUrlBuilder = (input: {
  email: string;
  purpose: string;
  locale: "pl" | "en";
}) => Promise<string>;

// Resolves a back-in-stock alert's sku to a customer-facing product name, so the
// email reads "Karma sucha Jagnięcina znów dostępny" instead of the raw sku. The
// notify-me subscription keys on a sku (text), so the handler holds only the sku
// and must resolve the display name at send time. Cosmetic + best-effort: any
// catalog failure or unknown sku returns null and the copy falls back to a
// generic localized label (never the raw sku).
export interface ProductNameBySkuLookupPort {
  lookupNameBySku(sku: string): Promise<string | null>;
}

// Send-time conversion recheck for abandoned-cart reminders. The enqueue scan
// only selects drafts with no payment row, but a customer can pay between enqueue
// and send (24h/72h window) — possibly via a different draft. This re-asks, at
// send time, whether the order is still an open, unpaid draft. "Converted" mirrors
// the enqueue exclusion inverted: status != 'draft' OR any commerce_payments row.
export interface OrderConversionStatusPort {
  isConverted(orderUuid: string, signal: AbortSignal): Promise<boolean>;
}
