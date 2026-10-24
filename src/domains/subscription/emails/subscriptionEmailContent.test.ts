import { describe, expect, it } from "vitest";
import { renderEmail } from "../../communications/email/render.js";
import { APP_EMAIL_BRAND } from "../../../lib/brand/appBrand.js";
import { subscriptionPaymentExpiredEmailContent } from "./subscriptionPaymentExpired.js";
import { subscriptionPaymentFailedEmailContent } from "./subscriptionPaymentFailed.js";
import { subscriptionEmailContent as publicContent } from "./exampleSubscriptionEmailContent.js";

const EXPECTED_KEYS = [
  "activationActionRequired", "addressChanged", "cancelled", "cycleSkipped",
  "deliveryRescheduled", "packageChanged", "pauseReminder", "paused",
  "paymentExpired", "paymentFailed", "paymentRecovered", "renewalAtRisk",
  "renewalUpcoming", "resumed", "welcome", "winback",
];

describe("subscription email content roots", () => {
  it("exposes the complete public bilingual contract", () => {
    expect(publicContent.id).toBe("example");
    const localizedEntries = Object.entries(publicContent)
      .filter(([key]) => key !== "id");
    expect(localizedEntries.map(([key]) => key).sort()).toEqual([...EXPECTED_KEYS].sort());
    for (const [, localized] of localizedEntries) {
      if (typeof localized !== "object" || localized === null) {
        throw new Error("subscription email family must be a localized object");
      }
      expect(Object.keys(localized).sort()).toEqual(["en", "pl"]);
    }
  });

  it.each(["en", "pl"] as const)("keeps expired-payment copy true for resume and repair links in %s", (locale) => {
    for (const recoveryUrl of [
      "https://example.test/recovery?purpose=resume_subscription&token=legacy",
      "https://example.test/recovery?purpose=repair_payment&token=current",
      null,
    ]) for (const amountLabel of ["12.00 USD", null]) {
      const content = subscriptionPaymentExpiredEmailContent(locale, {
        firstName: null, amountLabel, recoveryUrl,
      }, "Example team");
      const rendered = renderEmail({ brand: APP_EMAIL_BRAND, locale, ...content });
      const prose = `${content.subject} ${content.preheader} ${rendered.text}`;
      expect(prose).not.toMatch(/\b(cycle|cykl\w*|active|paused|suspend\w*|aktyw\w*|wstrzym\w*|zawiesz\w*)\b/iu);
      expect(prose).toContain(locale === "en"
        ? "your subscription payment could not be completed"
        : "nie udało się dokończyć płatności za subskrypcję");
      if (recoveryUrl) {
        expect(rendered.html).toContain(recoveryUrl.replace(/&/g, "&amp;"));
        expect(prose).toContain(locale === "en"
          ? "complete payment to continue your subscription"
          : "dokończyć płatność i kontynuować subskrypcję");
      } else {
        expect(content.blocks.some((block) => block.kind === "button")).toBe(false);
        expect(prose).toContain(locale === "en" ? "Support can help" : "Obsługa może pomóc");
      }
    }
  });

  it.each(["en", "pl"] as const)("keeps failed-payment retry and no-retry copy true in %s", (locale) => {
    for (const nextRetryDateLabel of [null, "2030-01-01"]) {
      const vars = { firstName: null, amountLabel: null, retryAttempt: 3, nextRetryDateLabel };
      const scheduled = subscriptionPaymentFailedEmailContent(locale, vars, "Example team");
      const rendered = renderEmail({ brand: APP_EMAIL_BRAND, locale, ...scheduled });
      expect(rendered.text).toContain(locale === "en" ? "subscription active" : "subskrypcja aktywna");
      expect(rendered.text).toContain(publicContent.paymentFailed[locale].reassurance(3, nextRetryDateLabel));
      const stopped = subscriptionPaymentFailedEmailContent(locale, { ...vars, retryScheduled: false }, "Example team");
      const stoppedText = renderEmail({ brand: APP_EMAIL_BRAND, locale, ...stopped }).text;
      expect(stoppedText).toContain(publicContent.paymentFailed[locale].noRetryAction);
      expect(stoppedText).not.toContain(publicContent.paymentFailed[locale].reassurance(3, nextRetryDateLabel));
      expect(stoppedText).not.toMatch(/2030-01-01|7 days|7 dni/u);
    }
  });

  it("freezes the public composition root", () => {
    expect(Object.isFrozen(publicContent)).toBe(true);
  });
});
