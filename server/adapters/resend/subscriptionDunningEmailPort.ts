// Resend adapter for the subscription dunning emails. Uses provider infra for
// HTTP and owns one sanitized email_sends ledger row per attempt so the dunning
// dispatcher stays decoupled from the commerce outbox email port. No email body,
// recipient payload, or token is ever stored (email_sends contract).

import {
  subscriptionPaymentFailedEmailContent,
} from "../../../src/domains/subscription/emails/subscriptionPaymentFailed.js";
import {
  subscriptionPaymentExpiredEmailContent,
} from "../../../src/domains/subscription/emails/subscriptionPaymentExpired.js";
import { renderEmail } from "../../../src/domains/communications/email/render.js";
import {
  APP_EMAIL_TEAM_SIGNOFF,
  APP_SITE_ORIGIN,
  appEmailBrandForOrigin,
} from "../../../src/lib/brand/appBrand.js";
import {
  type DunningEmailPort,
  type DunningPaymentExpiredEmailInput,
  type DunningPaymentFailedEmailInput,
} from "../../domains/subscription/subscriptionDunningDispatchPorts.js";
import {
  DUNNING_DELIVERY_ABORTED,
  DUNNING_DELIVERY_IDEMPOTENCY_CONFLICT,
  DUNNING_DELIVERY_IDEMPOTENCY_IN_FLIGHT,
  DUNNING_DELIVERY_RATE_LIMITED,
  DUNNING_DELIVERY_REJECTED,
  DUNNING_DELIVERY_UNAVAILABLE,
  type DunningEmailSendOutcome,
  type DunningTransportOutcome,
} from "../../domains/subscription/dunningDeliveryOutcome.js";
import {
  recordEmailDeliveryTimeline,
  statusFromSendOutcome,
  type EmailDeliveryTimelineClient,
} from "./emailDeliveryTimeline.js";
import { buildEmailOriginMetadata, withEmailOriginMetadata } from "../../infra/resend/emailOriginMetadata.js";
import { classifyEmailSendOutcome, createResendTransport, type EmailSendOutcome, type EmailSendResult, type EmailTransport } from "../../infra/email/emailTransport.js";
import { logEmailLedgerInsertFailure } from "./emailLedgerLog.js";
import {
  EMAIL_NOTIFICATION_ADMIN_DISABLED,
  createEmailNotificationControlPort,
} from "../../infra/email/emailNotificationControl.js";
import { logAdminDisabledEmailSend } from "./emailNotificationSkipLog.js";

export const SUBSCRIPTION_DUNNING_EMAIL_SOURCE = "subscription-dunning-dispatch";

/** The transport's own answer, as the domain reads it. */
export interface DunningTransportResult {
  ok: boolean;
  httpStatus: number;
  providerErrorCode?: string | null;
  aborted: boolean;
}

/**
 * The provider-specific half of the retry decision, kept HERE.
 *
 * This adapter's service answers 409 for two materially different idempotency
 * outcomes, and only one of them is worth retrying: a concurrent request under
 * the same key has not reached a stable response yet and a later call can
 * retrieve it, while a key reused with a different payload is permanently
 * invalid. That distinction is a fact about this service's error dictionary, so
 * it is decided at this edge and handed on as `{ transient, reasonCode }` — the
 * dispatcher neither sees nor stores the vendor's code.
 */
export function dunningTransportOutcome(raw: DunningTransportResult): DunningTransportOutcome | null {
  if (raw.ok) return null;
  if (raw.aborted) return { transient: true, reasonCode: DUNNING_DELIVERY_ABORTED };
  if (raw.httpStatus === 409) {
    return raw.providerErrorCode === "concurrent_idempotent_requests"
      ? { transient: true, reasonCode: DUNNING_DELIVERY_IDEMPOTENCY_IN_FLIGHT }
      : { transient: false, reasonCode: DUNNING_DELIVERY_IDEMPOTENCY_CONFLICT };
  }
  if (raw.httpStatus === 429) return { transient: true, reasonCode: DUNNING_DELIVERY_RATE_LIMITED };
  if (raw.httpStatus >= 500 || raw.httpStatus === 0) {
    return { transient: true, reasonCode: DUNNING_DELIVERY_UNAVAILABLE };
  }
  return { transient: false, reasonCode: DUNNING_DELIVERY_REJECTED };
}

/**
 * Drops the vendor's code AND its prose, carrying the neutral answer instead.
 * The raw text stays in this adapter's own attempt ledger below — where an
 * operator debugging one vendor looks — and never in the dunning row.
 */
