/** @vitest-environment jsdom -- exercises browser-path behavior (window/storage/DOM). */
import { describe, expect, it } from "vitest";
import {
  buildEmailTemplatePreviewSrcDoc,
  renderEmailTemplatePreviewHtml,
  sanitizeEmailTemplatePreviewHtml,
} from "./emailTemplatePreview";

describe("email template preview hardening", () => {
  it("substitutes sample variables for admin preview", () => {
    expect(renderEmailTemplatePreviewHtml("<p>Czesc {{first_name}} z {{city}}</p>"))
      .toBe("<p>Czesc Jan z Warszawa</p>");
  });

  it("removes executable HTML before it reaches the preview frame", () => {
    const html = sanitizeEmailTemplatePreviewHtml(
      [
        '<img src="javascript:alert(1)" onerror="window.pwned=true">',
        '<img src="data:image/svg+xml;base64,PHN2Zz4=">',
        '<a href="javascript:alert(2)">link</a>',
        '<iframe srcdoc="<script>alert(3)</script>"></iframe>',
        '<svg><animate attributeName="x"></animate></svg>',
        '<math><mi>x</mi></math>',
        "<script>window.pwned=true</script>",
        '<p onclick="alert(4)" style="background:url(javascript:alert(5))">Safe text</p>',
      ].join(""),
    );

    expect(html).toContain("<img>");
    expect(html).toContain("<a>link</a>");
    expect(html).toContain("<p>Safe text</p>");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("script");
    expect(html).not.toContain("iframe");
    expect(html).not.toContain("svg");
    expect(html).not.toContain("math");
    expect(html).not.toContain("srcdoc");
    expect(html).not.toContain("style=");
    expect(html).not.toContain("data:image/svg");
  });

  it("wraps sanitized markup in a srcdoc document for sandboxed iframe rendering", () => {
    const srcDoc = buildEmailTemplatePreviewSrcDoc('<p onclick="alert(1)">Hej {{dog_name}}</p>');

    expect(srcDoc).toContain("<!doctype html>");
    expect(srcDoc).toContain("<p>Hej Burek</p>");
    expect(srcDoc).not.toContain("onclick");
  });
});