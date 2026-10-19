import { expect, it, vi } from "vitest";
import {
  createInvoiceDocumentContentFactory, createRoleNotificationContentFactory,
  createInquiryContentFactory, createOptOutContentFactory, renderEmail,
  type Locale, type EmailBrand, type OptOutOutcome, type OptOutCopy,
} from "../../src/communications/contracts/index.js";

const brand: EmailBrand = { copyBrandName: "Synthetic A", theme: { bodyBg: "#fff", cardBg: "#fff", accentBg: "#eee", hairline: "#ccc", brand: "#123", onBrand: "#fff", textHeading: "#111", textBody: "#222", textMuted: "#555", fontFamily: "Arial", logoText: "Synthetic A", cardRadiusPx: 12, buttonRadiusPx: 8, maxWidthPx: 600 }, chrome: { pl: { logoAlt: "Synthetic A", footerTagline: "Stopka A" }, en: { logoAlt: "Synthetic A", footerTagline: "Footer A" } } };
const second: EmailBrand = { ...brand, copyBrandName: "Synthetic B", theme: { ...brand.theme, logoText: "Synthetic B" }, chrome: { pl: { logoAlt: "B", footerTagline: "Stopka B" }, en: { logoAlt: "B", footerTagline: "Footer B" } } };
const invoice = createInvoiceDocumentContentFactory().invoiceDocumentEmailContent;
const role = createRoleNotificationContentFactory().roleNotificationEmailContent;
const inquiry = createInquiryContentFactory();
const optOut = createOptOutContentFactory().optOutContent;
const invoiceVars = { orderRef: "ORDER-1", documentNumber: "DOC/1", accountDocumentsUrl: "https://example.test/documents" };
const inquiryVars = { displayName: "Alex Example", contact: "alex@example.test", details: [{ label: "Topic", value: "Synthetic inquiry" }], operatorUrl: "https://example.test/operator/inquiry-1" };

const invoiceCases = [
  ["pl", "invoice", "Faktura do zamówienia ORDER-1", "Dokument znajdziesz w załączniku i na swoim koncie.", "Twoja faktura jest gotowa", "Fakturę przesyłamy w załączniku PDF.", "Zamówienie", "Faktura", "Zobacz dokumenty na koncie", "Dokument pozostaje dostępny na Twoim koncie niezależnie od dostarczenia tej wiadomości."],
  ["pl", "correction", "Korekta faktury do zamówienia ORDER-1", "Korektę znajdziesz w załączniku i na swoim koncie.", "Korekta faktury jest gotowa", "Korektę faktury przesyłamy w załączniku PDF.", "Zamówienie", "Korekta", "Zobacz dokumenty na koncie", "Dokument pozostaje dostępny na Twoim koncie niezależnie od dostarczenia tej wiadomości."],
  ["en", "invoice", "Invoice for order ORDER-1", "The document is attached and available in your account.", "Your invoice is ready", "Your invoice is attached as a PDF.", "Order", "Invoice", "View documents in your account", "The document remains available in your account regardless of delivery of this message."],
  ["en", "correction", "Invoice correction for order ORDER-1", "The correction is attached and available in your account.", "Your invoice correction is ready", "Your invoice correction is attached as a PDF.", "Order", "Correction", "View documents in your account", "The document remains available in your account regardless of delivery of this message."],
] as const;
it.each(invoiceCases)("complete invoice %s/%s", (locale, kind, subject, preheader, title, attachment, orderLabel, documentLabel, cta, availability) => {
  expect(invoice(locale, { ...invoiceVars, kind })).toEqual({ subject, preheader, blocks: [
    { kind: "heading", text: title }, { kind: "paragraph", muted: false, text: attachment },
    { kind: "dataTable", rows: [{ label: orderLabel, value: "ORDER-1" }, { label: documentLabel, value: "DOC/1" }] },
    { kind: "button", label: cta, href: "https://example.test/documents" }, { kind: "paragraph", text: availability, muted: true },
  ] });
});
it("keeps the host-resolved document number including an empty string", () => {
  for (const documentNumber of ["fallback-ref", ""]) expect(invoice("en", { ...invoiceVars, kind: "invoice", documentNumber }).blocks[2]).toEqual({ kind: "dataTable", rows: [{ label: "Order", value: "ORDER-1" }, { label: "Invoice", value: documentNumber }] });
});
it("renders invoice values and links under either host brand and accepts whole-copy replacement", () => {
  const copy = { subject: () => "Host subject", preheader: () => "Host preview", heading: () => "Host heading", attachment: () => "Host attachment", orderLabel: "Host order", documentLabel: () => "Host document", cta: "Host CTA", availability: "Host availability" };
  expect(createInvoiceDocumentContentFactory({ pl: copy, en: copy }).invoiceDocumentEmailContent("en", { ...invoiceVars, kind: "invoice" }).subject).toBe("Host subject");
  for (const b of [brand, second]) {
    const content = invoice("en", { ...invoiceVars, kind: "invoice", orderRef: "<order>&", documentNumber: '<doc>"&' });
    const rendered = renderEmail({ brand: b, locale: "en", ...content });
    expect(rendered.html).toContain("&lt;order&gt;&amp;"); expect(rendered.html).toContain("&lt;doc&gt;&quot;&amp;");
    expect(rendered.html).toContain('href="https://example.test/documents"');
    expect(rendered.text).toContain('<doc>"&'); expect(rendered.text).toContain(b.chrome.en.footerTagline);
  }
});

