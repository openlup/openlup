import { describe, expect, it } from "vitest";
import { divider, linkParagraph } from "./blocks.js";
import { marketingUnsubscribeFooter } from "./marketingFooter.js";
import { renderEmail } from "./render.js";
import { APP_EMAIL_BRAND } from "../../../lib/brand/appBrand.js";

describe("linkParagraph block + renderer", () => {
  it("builds a linkParagraph block with defaults", () => {
    const block = linkParagraph("Click here", "https://example.com/x");
    expect(block).toEqual({
      kind: "linkParagraph",
      text: "Click here",
      href: "https://example.com/x",
      muted: false,
    });
  });

  it("renders an escaped <a href> inside a paragraph", () => {
    const out = renderEmail({
      brand: APP_EMAIL_BRAND,
      locale: "pl",
      subject: "T",
      blocks: [linkParagraph("Klik & <go>", 'https://e.com/?a=1&b="2"')],
    });
    expect(out.html).toContain('<a href="https://e.com/?a=1&amp;b=&quot;2&quot;"');
    expect(out.html).toContain("Klik &amp; &lt;go&gt;");
    // text form is "text: href"
    expect(out.text).toContain('Klik & <go>: https://e.com/?a=1&b="2"');
  });

  it("uses the brand colour when not muted and muted colour when muted", () => {
    const normal = renderEmail({
      brand: APP_EMAIL_BRAND,
      locale: "pl",
      subject: "T",
      blocks: [linkParagraph("hi", "https://e.com")],
    });
    expect(normal.html).toContain(`color:${APP_EMAIL_BRAND.theme.brand}`);

    const muted = renderEmail({
      brand: APP_EMAIL_BRAND,
      locale: "pl",
      subject: "T",
      blocks: [linkParagraph("hi", "https://e.com", { muted: true })],
    });
    expect(muted.html).toContain(`color:${APP_EMAIL_BRAND.theme.textMuted}`);
    expect(muted.html).toContain("font-size:13px");
  });
});

describe("marketingUnsubscribeFooter", () => {
  it("returns a divider then a muted unsubscribe linkParagraph (PL)", () => {
    const blocks = marketingUnsubscribeFooter("pl", "https://fn.example/unsubscribe?token=abc");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual(divider());
    expect(blocks[1]).toEqual(
      linkParagraph(
        "Nie chcesz tych wiadomości? Zrezygnuj.",
        "https://fn.example/unsubscribe?token=abc",
        { muted: true },
      ),
    );
  });

  it("uses English copy for locale en", () => {
    const blocks = marketingUnsubscribeFooter("en", "https://fn.example/unsubscribe?token=abc&lang=en");
    expect(blocks[1]).toMatchObject({
      kind: "linkParagraph",
      text: "Don't want these? Unsubscribe.",
      muted: true,
    });
  });

  it("renders into the email with the unsubscribe link present", () => {
    const out = renderEmail({
      brand: APP_EMAIL_BRAND,
      locale: "en",
      subject: "Deal",
      blocks: marketingUnsubscribeFooter("en", "https://fn.example/unsubscribe?token=tok"),
    });
    expect(out.html).toContain('href="https://fn.example/unsubscribe?token=tok"');
    expect(out.html).toContain("Don't want these? Unsubscribe.");
    expect(out.text).toContain("Unsubscribe.: https://fn.example/unsubscribe?token=tok");
  });
});
