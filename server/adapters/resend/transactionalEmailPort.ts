// The transactional send port. It was the Node half of a pair with a Deno twin
// that api/ could not import; the twin went with the Edge tree on 2026-09-04.
// Resend HTTP via infra client + one sanitized
// email_sends ledger row per attempt. No email body, recipient payload, or
// template variables are ever stored (email_sends column comment contract).

import {
  OUTBOX_ORDER_CONFIRMATION_TEMPLATE_SLUG,
  OUTBOX_ORDER_PAID_TEMPLATE_SLUG,
  OUTBOX_CHECKOUT_EXPIRED_TEMPLATE_SLUG,
  OUTBOX_PAYMENT_FAILED_TEMPLATE_SLUG,
  OUTBOX_ORDER_CANCELED_TEMPLATE_SLUG,
  OUTBOX_ORDER_REFUNDED_TEMPLATE_SLUG,
  OUTBOX_SHIPMENT_DISPATCHED_TEMPLATE_SLUG,
  OUTBOX_SHIPMENT_DELIVERED_TEMPLATE_SLUG,
  OUTBOX_SHIPMENT_EXCEPTION_TEMPLATE_SLUG,
  OUTBOX_RETURN_APPROVED_TEMPLATE_SLUG,
  OUTBOX_RETURN_REJECTED_TEMPLATE_SLUG,
  type OrderConfirmationEmailInput,
  type OrderPaidConfirmationEmailInput,
  type CheckoutExpiredEmailInput,
  type PaymentFailedEmailInput,
  type OrderCanceledEmailInput,
  type OrderRefundedEmailInput,
  type ShipmentDispatchedEmailInput,
  type ShipmentDeliveredEmailInput,
  type ShipmentExceptionEmailInput,
  type CheckoutRecoveryEmailInput,
  OUTBOX_CHECKOUT_RECOVERY_TEMPLATE_SLUG,
  type ReturnDecisionEmailInput,
  type TransactionalEmailPort,
  type TransactionalEmailSendOutcome,
} from "../../domains/commerce/outboxOrderDraftEmailPorts.js";
import { emailPresentation } from "../../../src/domains/communications/email/deploymentEmailPresentation.js";
import {
  renderCheckoutRecovery,
  renderCheckoutExpired,
  renderOrderCanceled,
  renderOrderConfirmation,
  renderOrderPaidConfirmation,
  renderOrderRefunded,
  renderPaymentFailed,
  renderShipmentDispatched,
  renderShipmentDelivered,
  renderShipmentException,
  renderReturnApproved,
  renderReturnRejected,
  type RenderedEmail,
} from "../../infra/resend/transactionalEmailRenderers.js";
import {
  commerceOrderAggregateId,
  outboxDeliveryDedupeKey,
  recordEmailDeliveryTimeline,
  statusFromSendOutcome,
  type EmailDeliveryTimelineClient,
} from "./emailDeliveryTimeline.js";
import { buildEmailOriginMetadata } from "../../infra/resend/emailOriginMetadata.js";
import { classifyEmailSendOutcome, createResendTransport, withEmailSendSkipReason, type EmailTransport } from "../../infra/email/emailTransport.js";
import {
  EMAIL_NOTIFICATION_ADMIN_DISABLED,
  createEmailNotificationControlPort,
} from "../../infra/email/emailNotificationControl.js";
import { logAdminDisabledEmailSend } from "./emailNotificationSkipLog.js";
import {
  logTransactionalEmailAttempt,
  type TransactionalEmailLedgerClient,
} from "./transactionalEmailLedgerAttempt.js";

export interface TransactionalEmailSupabaseClient extends EmailDeliveryTimelineClient, TransactionalEmailLedgerClient {}

// Re-exported alias; the canonical constant lives with the port types so the
// handler's dedupe filter and this ledger insert can never drift apart.
export const ORDER_CONFIRMATION_TEMPLATE_SLUG = OUTBOX_ORDER_CONFIRMATION_TEMPLATE_SLUG;
export const ORDER_PAID_TEMPLATE_SLUG = OUTBOX_ORDER_PAID_TEMPLATE_SLUG;
export const CHECKOUT_EXPIRED_TEMPLATE_SLUG = OUTBOX_CHECKOUT_EXPIRED_TEMPLATE_SLUG;
export const PAYMENT_FAILED_TEMPLATE_SLUG = OUTBOX_PAYMENT_FAILED_TEMPLATE_SLUG;
export const ORDER_CANCELED_TEMPLATE_SLUG = OUTBOX_ORDER_CANCELED_TEMPLATE_SLUG;
export const ORDER_REFUNDED_TEMPLATE_SLUG = OUTBOX_ORDER_REFUNDED_TEMPLATE_SLUG;
export const SHIPMENT_DISPATCHED_TEMPLATE_SLUG = OUTBOX_SHIPMENT_DISPATCHED_TEMPLATE_SLUG;
export const SHIPMENT_DELIVERED_TEMPLATE_SLUG = OUTBOX_SHIPMENT_DELIVERED_TEMPLATE_SLUG;
export const SHIPMENT_EXCEPTION_TEMPLATE_SLUG = OUTBOX_SHIPMENT_EXCEPTION_TEMPLATE_SLUG;
export const RETURN_APPROVED_TEMPLATE_SLUG = OUTBOX_RETURN_APPROVED_TEMPLATE_SLUG;
export const RETURN_REJECTED_TEMPLATE_SLUG = OUTBOX_RETURN_REJECTED_TEMPLATE_SLUG;
export const OUTBOX_DISPATCH_EMAIL_SOURCE = "outbox-dispatch";