const roleCases = (["pl", "en"] as const).flatMap(locale => (["admin", "distributor"] as const).flatMap(role => [false, true].map(pending => ({ locale, role, pending }))));
it.each(roleCases)("complete role $locale/$role pending=$pending", ({ locale, role: name, pending }) => {
  const expiry = "2030-01-01T00:00:00Z";
  const heading = locale === "pl" ? pending ? "Zaproszenie operatora" : "Uprawnienia operatora" : pending ? "Operator invitation" : "Operator membership";
  const status = locale === "pl" ? pending ? `Zaproszenie oczekuje na przyjęcie do ${expiry}.` : "Twoje uprawnienia operatora są aktywne." : pending ? `Your invitation is pending until ${expiry}.` : "Your operator membership is active.";
  const body = locale === "pl" ? pending ? `Zaproszono Cię do roli ${name}. Dostęp rozpocznie się po wejściu do panelu operatora ze zweryfikowanym kontem.` : `Przyznano Ci rolę ${name}. Otwórz panel operatora, aby się zalogować.` : pending ? `You are invited as ${name}. Access begins when you enter the operator panel with your verified account.` : `You have the ${name} role. Open the operator panel to sign in.`;
  const footer = locale === "pl" ? pending ? "Jeśli nie oczekujesz tego zaproszenia, skontaktuj się z zespołem aplikacji." : "Jeśli nie oczekujesz tych uprawnień, skontaktuj się z zespołem aplikacji." : pending ? "If you did not expect this invitation, contact the application team." : "If you did not expect this membership, contact the application team.";
  expect(role(locale, { role: name, operatorUrl: "https://example.test/admin", ...(pending ? { expiresAt: expiry } : {}) })).toEqual({ subject: `${heading}: ${name}`, preheader: status, blocks: [
    { kind: "heading", text: heading }, { kind: "paragraph", muted: false, text: status }, { kind: "paragraph", muted: false, text: body },
    { kind: "button", label: locale === "pl" ? "Otwórz panel operatora" : "Open operator panel", href: "https://example.test/admin" }, { kind: "paragraph", text: footer, muted: true },
  ] });
});
it("treats a present empty expiry as pending and escapes display text under either host", () => {
  for (const b of [brand, second]) {
    const content = role("en", { role: "admin", expiresAt: "<expiry>&", operatorUrl: "https://example.test/admin" });
    const rendered = renderEmail({ brand: b, locale: "en", ...content });
    expect(content.preheader).toBe("Your invitation is pending until <expiry>&.");
    expect(rendered.html).toContain("&lt;expiry&gt;&amp;"); expect(rendered.text).toContain("verified account");
    expect(rendered.text).toContain(b.chrome.en.footerTagline); expect(rendered.html).toContain('href="https://example.test/admin"');
  }
  expect(role("en", { role: "admin", expiresAt: "", operatorUrl: "https://example.test/admin" }).preheader).toBe("Your invitation is pending until .");
});
it("uses a host replacement for role copy", () => {
  const host = () => ({ subject: "Host", heading: "Host heading", status: "Host status", body: "Host body", button: "Host action", footer: "Host footer" });
  expect(createRoleNotificationContentFactory({ pl: host, en: host }).roleNotificationEmailContent("pl", { role: "admin", operatorUrl: "https://example.test/admin" })).toEqual({ subject: "Host", preheader: "Host status", blocks: [{ kind: "heading", text: "Host heading" }, { kind: "paragraph", muted: false, text: "Host status" }, { kind: "paragraph", muted: false, text: "Host body" }, { kind: "button", label: "Host action", href: "https://example.test/admin" }, { kind: "paragraph", text: "Host footer", muted: true }] });
});