export function neutralDunningSendOutcome(raw: EmailSendOutcome): DunningEmailSendOutcome {
  const projected = classifyEmailSendOutcome(raw);
  return {
    ok: raw.ok,
    deliveryId: raw.resendId,
    httpStatus: raw.httpStatus,
    transport: dunningTransportOutcome(raw),
    aborted: raw.aborted,
    ...(projected.skipReason ? { skipReason: projected.skipReason } : {}),
  };
}

interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** The vendor's own answer: written to this adapter's vendor-scoped records only. */
export type VendorSendResult = EmailSendResult["outcome"];

interface LedgerQueryBuilder {
  insert(row: Record<string, unknown>): PromiseLike<{ error: unknown }>;
  select(columns: string): LedgerQueryBuilder;
  eq(column: string, value: unknown): LedgerQueryBuilder;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface DunningEmailSupabaseClient extends EmailDeliveryTimelineClient {
  from(table: string): LedgerQueryBuilder;
  rpc(
    name: string,
    params: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: unknown }>;
}

export function createResendSubscriptionDunningEmailPort(input: {
  apiKey: string;
  fromEmail: string;
  client: DunningEmailSupabaseClient;
  emailBaseUrl?: string | null;
  emailOriginSource?: string | null;
  emailEnvironment?: string | null;
  platformJobRunId?: string | null;
  transport?: EmailTransport;
}): DunningEmailPort {
  const { apiKey, fromEmail, client } = input;
  const transport = input.transport ?? createResendTransport({ apiKey, env: process.env });
  const platformJobRunId = input.platformJobRunId ?? null;
  const emailBrand = appEmailBrandForOrigin(input.emailBaseUrl ?? APP_SITE_ORIGIN);
  const controlPort = createEmailNotificationControlPort(client as never);
  const originMetadata = buildEmailOriginMetadata({
    baseUrl: input.emailBaseUrl,
    originSource: input.emailOriginSource,
    environment: input.emailEnvironment,
    platformJobRunId,
  });

  async function postRendered(
    rendered: RenderedEmail,
    to: string,
    notificationId: string,
    signal: AbortSignal,
  ): Promise<EmailSendResult> {
    const { subject, html, text } = rendered;
    return transport.send({
      from: fromEmail,
      to,
      subject,
      html,
      text,
      idempotencyKey: `subscription-dunning:${notificationId}`,
      signal,
    });
  }

  async function logAttempt(
    templateSlug: string,
    notificationId: string,
    outcome: VendorSendResult,
    providerResponse: Record<string, unknown>,
    sendAttemptId: string | null,
  ): Promise<void> {
    const projected = classifyEmailSendOutcome(outcome);
    try {
      const response = withEmailOriginMetadata(providerResponse, originMetadata, {
          triggerSource: SUBSCRIPTION_DUNNING_EMAIL_SOURCE,
          triggerReason: templateSlug,
          notificationId,
          idempotencyKey: `subscription-dunning:${notificationId}`,
          ...(sendAttemptId
            ? { sendAttemptId }
            : { sendAttemptLink: "timeline_unavailable" }),
      });
      const result = await client.rpc("subscription_dunning_record_email_attempt", {
        p_template_slug: templateSlug,
        p_notification_id: notificationId,
        p_resend_id: outcome.resendId,
        p_status: projected.ledgerStatus,
        p_sent_at: projected.sentAtEligible ? new Date().toISOString() : null,
        p_provider_error: outcome.providerError,
        p_provider_response: response,
      });
      if (result.error) {
        logEmailLedgerInsertFailure({ source: SUBSCRIPTION_DUNNING_EMAIL_SOURCE, templateSlug, error: result.error });
      }
    } catch (err) {
      logEmailLedgerInsertFailure({ source: SUBSCRIPTION_DUNNING_EMAIL_SOURCE, templateSlug, error: err });
    }
  }

  async function recordTimeline(
    send: { to: string; templateSlug: string; notificationId: string },
    status: "processing" | "sent" | "failed" | "delivery_delayed" | "skipped",
    outcome?: VendorSendResult,
  ): Promise<string | null> {
    const projected = outcome ? classifyEmailSendOutcome(outcome) : null;
    const skipReason = projected?.skipReason ?? (status === "skipped" ? EMAIL_NOTIFICATION_ADMIN_DISABLED : null);
    return recordEmailDeliveryTimeline(client, {
      dedupeKey: `subscription-dunning:${send.notificationId}`,
      templateSlug: send.templateSlug,
      purpose: "subscription_dunning",
      triggerSource: SUBSCRIPTION_DUNNING_EMAIL_SOURCE,
      triggerEvent: "subscription_dunning_notification",
      status,
      recipientEmail: send.to,
      aggregateType: "subscription_dunning_notification",
      aggregateId: send.notificationId,
      platformJobRunId,
      providerKind: transport.providerKind,
      providerMessageId: outcome?.resendId ?? null,
      lastErrorCode: projected?.lastErrorCode ?? skipReason,
      metadata: {
        adapter: "subscription_dunning",
        ...originMetadata,
        ...(skipReason ? { skipped: skipReason } : {}),
      },
    }, {
      required: false,
      context: `${SUBSCRIPTION_DUNNING_EMAIL_SOURCE}:${send.templateSlug}`,
    });
  }

  function render(content: { subject: string; preheader: string; blocks: import("../../../src/domains/communications/email/blocks.js").EmailBlock[] }, locale: "pl" | "en"): RenderedEmail {
    return renderEmail({ brand: emailBrand, locale, subject: content.subject, preheader: content.preheader, blocks: content.blocks });
  }

  // The operator-wide silence, written once for both notices: the same skip
  // ledger row, the same timeline status, the same outcome the dispatcher reads
  // as `adminDisabled` and settles on the durable skip rail.
  async function refuseDisabled(
    send: { to: string; templateSlug: string; notificationId: string },
  ): Promise<DunningEmailSendOutcome> {
    await logAdminDisabledEmailSend({
      client,
      source: SUBSCRIPTION_DUNNING_EMAIL_SOURCE,
      templateSlug: send.templateSlug,
      originMetadata,
      providerContext: { triggerSource: SUBSCRIPTION_DUNNING_EMAIL_SOURCE, triggerReason: send.templateSlug, notificationId: send.notificationId },
    });
    await recordTimeline(send, "skipped");
    return { ok: true, deliveryId: null, httpStatus: 0, aborted: false, adminDisabled: true, skipReason: "admin_disabled" };
  }

  return {
    async sendPaymentFailed(send: DunningPaymentFailedEmailInput): Promise<DunningEmailSendOutcome> {
      if (!await controlPort.isEnabled(send.templateSlug, send.signal)) return refuseDisabled(send);
      const content = subscriptionPaymentFailedEmailContent(send.locale, {
        firstName: send.firstName,
        amountLabel: send.amountLabel,
        retryAttempt: send.retryAttempt,
        nextRetryDateLabel: send.nextRetryDateLabel,
        retryScheduled: send.retryScheduled,
        methodScheme: send.methodScheme,
        methodLastDigits: send.methodLastDigits,
        cause: send.cause,
        recoveryUrl: send.recoveryUrl,
      }, APP_EMAIL_TEAM_SIGNOFF[send.locale]);
      const sendAttemptId = await recordTimeline(send, "processing");
      const { outcome: raw, providerResponse } = await postRendered(
        render(content, send.locale),
        send.to,
        send.notificationId,
        send.signal,
      );
      await logAttempt(send.templateSlug, send.notificationId, raw, providerResponse, sendAttemptId);
      const mapped = statusFromSendOutcome(raw);
      await recordTimeline(send, mapped.status as "sent" | "failed" | "delivery_delayed", raw);
      return neutralDunningSendOutcome(raw);
    },

    async sendPaymentExpired(send: DunningPaymentExpiredEmailInput): Promise<DunningEmailSendOutcome> {
      if (!await controlPort.isEnabled(send.templateSlug, send.signal)) return refuseDisabled(send);
      const content = subscriptionPaymentExpiredEmailContent(send.locale, {
        firstName: send.firstName,
        amountLabel: send.amountLabel,
        cause: send.cause,
        recoveryUrl: send.recoveryUrl,
      }, APP_EMAIL_TEAM_SIGNOFF[send.locale]);
      const sendAttemptId = await recordTimeline(send, "processing");
      const { outcome: raw, providerResponse } = await postRendered(
        render(content, send.locale),
        send.to,
        send.notificationId,
        send.signal,
      );
      await logAttempt(send.templateSlug, send.notificationId, raw, providerResponse, sendAttemptId);
      const mapped = statusFromSendOutcome(raw);
      await recordTimeline(send, mapped.status as "sent" | "failed" | "delivery_delayed", raw);
      return neutralDunningSendOutcome(raw);
    },
  };
}
