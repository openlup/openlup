import { abandonedCartEmailContent } from "@/domains/commerce/emails/abandonedCart";
import { backInStockEmailContent } from "@/domains/commerce/emails/backInStock";
import { checkoutExpiredEmailContent } from "@/domains/commerce/emails/checkoutExpired";
import { orderCanceledEmailContent } from "@/domains/commerce/emails/orderCanceled";
import { orderDraftEmailContent } from "@/domains/commerce/emails/orderDraft";
import { orderPaidEmailContent } from "@/domains/commerce/emails/orderPaid";
import { orderRefundedEmailContent } from "@/domains/commerce/emails/orderRefunded";
import { paymentFailedEmailContent } from "@/domains/commerce/emails/paymentFailed";
import { reorderReminderEmailContent } from "@/domains/commerce/emails/reorderReminder";
import { reviewEffectsEmailContent } from "@/domains/commerce/emails/reviewEffects";
import {
  reviewFormUrl,
  reviewRequestEmailContent,
} from "@/domains/commerce/emails/reviewRequest";
import { shipmentDeliveredEmailContent } from "@/domains/commerce/emails/shipmentDelivered";
import { shipmentDispatchedEmailContent } from "@/domains/commerce/emails/shipmentDispatched";

import {
  ACCOUNT_URL,
  APP_SITE_ORIGIN,
  TERMS_URL,
  APP_EMAIL_TEAM_SIGNOFF,
  BODY_BRAND,
  CONFIG_URL,
  LOCALE,
  PAYMENT_RECOVERY_URL,
  SAMPLE_BACK_IN_STOCK,
  SAMPLE_ITEMS,
  SAMPLE_TOTALS,
  UNSUB_URL,
  preview,
  type CanonPreviewRenderer,
} from "./shared";

export const COMMERCE_CANON_PREVIEW_RENDERERS: Record<
  string,
  CanonPreviewRenderer
> = {
  "commerce-order-confirmation": () =>
    preview(
      orderDraftEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          orderId: "order_abc123",
          items: SAMPLE_ITEMS,
          totals: SAMPLE_TOTALS,
          ctaUrl: CONFIG_URL,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "commerce-order-paid": () =>
    preview(
      orderPaidEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          orderId: "order_abc123",
          mode: "one_time",
          items: SAMPLE_ITEMS,
          totals: SAMPLE_TOTALS,
          ctaUrl: ACCOUNT_URL,
          termsUrl: TERMS_URL,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "commerce-payment-failed": () =>
    preview(
      paymentFailedEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          orderId: "order_abc123",
          amountLabel: "129,99 zł",
          mode: "subscription_cycle",
          recoveryUrl: PAYMENT_RECOVERY_URL,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "commerce-checkout-expired": () =>
    preview(
      checkoutExpiredEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          orderId: "order_abc123",
          amountLabel: "129,99 zł",
          ctaUrl: CONFIG_URL,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "commerce-order-canceled": () =>
    preview(
      orderCanceledEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          orderId: "order_abc123",
          amountLabel: "129,99 zł",
          ctaUrl: CONFIG_URL,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "commerce-order-refunded": () =>
    preview(
      orderRefundedEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          brandName: BODY_BRAND,
          orderId: "order_abc123",
          amountLabel: "129,99 zł",
          ctaUrl: CONFIG_URL,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "commerce-shipment-dispatched": () =>
    preview(
      shipmentDispatchedEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          orderId: "order_abc123",
          trackingNumber: "JD0123456789",
          trackingUrl: "https://track.example/JD0123456789",
          siteOrigin: APP_SITE_ORIGIN,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "commerce-shipment-delivered": () =>
    preview(
      shipmentDeliveredEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          orderId: "order_abc123",
          siteOrigin: APP_SITE_ORIGIN,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "commerce-abandoned-cart-1h": () =>
    preview(
      abandonedCartEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          brandName: BODY_BRAND,
          reminderHours: 1,
          ctaUrl: CONFIG_URL,
          unsubscribeUrl: UNSUB_URL,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "commerce-abandoned-cart-24h": () =>
    preview(
      abandonedCartEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          brandName: BODY_BRAND,
          reminderHours: 24,
          ctaUrl: CONFIG_URL,
          unsubscribeUrl: UNSUB_URL,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "commerce-abandoned-cart-72h": () =>
    preview(
      abandonedCartEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          brandName: BODY_BRAND,
          reminderHours: 72,
          ctaUrl: CONFIG_URL,
          unsubscribeUrl: UNSUB_URL,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "commerce-reorder-reminder": () =>
    preview(
      reorderReminderEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          brandName: BODY_BRAND,
          ctaUrl: CONFIG_URL,
          unsubscribeUrl: UNSUB_URL,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "commerce-order-review-request": () =>
    preview(
      reviewRequestEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          contextName: null,
          brandName: BODY_BRAND,
          reviewUrl: reviewFormUrl(APP_SITE_ORIGIN, LOCALE, "sample"),
          unsubscribeUrl: UNSUB_URL,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "commerce-back-in-stock": () =>
    preview(
      backInStockEmailContent(
        LOCALE,
        {
          brandName: BODY_BRAND,
          sku: SAMPLE_BACK_IN_STOCK.sku,
          productName: SAMPLE_BACK_IN_STOCK.productName,
          ctaUrl: CONFIG_URL,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "commerce-order-review-effects": () =>
    preview(
      reviewEffectsEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          contextName: null,
          brandName: BODY_BRAND,
          reviewUrl: reviewFormUrl(APP_SITE_ORIGIN, LOCALE, "sample-effects"),
          unsubscribeUrl: UNSUB_URL,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
};
