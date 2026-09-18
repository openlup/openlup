import { button, dataTable, heading, paragraph } from "../../../src/domains/communications/email/blocks.js";
import { emailRouteUrl } from "../../../src/domains/communications/email/links.js";
import { renderEmail } from "../../../src/domains/communications/email/render.js";
import {
  ACCOUNTING_INVOICE_DELIVERY_SOURCE,
  ACCOUNTING_INVOICE_DOCUMENT_TEMPLATE_SLUG,
  type AccountingInvoiceEmailDeliveryPort,
} from "../../../src/domains/accounting/invoiceDeliveryPorts.js";
import { appEmailBrandForOrigin } from "../../../src/lib/brand/appBrand.js";
import type { EmailTransport } from "../../infra/email/emailTransport.js";
import {
  recordEmailDeliveryTimeline,
  type EmailDeliveryTimelineClient,
} from "./emailDeliveryTimeline.js";

export function createAccountingInvoiceDeliveryPort(input: {
  client: EmailDeliveryTimelineClient;
  transport: EmailTransport;
  fromEmail: string;
  baseUrl: string;
}): AccountingInvoiceEmailDeliveryPort {
  const { client, transport, fromEmail, baseUrl } = input;

  return {
    async sendInvoiceDocument(delivery) {
      const rendered = renderInvoiceEmail(delivery, baseUrl);
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
        const { outcome } = await transport.send({
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
) {
  const invoiceNumber = delivery.providerInvoiceNumber ?? delivery.invoiceRef;
  const correction = delivery.deliverySource === "correction_issued";
  return renderEmail({
    brand: appEmailBrandForOrigin(baseUrl),
    locale: "pl",
    subject: `${correction ? "Korekta faktury" : "Faktura"} do zamówienia ${delivery.orderRef}`,
    preheader: `${correction ? "Korektę" : "Dokument"} znajdziesz w załączniku i na swoim koncie.`,
    blocks: [
      heading(correction ? "Korekta faktury jest gotowa" : "Twoja faktura jest gotowa"),
      paragraph(correction ? "Korektę faktury przesyłamy w załączniku PDF." : "Fakturę przesyłamy w załączniku PDF."),
      dataTable([
        { label: "Zamówienie", value: delivery.orderRef },
        { label: correction ? "Korekta" : "Faktura", value: invoiceNumber },
      ]),
      button("Zobacz dokumenty na koncie", emailRouteUrl(baseUrl, "customerDashboard", "pl", { sekcja: "orders" })),
      paragraph("Dokument pozostaje dostępny na Twoim koncie niezależnie od dostarczenia tej wiadomości.", { muted: true }),
    ],
  });
}
