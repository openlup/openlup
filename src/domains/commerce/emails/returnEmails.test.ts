import { describe, expect, it } from "vitest";

import { APP_EMAIL_BRAND, APP_EMAIL_TEAM_SIGNOFF } from "../../../lib/brand/appBrand.js";
import { renderEmail } from "../../communications/email/render.js";
import {
  returnApprovedEmailContent,
  returnRejectedEmailContent,
  returnRefundedEmailContent,
  type ReturnEmailContent,
  type ReturnEmailVars,
} from "./returnEmails.js";

function render(content: ReturnEmailContent, locale: "pl" | "en") {
  const output = renderEmail({
    brand: APP_EMAIL_BRAND,
    locale,
    subject: content.subject,
    preheader: content.preheader,
    blocks: content.blocks,
  });
  return { subject: content.subject, preheader: content.preheader, text: output.text, html: output.html };
}

const baseVars: ReturnEmailVars = { firstName: "Ala", orderId: "order_abc123" };

describe("return email content", () => {
  it.each(["pl", "en"] as const)("renders selected approved and rejected notices with or without CTAs (%s)", (locale) => {
    const approved = render(returnApprovedEmailContent(locale, {
      ...baseVars,
      ctaUrl: "https://example.test/returns",
    }, APP_EMAIL_TEAM_SIGNOFF[locale]), locale);
    const approvedNoCta = render(returnApprovedEmailContent(locale, baseVars, APP_EMAIL_TEAM_SIGNOFF[locale]), locale);
    const rejected = render(returnRejectedEmailContent(locale, {
      ...baseVars,
      ctaUrl: "https://example.test/account",
    }, APP_EMAIL_TEAM_SIGNOFF[locale]), locale);
    const rejectedNoCta = render(returnRejectedEmailContent(locale, baseVars, APP_EMAIL_TEAM_SIGNOFF[locale]), locale);

    for (const email of [approved, approvedNoCta, rejected, rejectedNoCta]) {
      expect(email.subject).toContain("OPENLUP-ABC123");
      expect(email.preheader.length).toBeGreaterThan(0);
      expect(email.text).toContain("OPENLUP-ABC123");
    }
    expect(approved.html).toContain('href="https://example.test/returns"');
    expect(rejected.html).toContain('href="https://example.test/account"');
    expect(approvedNoCta.html).not.toContain("example.test/returns");
    expect(rejectedNoCta.html).not.toContain("example.test/account");
  });

  it.each(["pl", "en"] as const)("renders selected refunded notices for known and unknown amounts with or without a CTA (%s)", (locale) => {
    const knownCta = render(returnRefundedEmailContent(locale, {
      ...baseVars,
      amountLabel: "129.99",
      ctaUrl: "https://example.test/build",
    }, APP_EMAIL_TEAM_SIGNOFF[locale]), locale);
    const knownNoCta = render(returnRefundedEmailContent(locale, {
      ...baseVars,
      amountLabel: "129.99",
      ctaUrl: null,
    }, APP_EMAIL_TEAM_SIGNOFF[locale]), locale);
    const unknownCta = render(returnRefundedEmailContent(locale, {
      ...baseVars,
      amountLabel: null,
      ctaUrl: "https://example.test/build",
    }, APP_EMAIL_TEAM_SIGNOFF[locale]), locale);
    const unknownNoCta = render(returnRefundedEmailContent(locale, {
      ...baseVars,
      amountLabel: null,
      ctaUrl: null,
    }, APP_EMAIL_TEAM_SIGNOFF[locale]), locale);

    expect(knownCta.text).toContain("129.99");
    expect(knownNoCta.text).toContain("129.99");
    expect(unknownCta.text).not.toContain("129.99");
    expect(unknownNoCta.text).not.toContain("129.99");
    expect(knownCta.html).toContain('href="https://example.test/build"');
    expect(unknownCta.html).toContain('href="https://example.test/build"');
    expect(knownNoCta.html).not.toContain("example.test/build");
    expect(unknownNoCta.html).not.toContain("example.test/build");
  });
});
