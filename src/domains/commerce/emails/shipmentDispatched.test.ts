import { describe, expect, it } from "vitest";

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { APP_EMAIL_BRAND, APP_EMAIL_TEAM_SIGNOFF } from "../../../lib/brand/appBrand.js";
import { renderEmail } from "../../communications/email/render.js";
import { shipmentDispatchedEmailContent } from "./shipmentDispatched.js";

const SITE = "https://example.test";
const TEST_LOCALES = Object.keys(APP_EMAIL_BRAND.chrome) as Locale[];

function render(content: ReturnType<typeof shipmentDispatchedEmailContent>, locale: Locale) {
  const output = renderEmail({
    brand: APP_EMAIL_BRAND,
    locale,
    subject: content.subject,
    preheader: content.preheader,
    blocks: content.blocks,
  });
  return { subject: content.subject, preheader: content.preheader, text: output.text, html: output.html };
}

describe("shipmentDispatchedEmailContent", () => {
  it.each(TEST_LOCALES)("renders selected deployment copy in %s", (locale) => {
    const content = shipmentDispatchedEmailContent(locale, {
      firstName: "Anna",
      orderId: "order_abc123",
      petName: "Fistaszek",
      trackingNumber: "JD0123456789",
      trackingUrl: "https://track.example/JD0123456789",
      siteOrigin: SITE,
    }, APP_EMAIL_TEAM_SIGNOFF[locale]);
    const rendered = render(content, locale);

    expect(rendered.preheader.length).toBeGreaterThan(0);
    expect(rendered.subject).toContain("OPENLUP-ABC123");
    expect(rendered.text).toContain("OPENLUP-ABC123");
    expect(rendered.text).toContain("JD0123456789");
    // The tracking page is a text link inside the number box, not a button.
    expect(content.blocks).toContainEqual(expect.objectContaining({
      kind: "dataTable",
      link: expect.objectContaining({ href: "https://track.example/JD0123456789" }),
    }));
    expect(rendered.html).toContain('href="https://track.example/JD0123456789"');
    expect(content.blocks.map((block) => block.kind)).not.toContain("button");
    // The account guide card is the one call to action and lives under the site origin.
    expect(content.blocks).toContainEqual(expect.objectContaining({
      kind: "featureCard",
      cta: expect.objectContaining({ href: `${SITE}/porady/pliki/przewodnik-po-koncie-klienta.pdf` }),
    }));
    expect(rendered.text).toContain("Fistaszek");
  });

  it("keeps the number box without a link when the carrier gave no tracking page", () => {
    const content = shipmentDispatchedEmailContent(TEST_LOCALES[0], {
      firstName: "Anna",
      orderId: "order_abc123",
      trackingNumber: "JD0123456789",
      trackingUrl: null,
      siteOrigin: SITE,
    }, APP_EMAIL_TEAM_SIGNOFF[TEST_LOCALES[0]]);

    const box = content.blocks.find((block) => block.kind === "dataTable");
    expect(box).toBeDefined();
    expect(box).not.toHaveProperty("link");
    expect(content.blocks.map((block) => block.kind)).not.toContain("linkParagraph");
  });

  it("falls back to the status box plus a tracking link when only a URL exists", () => {
    const content = shipmentDispatchedEmailContent(TEST_LOCALES[0], {
      firstName: "Anna",
      orderId: "order_abc123",
      trackingNumber: null,
      trackingUrl: "https://track.example/url-only",
      siteOrigin: SITE,
    }, APP_EMAIL_TEAM_SIGNOFF[TEST_LOCALES[0]]);

    expect(content.blocks).toContainEqual(expect.objectContaining({ kind: "accentBox" }));
    expect(content.blocks).toContainEqual(expect.objectContaining({
      kind: "linkParagraph",
      href: "https://track.example/url-only",
    }));
  });

  it("shows only the status box and the guide card when no tracking value is available", () => {
    const content = shipmentDispatchedEmailContent(TEST_LOCALES[1], {
      firstName: null,
      orderId: "order_abc123",
      trackingNumber: null,
      trackingUrl: null,
      siteOrigin: SITE,
    }, APP_EMAIL_TEAM_SIGNOFF[TEST_LOCALES[1]]);
    const rendered = render(content, TEST_LOCALES[1]);

    expect(content.blocks).toContainEqual(expect.objectContaining({ kind: "accentBox" }));
    expect(content.blocks.map((block) => block.kind)).not.toContain("linkParagraph");
    expect(rendered.html).toContain(`href="${SITE}/porady/pliki/przewodnik-po-koncie-klienta.pdf"`);
    expect(rendered.html).not.toContain("track.example");
  });

  it("joins the guide path onto an origin with a trailing slash without doubling it", () => {
    const content = shipmentDispatchedEmailContent(TEST_LOCALES[0], {
      firstName: null,
      orderId: "order_abc123",
      trackingNumber: null,
      trackingUrl: null,
      siteOrigin: `${SITE}/`,
    }, APP_EMAIL_TEAM_SIGNOFF[TEST_LOCALES[0]]);

    expect(render(content, TEST_LOCALES[0]).html).toContain(`href="${SITE}/porady/pliki/`);
    expect(render(content, TEST_LOCALES[0]).html).not.toContain(`${SITE}//`);
  });
});