it.each(["pl", "en"] as const)("complete inquiry receipt %s", locale => {
  const subject = locale === "pl" ? "Otrzymaliśmy Twoje zapytanie" : "We've received your inquiry";
  const body = locale === "pl" ? "Potwierdzamy otrzymanie Twojego zapytania." : "We confirm receipt of your inquiry.";
  expect(inquiry.inquiryReceiptEmailContent(locale, inquiryVars, "Host team")).toEqual({ subject, preheader: body, blocks: [{ kind: "heading", text: subject }, { kind: "paragraph", muted: false, text: locale === "pl" ? "Dziękujemy za kontakt, Alex Example." : "Thank you for contacting us, Alex Example." }, { kind: "paragraph", muted: false, text: body }, { kind: "paragraph", muted: false, text: "Host team" }] });
});
it.each(["pl", "en"] as const)("complete inquiry operator notice %s", locale => {
  const subject = locale === "pl" ? "Nowe zapytanie" : "New inquiry", body = locale === "pl" ? "Otrzymano nowe zapytanie." : "A new inquiry has been received.";
  expect(inquiry.inquiryNoticeEmailContent(locale, inquiryVars, "Host team")).toEqual({ subject, preheader: body, blocks: [{ kind: "heading", text: subject }, { kind: "paragraph", muted: false, text: body }, { kind: "dataTable", rows: [{ label: locale === "pl" ? "Imię i nazwisko" : "Name", value: "Alex Example" }, { label: locale === "pl" ? "Kontakt" : "Contact", value: "alex@example.test" }, { label: "Topic", value: "Synthetic inquiry" }] }, { kind: "button", label: locale === "pl" ? "Otwórz zapytanie" : "Open inquiry", href: "https://example.test/operator/inquiry-1" }, { kind: "paragraph", muted: false, text: "Host team" }] });
});
it.each(["pl", "en"] as const)("omits absent inquiry details %s", locale => {
  expect(inquiry.inquiryNoticeEmailContent(locale, { ...inquiryVars, details: [] }, "Team").blocks[2]).toEqual({ kind: "dataTable", rows: [{ label: locale === "pl" ? "Imię i nazwisko" : "Name", value: "Alex Example" }, { label: locale === "pl" ? "Kontakt" : "Contact", value: "alex@example.test" }] });
});
it("escapes inquiry contact/details and renders only the supplied operator link", () => {
  const vars = { ...inquiryVars, displayName: "<Alex>&", contact: "<contact>&", details: [{ label: "<label>", value: '<value>"&' }] };
  for (const content of [inquiry.inquiryReceiptEmailContent("en", vars, "Team"), inquiry.inquiryNoticeEmailContent("en", vars, "Team")]) {
    const result = renderEmail({ brand, locale: "en", ...content }); expect(result.html).toContain("&lt;Alex&gt;&amp;");
    if (content.subject === "New inquiry") { expect(result.html).toContain("&lt;contact&gt;&amp;"); expect(result.html).toContain("&lt;label&gt;"); expect(result.html).toContain("&lt;value&gt;&quot;&amp;"); expect(result.html).toContain('href="https://example.test/operator/inquiry-1"'); }
    expect(result.text).not.toMatch(/private.label|business.day|discovery.call/i);
  }
});
it("replaces whole inquiry copy without activating a sender", () => {
  const c = { receiptSubject: "Host receipt", receiptGreeting: () => "Host greeting", receiptBody: "Host body", noticeSubject: "Host notice", noticeBody: "Host notice body", nameLabel: "Host name", contactLabel: "Host contact", cta: "Host action" };
  const custom = createInquiryContentFactory({ pl: c, en: c });
  expect(custom.inquiryReceiptEmailContent("pl", inquiryVars, "Team").subject).toBe("Host receipt");
  expect(custom.inquiryNoticeEmailContent("en", inquiryVars, "Team").blocks[3]).toEqual({ kind: "button", label: "Host action", href: inquiryVars.operatorUrl });
});

