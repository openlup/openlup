import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { APP_EMAIL_BRAND } from "../../../lib/brand/appBrand.js";
import { renderEmail } from "./render.js";
import * as m0 from "../../commerce/emails/abandonedCart.js";
import * as m1 from "../../commerce/emails/backInStock.js";
import * as m2 from "../../commerce/emails/checkoutExpired.js";
import * as m3 from "../../commerce/emails/checkoutRecovery.js";
import * as m4 from "../../commerce/emails/orderCanceled.js";
import * as m5 from "../../commerce/emails/orderDraft.js";
import * as m6 from "../../commerce/emails/orderPaid.js";
import * as m7 from "../../commerce/emails/orderRefunded.js";
import * as m8 from "../../commerce/emails/paymentFailed.js";
import * as m9 from "../../commerce/emails/reorderReminder.js";
import * as m10 from "../../commerce/emails/returnEmails.js";
import * as m11 from "../../commerce/emails/reviewEffects.js";
import * as m12 from "../../commerce/emails/reviewRequest.js";
import * as m13 from "../../commerce/emails/shipmentDelivered.js";
import * as m14 from "../../commerce/emails/shipmentDispatched.js";
import * as m15 from "../../commerce/emails/shipmentException.js";
import * as m16 from "../../subscription/emails/subscriptionActivationActionRequired.js";
import * as m17 from "../../subscription/emails/subscriptionAddressChanged.js";
import * as m18 from "../../subscription/emails/subscriptionCancelled.js";
import * as m19 from "../../subscription/emails/subscriptionCycleSkipped.js";
import * as m20 from "../../subscription/emails/subscriptionDeliveryRescheduled.js";
import * as m21 from "../../subscription/emails/subscriptionPackageChanged.js";
import * as m22 from "../../subscription/emails/subscriptionPauseReminder.js";
import * as m23 from "../../subscription/emails/subscriptionPaused.js";
import * as m24 from "../../subscription/emails/subscriptionPaymentExpired.js";
import * as m25 from "../../subscription/emails/subscriptionPaymentFailed.js";
import * as m26 from "../../subscription/emails/subscriptionPaymentRecovered.js";
import * as m27 from "../../subscription/emails/subscriptionRenewalAtRisk.js";
import * as m28 from "../../subscription/emails/subscriptionRenewalUpcoming.js";
import * as m29 from "../../subscription/emails/subscriptionResumed.js";
import * as m30 from "../../subscription/emails/subscriptionWelcome.js";
import * as m31 from "../../subscription/emails/subscriptionWinback.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Golden digests were captured before extraction from the public implementation.
// Each covers whole subjects/preheaders/ordered blocks and full HTML/text, not fragments.
function fixture(row: number) {
  const filled = row % 2 === 0;
  const optional = filled ? "Synthetic detail <&> **bold**" : row % 3 === 0 ? undefined : null;
  const url = filled ? "https://example.test/action?a=1&b=2" : optional;
  return {
    firstName: filled ? "Alex <&>" : null, brandName: "Example", orderId: "order-123456789", sku: "sku-1",
    productName: optional, petName: optional, contextName: optional,
    reminderHours: [1, 24, 72, 20][row % 4], mode: row % 3 ? "one_time" : "subscription_cycle",
    ctaUrl: url, recoveryUrl: url, reviewUrl: "https://example.test/review", unsubscribeUrl: "https://example.test/unsubscribe",
    siteOrigin: "https://example.test/", termsUrl: url, amountLabel: optional, parcelNote: optional,
    items: filled ? [{ name: "Item <&>", quantity: 2, lineTotalLabel: "12.00" }, { name: "Item two", quantity: 1, lineTotalLabel: "" }] : [],
    totals: filled ? { subtotalLabel: row % 3 ? "12.00" : null, discountLabel: row % 3 ? "2.00" : null, totalLabel: "10.00",
      ...(row % 4 ? { firstSubscription: { catalogLabel: "12.00", productPayableLabel: "10.00", shippingLabel: row % 3 ? "2.00" : null, shippingFree: row % 3 === 0 } } : {}) } : null,
    ctaKind: row % 3 ? "recovery" : "compose", trackingNumber: optional, trackingUrl: url,
    cadenceDays: filled ? 28 : null, chargeDateLabel: optional, deliveryWindowLabel: row % 3 ? optional : null,
    holidayNote: optional, editCutoffLabel: optional, resumeDateLabel: optional, renewalDateLabel: optional,
    action: row % 3 ? "increase" : "decrease", retryAttempt: row % 4, nextRetryDateLabel: optional,
    methodScheme: row % 3 ? " Visa " : "", methodLastDigits: filled ? " 4242 " : "",
    cause: ["unknown", "method_missing", "method_cannot_recur", "needs_confirmation", "method_dead", "method_data_invalid"][row % 6],
    retryScheduled: row % 3 === 0 ? undefined : row % 3 === 1,
    starterAmountLabel: optional, starterStage: row % 3 ? "delivery2" : "graduation",
    starterSteadyUnitCount: filled ? 4 : null, starterSteadyCadenceDays: row % 3 ? 28 : null, starterSteadyDetail: optional,
  };
}

