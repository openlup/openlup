import type { Locale } from "./email.js";
import { button, dataTable, heading, paragraph, type DataRow, type EmailBlock } from "./blocks.js";

export interface InquiryVars {
  displayName: string;
  contact: string;
  /** Host-resolved labels and values; omit optional rows rather than inventing them. */
  details: DataRow[];
  operatorUrl: string;
}
export interface InquiryCopy {
  receiptSubject: string;
  receiptGreeting: (name: string) => string;
  receiptBody: string;
  noticeSubject: string;
  noticeBody: string;
  nameLabel: string;
  contactLabel: string;
  cta: string;
}
const defaults: Record<Locale, InquiryCopy> = {
  pl: {
    receiptSubject: "Otrzymaliśmy Twoje zapytanie",
    receiptGreeting: name => `Dziękujemy za kontakt, ${name}.`,
    receiptBody: "Potwierdzamy otrzymanie Twojego zapytania.",
    noticeSubject: "Nowe zapytanie", noticeBody: "Otrzymano nowe zapytanie.",
    nameLabel: "Imię i nazwisko", contactLabel: "Kontakt", cta: "Otwórz zapytanie",
  },
  en: {
    receiptSubject: "We've received your inquiry",
    receiptGreeting: name => `Thank you for contacting us, ${name}.`,
    receiptBody: "We confirm receipt of your inquiry.",
    noticeSubject: "New inquiry", noticeBody: "A new inquiry has been received.",
    nameLabel: "Name", contactLabel: "Contact", cta: "Open inquiry",
  },
};

/** Presentation only: no recipient, sender, response-time promise or country policy. */
export function createInquiryContentFactory(copy: Record<Locale, InquiryCopy> = defaults) {
  function inquiryReceiptEmailContent(locale: Locale, vars: InquiryVars, signoff: string): { subject: string; preheader: string; blocks: EmailBlock[] } {
    const c = copy[locale];
    return { subject: c.receiptSubject, preheader: c.receiptBody,
      blocks: [heading(c.receiptSubject), paragraph(c.receiptGreeting(vars.displayName)), paragraph(c.receiptBody), paragraph(signoff)] };
  }
  function inquiryNoticeEmailContent(locale: Locale, vars: InquiryVars, signoff: string): { subject: string; preheader: string; blocks: EmailBlock[] } {
    const c = copy[locale];
    return { subject: c.noticeSubject, preheader: c.noticeBody,
      blocks: [heading(c.noticeSubject), paragraph(c.noticeBody),
        dataTable([{ label: c.nameLabel, value: vars.displayName }, { label: c.contactLabel, value: vars.contact }, ...vars.details]),
        button(c.cta, vars.operatorUrl), paragraph(signoff)] };
  }
  return { inquiryReceiptEmailContent, inquiryNoticeEmailContent };
}