const optOutCases = [
  [
    "pl",
    "invalid_link",
    "Link nieprawidłowy lub wygasł",
    "Nie udało się przetworzyć tej prośby. Skopiuj pełny link z wiadomości lub napisz na support@example.test."
  ],
  [
    "en",
    "invalid_link",
    "Invalid or expired link",
    "We couldn't process this request. Copy the full link from the email or email support@example.test."
  ],
  [
    "pl",
    "marketing_applied",
    "Wypisano",
    "Nie będziesz już otrzymywać tych wiadomości marketingowych. Wiadomości potrzebne do obsługi konta, zamówień, płatności i subskrypcji mogą nadal przychodzić."
  ],
  [
    "en",
    "marketing_applied",
    "You're unsubscribed",
    "You won't receive these marketing emails anymore. Messages needed to manage your account, orders, payments and subscriptions may still arrive."
  ],
  [
    "pl",
    "missing_information",
    "Brakuje danych",
    "Nieprawidłowy link do wypisania."
  ],
  [
    "en",
    "missing_information",
    "Missing information",
    "This unsubscribe link is incomplete."
  ],
  [
    "pl",
    "not_found",
    "Nie znaleziono",
    "Nie znaleziono takiego zgłoszenia."
  ],
  [
    "en",
    "not_found",
    "Not found",
    "We couldn't find this request."
  ],
  [
    "pl",
    "legacy_applied",
    "Wypisano",
    "Zapisaliśmy Twoją rezygnację z wybranych wiadomości. Wiadomości potrzebne do obsługi konta, zamówień, płatności i subskrypcji mogą nadal przychodzić."
  ],
  [
    "en",
    "legacy_applied",
    "You're unsubscribed",
    "We've recorded your opt-out from the selected messages. Messages needed to manage your account, orders, payments and subscriptions may still arrive."
  ],
  [
    "pl",
    "legacy_replay",
    "Już wypisano",
    "Twoja rezygnacja z wybranych wiadomości jest już zapisana. Wiadomości potrzebne do obsługi konta, zamówień, płatności i subskrypcji mogą nadal przychodzić."
  ],
  [
    "en",
    "legacy_replay",
    "Already unsubscribed",
    "Your opt-out from the selected messages is already recorded. Messages needed to manage your account, orders, payments and subscriptions may still arrive."
  ],
  [
    "pl",
    "error",
    "Błąd",
    "Coś poszło nie tak. Spróbuj ponownie później."
  ],
  [
    "en",
    "error",
    "Error",
    "Something went wrong. Try again later."
  ]
] as const;
it.each(optOutCases)("complete opt-out %s/%s", (locale, outcome, title, message) => {
  expect(optOut(locale, outcome, "support@example.test")).toEqual({ title, message });
});
it("substitutes support display text and accepts complete host copy", () => {
  expect(optOut("en", "invalid_link", '<support>&"')).toEqual({ title: "Invalid or expired link", message: "We couldn't process this request. Copy the full link from the email or email <support>&\"." });
  const copy = Object.fromEntries((optOutCases.filter(([locale]) => locale === "pl")).map(([, outcome]) => [outcome, { pl: { title: "Host Polish", message: "Contact {supportEmail}" }, en: { title: "Host EN", message: "Contact {supportEmail}" } }])) as OptOutCopy;
  expect(createOptOutContentFactory(copy).optOutContent("pl", "error", "support@example.test")).toEqual({ title: "Host Polish", message: "Contact support@example.test" });
});
it("all default factories are usable without fetch or environmental configuration", () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("unexpected fetch"); });
  try {
    for (const locale of ["pl", "en"] as Locale[]) {
      expect(invoice(locale, { ...invoiceVars, kind: "invoice" }).blocks).toHaveLength(5);
      expect(role(locale, { role: "admin", operatorUrl: "https://example.test/admin" }).blocks).toHaveLength(5);
      expect(inquiry.inquiryReceiptEmailContent(locale, inquiryVars, "Team").blocks).toHaveLength(4);
      expect(optOut(locale, "error" as OptOutOutcome, "support@example.test").title).toBeTruthy();
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});