describe("P3 public donor whole-output parity", () => {
  it("abandonedCartEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row), ctaUrl: "https://example.test/action" } as Parameters<typeof m0.abandonedCartEmailContent>[1];
      const content = m0.abandonedCartEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("backInStockEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m1.backInStockEmailContent>[1];
      const content = m1.backInStockEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("checkoutExpiredEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m2.checkoutExpiredEmailContent>[1];
      const content = m2.checkoutExpiredEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("checkoutRecoveryEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row), recoveryUrl: "https://example.test/recovery" } as Parameters<typeof m3.checkoutRecoveryEmailContent>[1];
      const content = m3.checkoutRecoveryEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("orderCanceledEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m4.orderCanceledEmailContent>[1];
      const content = m4.orderCanceledEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("orderDraftEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m5.orderDraftEmailContent>[1];
      const content = m5.orderDraftEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("orderPaidEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m6.orderPaidEmailContent>[1];
      const content = m6.orderPaidEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("orderRefundedEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m7.orderRefundedEmailContent>[1];
      const content = m7.orderRefundedEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("paymentFailedEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row), recoveryUrl: "https://example.test/recovery" } as Parameters<typeof m8.paymentFailedEmailContent>[1];
      const content = m8.paymentFailedEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("reorderReminderEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row), ctaUrl: "https://example.test/action" } as Parameters<typeof m9.reorderReminderEmailContent>[1];
      const content = m9.reorderReminderEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("returnApprovedEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m10.returnApprovedEmailContent>[1];
      const content = m10.returnApprovedEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("returnRejectedEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m10.returnRejectedEmailContent>[1];
      const content = m10.returnRejectedEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("returnRefundedEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m10.returnRefundedEmailContent>[1];
      const content = m10.returnRefundedEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("reviewEffectsEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m11.reviewEffectsEmailContent>[1];
      const content = m11.reviewEffectsEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("reviewRequestEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m12.reviewRequestEmailContent>[1];
      const content = m12.reviewRequestEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("shipmentDeliveredEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m13.shipmentDeliveredEmailContent>[1];
      const content = m13.shipmentDeliveredEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("shipmentDispatchedEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m14.shipmentDispatchedEmailContent>[1];
      const content = m14.shipmentDispatchedEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("shipmentExceptionEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m15.shipmentExceptionEmailContent>[1];
      const content = m15.shipmentExceptionEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("subscriptionActivationActionRequiredEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row), ctaUrl: "https://example.test/action" } as Parameters<typeof m16.subscriptionActivationActionRequiredEmailContent>[1];
      const content = m16.subscriptionActivationActionRequiredEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("subscriptionAddressChangedEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m17.subscriptionAddressChangedEmailContent>[1];
      const content = m17.subscriptionAddressChangedEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("subscriptionCancelledEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m18.subscriptionCancelledEmailContent>[1];
      const content = m18.subscriptionCancelledEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("subscriptionCycleSkippedEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m19.subscriptionCycleSkippedEmailContent>[1];
      const content = m19.subscriptionCycleSkippedEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("subscriptionDeliveryRescheduledEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m20.subscriptionDeliveryRescheduledEmailContent>[1];
      const content = m20.subscriptionDeliveryRescheduledEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("subscriptionPackageChangedEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m21.subscriptionPackageChangedEmailContent>[1];
      const content = m21.subscriptionPackageChangedEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("subscriptionPauseReminderEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row), ctaUrl: "https://example.test/action" } as Parameters<typeof m22.subscriptionPauseReminderEmailContent>[1];
      const content = m22.subscriptionPauseReminderEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("subscriptionPausedEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m23.subscriptionPausedEmailContent>[1];
      const content = m23.subscriptionPausedEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("subscriptionPaymentExpiredEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m24.subscriptionPaymentExpiredEmailContent>[1];
      const content = m24.subscriptionPaymentExpiredEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("subscriptionPaymentFailedEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m25.subscriptionPaymentFailedEmailContent>[1];
      const content = m25.subscriptionPaymentFailedEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("subscriptionPaymentRecoveredEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m26.subscriptionPaymentRecoveredEmailContent>[1];
      const content = m26.subscriptionPaymentRecoveredEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("subscriptionRenewalAtRiskEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row), cause: row % 2 ? "mandate" : "missing", ctaUrl: "https://example.test/action" } as Parameters<typeof m27.subscriptionRenewalAtRiskEmailContent>[1];
      const content = m27.subscriptionRenewalAtRiskEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("subscriptionRenewalUpcomingEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m28.subscriptionRenewalUpcomingEmailContent>[1];
      const content = m28.subscriptionRenewalUpcomingEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("subscriptionResumedEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m29.subscriptionResumedEmailContent>[1];
      const content = m29.subscriptionResumedEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("subscriptionWelcomeEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m30.subscriptionWelcomeEmailContent>[1];
      const content = m30.subscriptionWelcomeEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
  it("subscriptionWinbackEmailContent: complete content and rendered bytes", () => {
    const outputs: unknown[] = [];
    for (const locale of ["pl", "en"] as const) for (let row = 0; row < 24; row++) {
      const vars = { ...fixture(row) } as Parameters<typeof m31.subscriptionWinbackEmailContent>[1];
      const content = m31.subscriptionWinbackEmailContent(locale, vars, "Synthetic signoff");
      outputs.push({ content, rendered: renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content }) });
    }
    expect(digest(outputs)).toMatchSnapshot();
  });
});
// All nine block kinds, inline-link policy, optional chrome, and constructor
// own-property distinctions are pinned independently of any content factory.
it("preserves every block kind and complete rendered chrome", async () => {
  const b = await import("./blocks.js");
  const blocks = [
    b.heading("Title <&> **bold**"),
    b.paragraph("First\nSecond [safe](https://example.test/?a=1&b=2) [mail](mailto:help@example.test) [bad](javascript:alert)", { muted: true }),
    b.paragraph("After card", { afterCard: true }), b.paragraph("Plain"),
    b.list(["One **bold**", "Two <&>"]), b.accentBox(["Line <&>"]), b.accentBox(["Labelled"], { label: "Eyebrow" }),
    b.dataTable([{ label: "Name", value: "Value <&>" }], { link: { label: "Track", href: "https://example.test/track" } }),
    b.dataTable([]), b.featureCard({ title: "Guide", text: "Guide copy", cta: { label: "Read", href: "https://example.test/guide" } }),
    b.featureCard({ eyebrow: "Help", title: "Image guide", text: "Text **bold**", cta: { label: "Read", href: "https://example.test/read" }, image: { src: "https://example.test/image.png", alt: "Image <&>", widthPx: 80, heightPx: 60 } }),
    b.button("Continue <&>", "https://example.test/action?a=1&b=2"), b.linkParagraph("Footer", "https://example.test/footer", { muted: true, afterCard: true }), b.divider(),
  ];
  expect(b.paragraph("Plain")).toEqual({ kind: "paragraph", text: "Plain", muted: false });
  expect(Object.prototype.hasOwnProperty.call(b.accentBox([]), "label")).toBe(true);
  expect(Object.prototype.hasOwnProperty.call(b.dataTable([]), "link")).toBe(false);
  const outputs: unknown[] = [];
  for (const locale of ["pl", "en"] as const) for (const enhanced of [false, true]) {
    const brand = { ...APP_EMAIL_BRAND, theme: { ...APP_EMAIL_BRAND.theme, ...(enhanced ? { logoImageUrl: "https://example.test/logo.png", featureCardBg: "#fafafa", featureCardAccent: "#333333" } : {}) }, chrome: { ...APP_EMAIL_BRAND.chrome, [locale]: { ...APP_EMAIL_BRAND.chrome[locale], ...(enhanced ? { bannerImageUrl: "https://example.test/banner.png", footerTagline: "Synthetic footer" } : {}) } } };
    outputs.push(renderEmail({ brand, locale, subject: "Subject <&>", preheader: enhanced ? "Preview <&>" : undefined, blocks }));
  }
  expect(digest({ blocks, outputs })).toMatchSnapshot();
});
