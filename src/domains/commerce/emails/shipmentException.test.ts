import { describe, expect, it } from "vitest";

import { APP_EMAIL_BRAND, APP_EMAIL_TEAM_SIGNOFF } from "../../../lib/brand/appBrand.js";
import { renderEmail } from "../../communications/email/render.js";
import { shipmentExceptionEmailContent } from "./shipmentException.js";

function render(content: ReturnType<typeof shipmentExceptionEmailContent>, locale: "pl" | "en") {
  const output = renderEmail({
    brand: APP_EMAIL_BRAND,
    locale,
    subject: content.subject,
    preheader: content.preheader,
    blocks: content.blocks,
  });
  return { subject: content.subject, preheader: content.preheader, text: output.text, html: output.html };
}

describe("shipmentExceptionEmailContent", () => {
  it.each([
    ["pl", "Twoja przesyłka ORDER-ABC123 wyjedzie z opóźnieniem", "wysyłka potrwa trochę dłużej"],
    ["en", "We're working on your order ORDER-ABC123", "shipment is taking a little longer"],
  ] as const)("renders the selected deployment reassurance notice in %s", (locale, _subject, _reassurance) => {
    const rendered = render(shipmentExceptionEmailContent(locale, {
      firstName: "Anna",
      orderId: "order_abc123",
      ctaUrl: "https://example.test/account",
    }, APP_EMAIL_TEAM_SIGNOFF[locale]), locale);

    expect(rendered.subject).toContain("OPENLUP-ABC123");
    expect(rendered.text).toContain("OPENLUP-ABC123");
    expect(rendered.html).toContain('href="https://example.test/account"');
    expect(rendered.html).not.toMatch(/split|location|fulfillment_exception/);
  });

  it("keeps the notice actionable without a CTA", () => {
    const content = shipmentExceptionEmailContent("pl", {
      firstName: null,
      orderId: "order_abc123",
      ctaUrl: null,
    }, APP_EMAIL_TEAM_SIGNOFF.pl);
    const rendered = render(content, "pl");

    expect(content.blocks.map((block) => block.kind)).not.toContain("button");
    expect(rendered.text).toContain("Dzień dobry,");
    expect(rendered.text).toContain("nie jest potrzebne żadne działanie");
  });
});
