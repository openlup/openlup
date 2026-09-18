import {
  renderEmail,
  type RenderEmailInput,
  type RenderedEmail,
} from "@/domains/communications/email/render";
import {
  emailRouteUrl,
  emailRouteUrlForRecoveryDestination,
} from "@/domains/communications/email/links";
import {
  APP_EMAIL_BRAND,
  APP_EMAIL_TEAM_SIGNOFF,
  APP_SITE_ORIGIN,
} from "@/lib/brand/appBrand";
import type { Locale } from "@/lib/i18n/resolveLocale";

export type CanonPreviewRenderer = () => RenderedEmail;

export const LOCALE: Locale = "pl";

export const SAMPLE_ITEMS = [
  {
    name: "Produkt demonstracyjny A",
    quantity: 2,
    lineTotalLabel: "119,98 zł",
  },
  { name: "Produkt demonstracyjny B", quantity: 1, lineTotalLabel: "30,01 zł" },
];

export const SAMPLE_BACK_IN_STOCK = {
  sku: "SKU-EXAMPLE-001",
  productName: "Produkt demonstracyjny",
};

export const SAMPLE_TOTALS = {
  subtotalLabel: "150,99 zł",
  discountLabel: "-21,00 zł",
  totalLabel: "129,99 zł",
};

export const BODY_BRAND =
  APP_EMAIL_BRAND.copyBrandNameCased ?? APP_EMAIL_BRAND.copyBrandName;
export const ACCOUNT_URL = emailRouteUrl(APP_SITE_ORIGIN, "customerDashboard", LOCALE);
export const TERMS_URL = emailRouteUrl(APP_SITE_ORIGIN, "terms", LOCALE);
export const CONFIG_URL = emailRouteUrl(APP_SITE_ORIGIN, "configurator", LOCALE);
export const PAYMENT_RECOVERY_URL = emailRouteUrlForRecoveryDestination(
  APP_SITE_ORIGIN,
  "checkout_recovery",
  LOCALE,
  { token: "rcv_preview" },
);
// Unsubscribe is a signed delivery endpoint rather than an app route, so it is
// rooted at the selected presentation origin without inventing an EmailRouteKey.
export const UNSUB_URL = new URL("/unsubscribe?token=sample", APP_SITE_ORIGIN).toString();

export { APP_EMAIL_BRAND, APP_EMAIL_TEAM_SIGNOFF, APP_SITE_ORIGIN };

/** Render any content-function result through the shared renderer + theme. */
export function preview(
  content: Pick<RenderEmailInput, "subject" | "preheader" | "blocks">,
): RenderedEmail {
  return renderEmail({
    brand: APP_EMAIL_BRAND,
    locale: LOCALE,
    subject: content.subject,
    preheader: content.preheader,
    blocks: content.blocks,
  });
}
