import type { Locale } from "@openlup/platform/communications/contracts";
import { renderReferenceInvoice } from "../../../src/domains/communications/email/referenceContentBinding.js";
import {
  ACCOUNTING_INVOICE_DELIVERY_SOURCE,
  ACCOUNTING_INVOICE_DOCUMENT_TEMPLATE_SLUG,
  type AccountingInvoiceEmailDeliveryPort,
} from "../../../src/domains/accounting/invoiceDeliveryPorts.js";
import { guardEmailTransport, type EmailTransport } from "../../infra/email/emailTransport.js";
import {
  recordEmailDeliveryTimeline,
  type EmailDeliveryTimelineClient,
} from "./emailDeliveryTimeline.js";

export function createAccountingInvoiceDeliveryPort(input: {
  client: EmailDeliveryTimelineClient;
  transport: EmailTransport;
  fromEmail: string;
  baseUrl: string;
  locale?: Locale;
}): AccountingInvoiceEmailDeliveryPort {
  const { client, transport, fromEmail, baseUrl } = input;

  return {
    async sendInvoiceDocument(delivery) {
      const rendered = renderInvoiceEmail(delivery, baseUrl, input.locale ?? "pl");
      await recordEmailDeliveryTimeline(client, {
        dedupeKey: delivery.idempotencyKey,
        templateSlug: ACCOUNTING_INVOICE_DOCUMENT_TEMPLATE_SLUG,
        purpose: "transactional",
        triggerSource: ACCOUNTING_INVOICE_DELIVERY_SOURCE,
        triggerEvent: "invoice.document.delivery",
        status: "processing",
        recipientEmail: delivery.recipientEmail,
        clientId: delivery.clientId,
        aggregateType: "commerce_order",
        aggregateId: delivery.orderId,
        providerKind: transport.providerKind,
        metadata: {
          adapter: "accounting_invoice_document",
          invoiceId: delivery.invoiceId,
          providerInvoiceId: delivery.providerInvoiceId,
          deliverySource: delivery.deliverySource,
        },
      }, {
        required: true,
        context: `${ACCOUNTING_INVOICE_DELIVERY_SOURCE}:${delivery.outboxId}`,
      });

      try {
        const { outcome } = await guardEmailTransport(transport).send({
          from: fromEmail,
          to: delivery.recipientEmail,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          idempotencyKey: delivery.idempotencyKey,
          attachments: [{
            filename: delivery.document.filename,
            content: Buffer.from(delivery.document.content).toString("base64"),
          }],
        });
        const providerMessageId = outcome.resendId?.trim() ?? "";
        if (outcome.ok && providerMessageId && outcome.suppressed !== "drop") {
          return {
            status: "sent",
            providerMessageId,
          };
        }
        return {
          status: "uncertain",
          error: {
            code: "invoice_email_provider_outcome_uncertain",
            providerKind: transport.providerKind,
            httpStatus: outcome.httpStatus,
            aborted: outcome.aborted,
            suppressed: outcome.suppressed ?? null,
            ...(outcome.providerErrorCode
              ? { providerErrorCode: outcome.providerErrorCode }
              : {}),
            ...(outcome.providerError
              ? { providerError: outcome.providerError }
              : {}),
            ...(outcome.egressMode
              ? { egressMode: outcome.egressMode }
              : {}),
          },
        };
      } catch {
        return {
          status: "uncertain",
          error: {
            code: "invoice_email_provider_transport_threw",
            providerKind: transport.providerKind,
          },
        };
      }
    },
  };
}

function renderInvoiceEmail(
  delivery: Parameters<AccountingInvoiceEmailDeliveryPort["sendInvoiceDocument"]>[0],
  baseUrl: string,
  locale: Locale,
) {
  return renderReferenceInvoice(locale, {
    baseUrl, orderRef: delivery.orderRef,
    documentNumber: delivery.providerInvoiceNumber ?? delivery.invoiceRef,
    kind: delivery.deliverySource === "correction_issued" ? "correction" : "invoice",
  });
}
