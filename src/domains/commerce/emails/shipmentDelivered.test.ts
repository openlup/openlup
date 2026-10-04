import { describe, expect, it, vi } from "vitest";

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { APP_EMAIL_BRAND, APP_EMAIL_TEAM_SIGNOFF } from "../../../lib/brand/appBrand.js";
import { renderEmail } from "../../communications/email/render.js";
import { shipmentDeliveredEmailContent } from "./shipmentDelivered.js";

const SITE = "https://example.test";
const TEST_LOCALES = Object.keys(APP_EMAIL_BRAND.chrome) as Locale[];

function render(content: ReturnType<typeof shipmentDeliveredEmailContent>, locale: Locale) {
  const output = renderEmail({
    brand: APP_EMAIL_BRAND,
    locale,
    subject: content.subject,
    preheader: content.preheader,
    blocks: content.blocks,
  });
  return { subject: content.subject, preheader: content.preheader, text: output.text, html: output.html };
}

describe("shipmentDeliveredEmailContent", () => {
  it.each(TEST_LOCALES)("renders selected deployment delivery copy in %s", (locale) => {
    const content = shipmentDeliveredEmailContent(locale, {
      firstName: "Anna",
      orderId: "order_abc123",
      petName: "Fistaszek",
      siteOrigin: SITE,
    }, APP_EMAIL_TEAM_SIGNOFF[locale]);
    const rendered = render(content, locale);

    expect(rendered.subject).toContain("ORDER-ABC123");
    expect(rendered.text).toContain("ORDER-ABC123");
    expect(rendered.text).toContain(`: ${SITE}/guides/getting-started.pdf`);
    expect(rendered.html).toContain(`href="${SITE}/guides/getting-started.pdf"`);
    expect(rendered.html).not.toContain("<img");
    expect(rendered.text).toContain("ORDER-ABC123");
  });

  it.each([
    ["with the companion name", "Fistaszek", "Fistaszek"],
    ["without a companion name", null, "Twój pupil"],
  ] as const)("keeps the selected result useful %s", (_name, petName, _expected) => {
    const content = shipmentDeliveredEmailContent(TEST_LOCALES[0], {
      firstName: "Anna",
      orderId: "order_abc123",
      petName,
      siteOrigin: SITE,
    }, APP_EMAIL_TEAM_SIGNOFF[TEST_LOCALES[0]]);
    const rendered = render(content, TEST_LOCALES[0]);

    expect(rendered.text).toContain("Przesyłka dostarczona");
    expect(rendered.text).toContain("ORDER-ABC123");
    // The guide card is the only call to action; no shop button, no transition box.
    const kinds = content.blocks.map((block) => block.kind);
    expect(kinds.filter((kind) => kind === "featureCard")).toHaveLength(1);
    expect(kinds).not.toContain("button");
    expect(kinds).not.toContain("accentBox");
  });
  it("forwards optional context and guide illustration through an explicit selected copy pack", async () => {
    vi.resetModules();
    const contextText = vi.fn((name: string | null) => `Synthetic context: ${name ?? "absent"}`);
    vi.doMock("#commerce-email-content", async () => {
      const actual = await vi.importActual<typeof import("#commerce-email-content")>("#commerce-email-content");
      const copy = actual.commerceEmailContent.shipmentDelivered.pl;
      return { commerceEmailContent: { ...actual.commerceEmailContent,
        shipmentDelivered: { ...actual.commerceEmailContent.shipmentDelivered, pl: { ...copy,
          startGuide: { ...copy.startGuide, path: "synthetic/guide.pdf", text: contextText,
            image: { path: "synthetic/cover.svg", alt: "Synthetic guide cover", widthPx: 100, heightPx: 80 } },
        } },
      } };
    });
    try {
      const { shipmentDeliveredEmailContent: selected } = await import("./shipmentDelivered.js");
      const output = render(selected("pl", { firstName: null, orderId: "order_abc123", petName: "Context-1",
        siteOrigin: `${SITE}/`,
      }, "Synthetic team"), "pl");
      expect(contextText).toHaveBeenCalledWith("Context-1");
      expect(output.text).toContain("Synthetic context: Context-1");
      expect(output.html).toContain(`href="${SITE}/synthetic/guide.pdf"`);
      expect(output.html).toContain(`src="${SITE}/synthetic/cover.svg"`);
      expect(output.html).not.toContain(`${SITE}//`);
    } finally {
      vi.doUnmock("#commerce-email-content");
      vi.resetModules();
    }
  });

});