export function createResendTransactionalEmailPort(input: {
  apiKey: string;
  fromEmail: string;
  client: TransactionalEmailSupabaseClient;
  baseUrl?: string; // Public origin used to build CTA links in emails.
  emailOriginSource?: string | null; emailEnvironment?: string | null; platformJobRunId?: string | null;
  /** Provider-neutral send seam; defaults to Resend. Inject to swap providers / test. */
  transport?: EmailTransport;
}): TransactionalEmailPort {
  const { apiKey, fromEmail, client } = input;
  const transport = input.transport ?? createResendTransport({ apiKey, env: process.env });
  const baseUrl = input.baseUrl ?? emailPresentation.brand.siteOrigin;
  const platformJobRunId = input.platformJobRunId ?? null;
  const originMetadata = buildEmailOriginMetadata({ baseUrl, originSource: input.emailOriginSource, environment: input.emailEnvironment, platformJobRunId });
  const controlPort = createEmailNotificationControlPort(client as never);

  async function postRendered(
    rendered: RenderedEmail,
    to: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<{
    outcome: TransactionalEmailSendOutcome;
    providerResponse: Record<string, unknown>;
  }> {
    const { subject, html, text } = rendered;
    // R-1: the worker timeout must cancel the in-flight POST, otherwise an
    // orphaned send can complete after the row is re-claimed (dup email).
    return transport.send({ from: fromEmail, to, subject, html, text, idempotencyKey, signal });
  }

  async function recordTimeline(
    templateSlug: string,
    send: { to: string; orderId: string; outboxEventId: string },
    status: "processing" | "sent" | "failed" | "delivery_delayed" | "skipped",
    outcome?: TransactionalEmailSendOutcome,
    emailSendId?: string | null,
  ): Promise<string | null> {
    const projected = outcome ? classifyEmailSendOutcome(outcome) : null;
    const skipReason = projected?.skipReason
      ?? (status === "skipped" ? EMAIL_NOTIFICATION_ADMIN_DISABLED : null);
    return recordEmailDeliveryTimeline(client, {
      dedupeKey: outboxDeliveryDedupeKey(send.outboxEventId),
      templateSlug,
      purpose: "transactional",
      triggerSource: OUTBOX_DISPATCH_EMAIL_SOURCE,
      triggerEvent: "outbox_dispatch_send",
      status,
      recipientEmail: send.to,
      aggregateType: "commerce_order",
      aggregateId: commerceOrderAggregateId(send.orderId),
      outboxEventId: send.outboxEventId,
      platformJobRunId,
      emailSendId: emailSendId ?? null,
      providerKind: transport.providerKind,
      providerMessageId: outcome?.resendId ?? null,
      lastErrorCode: projected?.lastErrorCode ?? skipReason,
      metadata: {
        adapter: "commerce_transactional",
        ...originMetadata,
        ...(skipReason ? { skipped: skipReason } : {}),
      },
    }, {
      required: false,
      context: `${OUTBOX_DISPATCH_EMAIL_SOURCE}:${templateSlug}`,
    });
  }

  async function sendRendered(
    templateSlug: string,
    rendered: RenderedEmail,
    send: { to: string; orderId: string; outboxEventId: string; signal: AbortSignal },
  ): Promise<TransactionalEmailSendOutcome> {
    const enabled = await controlPort.isEnabled(templateSlug, send.signal);
    if (!enabled) {
      await logAdminDisabledEmailSend({
        client,
        source: OUTBOX_DISPATCH_EMAIL_SOURCE,
        templateSlug,
        originMetadata,
        providerContext: { triggerSource: OUTBOX_DISPATCH_EMAIL_SOURCE, triggerReason: templateSlug, outboxEventId: send.outboxEventId, orderId: send.orderId },
      });
      await recordTimeline(templateSlug, send, "skipped");
      return { ok: true, resendId: null, httpStatus: 0, providerError: null, aborted: false, skipReason: "admin_disabled" };
    }
    const sendAttemptId = await recordTimeline(templateSlug, send, "processing");
    const { outcome: rawOutcome, providerResponse } = await postRendered(
      rendered,
      send.to,
      outboxDeliveryDedupeKey(send.outboxEventId),
      send.signal,
    );
    const outcome = withEmailSendSkipReason(rawOutcome);
    const emailSendId = await logTransactionalEmailAttempt({
      client,
      source: OUTBOX_DISPATCH_EMAIL_SOURCE,
      templateSlug,
      outboxEventId: send.outboxEventId,
      orderId: send.orderId,
      outcome,
      providerResponse,
      sendAttemptId,
      originMetadata,
    });
    const mapped = statusFromSendOutcome(outcome);
    await recordTimeline(templateSlug, send, mapped.status as "sent" | "failed" | "delivery_delayed", outcome, emailSendId);
    return outcome;
  }

  return {
    async findExistingSend(templateSlug: string, outboxEventId: string): Promise<boolean> {
      const result = await client
        .from("email_sends")
        .select("id")
        .eq("template_slug", templateSlug)
        .neq("status", "failed")
        .eq("provider_response->>outboxEventId", outboxEventId)
        .limit(1);
      if (result.error) {
        throw new Error(
          `outbox_email_dedupe_read_failed: ${result.error.message ?? result.error.code ?? "unknown"}`,
        );
      }
      return Array.isArray(result.data) && result.data.length > 0;
    },

    async sendOrderConfirmation(
      send: OrderConfirmationEmailInput,
    ): Promise<TransactionalEmailSendOutcome> {
      const rendered = renderOrderConfirmation(send, baseUrl, emailPresentation);
      return sendRendered(ORDER_CONFIRMATION_TEMPLATE_SLUG, rendered, send);
    },
    async sendCheckoutRecovery(
      send: CheckoutRecoveryEmailInput,
    ): Promise<TransactionalEmailSendOutcome> {
      const rendered = renderCheckoutRecovery(send, baseUrl, emailPresentation);
      return sendRendered(OUTBOX_CHECKOUT_RECOVERY_TEMPLATE_SLUG, rendered, send);
    },

    async sendOrderPaidConfirmation(
      send: OrderPaidConfirmationEmailInput,
    ): Promise<TransactionalEmailSendOutcome> {
      const rendered = renderOrderPaidConfirmation(send, baseUrl, emailPresentation);
      return sendRendered(ORDER_PAID_TEMPLATE_SLUG, rendered, send);
    },

    async sendPaymentFailedNotice(
      send: PaymentFailedEmailInput,
    ): Promise<TransactionalEmailSendOutcome> {
      const rendered = renderPaymentFailed(send, baseUrl, emailPresentation);
      return sendRendered(PAYMENT_FAILED_TEMPLATE_SLUG, rendered, send);
    },

    async sendCheckoutExpiredNotice(
      send: CheckoutExpiredEmailInput,
    ): Promise<TransactionalEmailSendOutcome> {
      const rendered = renderCheckoutExpired(send, baseUrl, emailPresentation);
      return sendRendered(CHECKOUT_EXPIRED_TEMPLATE_SLUG, rendered, send);
    },

    async sendOrderCanceledNotice(
      send: OrderCanceledEmailInput,
    ): Promise<TransactionalEmailSendOutcome> {
      const rendered = renderOrderCanceled(send, baseUrl, emailPresentation);
      return sendRendered(ORDER_CANCELED_TEMPLATE_SLUG, rendered, send);
    },

    async sendOrderRefundedNotice(
      send: OrderRefundedEmailInput,
    ): Promise<TransactionalEmailSendOutcome> {
      const rendered = renderOrderRefunded(send, baseUrl, emailPresentation);
      return sendRendered(ORDER_REFUNDED_TEMPLATE_SLUG, rendered, send);
    },

    async sendShipmentDispatchedNotice(
      send: ShipmentDispatchedEmailInput,
    ): Promise<TransactionalEmailSendOutcome> {
      const rendered = renderShipmentDispatched(send, baseUrl, emailPresentation);
      return sendRendered(SHIPMENT_DISPATCHED_TEMPLATE_SLUG, rendered, send);
    },

    async sendShipmentDeliveredNotice(
      send: ShipmentDeliveredEmailInput,
    ): Promise<TransactionalEmailSendOutcome> {
      const rendered = renderShipmentDelivered(send, baseUrl, emailPresentation);
      return sendRendered(SHIPMENT_DELIVERED_TEMPLATE_SLUG, rendered, send);
    },

    async sendShipmentExceptionNotice(
      send: ShipmentExceptionEmailInput,
    ): Promise<TransactionalEmailSendOutcome> {
      const rendered = renderShipmentException(send, baseUrl, emailPresentation);
      return sendRendered(SHIPMENT_EXCEPTION_TEMPLATE_SLUG, rendered, send);
    },

    async sendReturnApprovedNotice(
      send: ReturnDecisionEmailInput,
    ): Promise<TransactionalEmailSendOutcome> {
      const rendered = renderReturnApproved(send, baseUrl, emailPresentation);
      return sendRendered(RETURN_APPROVED_TEMPLATE_SLUG, rendered, send);
    },

    async sendReturnRejectedNotice(
      send: ReturnDecisionEmailInput,
    ): Promise<TransactionalEmailSendOutcome> {
      const rendered = renderReturnRejected(send, baseUrl, emailPresentation);
      return sendRendered(RETURN_REJECTED_TEMPLATE_SLUG, rendered, send);
    },
  };
}
