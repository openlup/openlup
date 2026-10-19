import {
  createInvoiceDocumentContentFactory, createRoleNotificationContentFactory,
  createInquiryContentFactory, createOptOutContentFactory, renderEmail,
  type Locale, type InvoiceDocumentVars, type RoleNotificationVars, type InquiryVars,
  type OptOutOutcome, type EmailBrand,
} from "@openlup/platform/communications/contracts";
import { emailPresentation } from "#email-presentation";
import { emailRouteUrl } from "./links.js";

const invoice = createInvoiceDocumentContentFactory();
const role = createRoleNotificationContentFactory();
const inquiry = createInquiryContentFactory();
const optOut = createOptOutContentFactory();

export function renderReferenceInvoice(locale: Locale, vars: Omit<InvoiceDocumentVars, "accountDocumentsUrl"> & { baseUrl: string }, brand: EmailBrand = emailPresentation.emailBrandForOrigin(vars.baseUrl)) {
  return renderEmail({ brand, locale, ...invoice.invoiceDocumentEmailContent(locale, {
    ...vars, accountDocumentsUrl: emailRouteUrl(vars.baseUrl, "customerDashboard", locale, { sekcja: "orders" }),
  }) });
}

export function renderReferenceRole(locale: Locale, vars: Omit<RoleNotificationVars, "operatorUrl"> & { siteUrl: string }, brand: EmailBrand = emailPresentation.emailBrandForOrigin(vars.siteUrl)) {
  return renderEmail({ brand, locale, ...role.roleNotificationEmailContent(locale, { ...vars, operatorUrl: `${vars.siteUrl}/admin` }) });
}

/** Pure presentation only; the existing private-label sender is deliberately separate. */
export function renderReferenceInquiry(locale: Locale, vars: InquiryVars, signoff: string, brand: EmailBrand) {
  return {
    receipt: renderEmail({ brand, locale, ...inquiry.inquiryReceiptEmailContent(locale, vars, signoff) }),
    notice: renderEmail({ brand, locale, ...inquiry.inquiryNoticeEmailContent(locale, vars, signoff) }),
  };
}

function escapeDisplay(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Display values are always text, including host brand and support placeholders. */
export function renderOptOutPage(title: string, message: string, locale: Locale = "pl", brandName = emailPresentation.brand.email.copyBrandName): string {
  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeDisplay(title)} - ${escapeDisplay(brandName)}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0a0a0f; color: #f0efe9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { max-width: 400px; text-align: center; padding: 3rem 2rem; border: 1px solid rgba(240,239,233,0.08); border-radius: 1rem; background: rgba(30,30,40,0.5); }
    h1 { color: #5de0c0; font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: rgba(240,239,233,0.6); line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeDisplay(title)}</h1>
    <p>${escapeDisplay(message)}</p>
  </div>
</body>
</html>`;
}

export function renderReferenceOptOut(locale: Locale, outcome: OptOutOutcome): string {
  const content = optOut.optOutContent(locale, outcome, emailPresentation.brand.supportEmail);
  return renderOptOutPage(content.title, content.message, locale);
}
