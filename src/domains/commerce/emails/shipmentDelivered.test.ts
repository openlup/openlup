import { describe, expect, it } from "vitest";

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

    expect(rendered.subject).toContain("OPENLUP-ABC123");
    expect(rendered.text).toContain("OPENLUP-ABC123");
    expect(rendered.text).toContain(`: ${SITE}/porady/pliki/jak-wprowadzic-nowa-karme.pdf`);
    expect(rendered.html).toContain(`href="${SITE}/porady/pliki/jak-wprowadzic-nowa-karme.pdf"`);
    expect(rendered.html).toContain(`src="${SITE}/porady/pliki/okladka-jak-wprowadzic-nowa-karme.jpg"`);
    expect(rendered.text).toContain("Fistaszek");
  });

  it.each([
    ["with the companion name", "Fistaszek", "Fistaszek"],
    ["without a companion name", null, "Twój pupil"],
  ] as const)("keeps the selected result useful %s", (_name, petName, expected) => {
    const content = shipmentDeliveredEmailContent(TEST_LOCALES[0], {
      firstName: "Anna",
      orderId: "order_abc123",
      petName,
      siteOrigin: SITE,
    }, APP_EMAIL_TEAM_SIGNOFF[TEST_LOCALES[0]]);
    const rendered = render(content, TEST_LOCALES[0]);

    expect(rendered.text).toContain("Paczka dostarczona");
    expect(rendered.text).toContain(expected);
    // The guide card is the only call to action; no shop button, no transition box.
    const kinds = content.blocks.map((block) => block.kind);
    expect(kinds.filter((kind) => kind === "featureCard")).toHaveLength(1);
    expect(kinds).not.toContain("button");
    expect(kinds).not.toContain("accentBox");
  });
});
