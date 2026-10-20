import type { Locale } from "./email.js";
import { button, dataTable, heading, paragraph, type EmailBlock } from "./blocks.js";

export interface InvoiceDocumentVars {
  orderRef: string;
  documentNumber: string;
  kind: "invoice" | "correction";
  accountDocumentsUrl: string;
}

export interface InvoiceDocumentCopy {
  subject: (orderRef: string, correction: boolean) => string;
  preheader: (correction: boolean) => string;
  heading: (correction: boolean) => string;
  attachment: (correction: boolean) => string;
  orderLabel: string;
  documentLabel: (correction: boolean) => string;
  cta: string;
  availability: string;
}

const defaults: Record<Locale, InvoiceDocumentCopy> = {
  pl: {
    subject: (ref, correction) => `${correction ? "Korekta faktury" : "Faktura"} do zamówienia ${ref}`,
    preheader: correction => `${correction ? "Korektę" : "Dokument"} znajdziesz w załączniku i na swoim koncie.`,
    heading: correction => correction ? "Korekta faktury jest gotowa" : "Twoja faktura jest gotowa",
    attachment: correction => correction ? "Korektę faktury przesyłamy w załączniku PDF." : "Fakturę przesyłamy w załączniku PDF.",
    orderLabel: "Zamówienie",
    documentLabel: correction => correction ? "Korekta" : "Faktura",
    cta: "Zobacz dokumenty na koncie",
    availability: "Dokument pozostaje dostępny na Twoim koncie niezależnie od dostarczenia tej wiadomości.",
  },
  en: {
    subject: (ref, correction) => `${correction ? "Invoice correction" : "Invoice"} for order ${ref}`,
    preheader: correction => `The ${correction ? "correction" : "document"} is attached and available in your account.`,
    heading: correction => correction ? "Your invoice correction is ready" : "Your invoice is ready",
    attachment: correction => correction ? "Your invoice correction is attached as a PDF." : "Your invoice is attached as a PDF.",
    orderLabel: "Order",
    documentLabel: correction => correction ? "Correction" : "Invoice",
    cta: "View documents in your account",
    availability: "The document remains available in your account regardless of delivery of this message.",
  },
};

/** Pure defaults; hosts may replace the complete bilingual copy. */
export function createInvoiceDocumentContentFactory(copy: Record<Locale, InvoiceDocumentCopy> = defaults) {
  function invoiceDocumentEmailContent(locale: Locale, vars: InvoiceDocumentVars): { subject: string; preheader: string; blocks: EmailBlock[] } {
    const c = copy[locale], correction = vars.kind === "correction";
    return {
      subject: c.subject(vars.orderRef, correction), preheader: c.preheader(correction),
      blocks: [heading(c.heading(correction)), paragraph(c.attachment(correction)),
        dataTable([{ label: c.orderLabel, value: vars.orderRef }, { label: c.documentLabel(correction), value: vars.documentNumber }]),
        button(c.cta, vars.accountDocumentsUrl), paragraph(c.availability, { muted: true })],
    };
  }
  return { invoiceDocumentEmailContent };
}
