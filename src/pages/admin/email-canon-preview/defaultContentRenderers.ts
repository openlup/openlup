import { renderReferenceInvoice, renderReferenceRole } from "@/domains/communications/email/referenceContentBinding";
import { APP_SITE_ORIGIN, LOCALE, type CanonPreviewRenderer } from "./shared";

export const DEFAULT_CONTENT_PREVIEW_RENDERERS: Record<string, CanonPreviewRenderer> = {
  "commerce-invoice-document": () => renderReferenceInvoice(LOCALE, {
    baseUrl: APP_SITE_ORIGIN, orderRef: "ORDER-EXAMPLE", documentNumber: "DOC/EXAMPLE", kind: "invoice",
  }),
  "admin-user-role-granted": () => renderReferenceRole(LOCALE, { siteUrl: APP_SITE_ORIGIN, role: "admin" }),
};
