// Branded email renderer — the single source of the email *chrome* (logo
// header, white content card, accent boxes, CTA buttons, footer). Pure TS with
// no Node/Deno dependency. That portability was for the Deno edge senders, which
// were retired on 2026-09-04; every sender is Node now, including the Auth hook
// at server/domains/auth/authSendEmailHook.ts, and they all render here, so
// every transactional email looks identical. Reproduces the canonical
// light-theme from supabase/migrations/20260406000000_email_redesign.sql.

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import type { EmailBlock } from "./blocks.js";
import type { EmailBrand } from "../../../lib/brand/brandConfig.js";
import type { EmailTheme } from "./theme.js";

export interface RenderEmailInput {
  /** Brand look + per-locale chrome, injected by the app layer (APP_EMAIL_BRAND). */
  brand: EmailBrand;
  locale: Locale;
  subject: string;
  /** Inbox preview text; hidden in the body. */
  preheader?: string;
  blocks: EmailBlock[];
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export type EmailRenderer = (input: RenderEmailInput) => RenderedEmail;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Escape, turn intentional newlines into <br>, then apply the only two inline
 * markers the renderer understands: `**bold**` and `[text](href)`.
 *
 * Both run AFTER escaping, so the markers can never be used to inject markup:
 * by the time they match, every `<`, `>`, `&` and `"` in the source string is
 * already an entity. The link marker writes its href from the captured group,
 * which cannot contain `)` or `"`, so it cannot break out of the attribute.
 *
 * They exist because a content module otherwise cannot emphasise or link ONE
 * WORD of a sentence — only a whole block. Two places need exactly that: the
 * pet's name in body copy, and the "Wypisz się" link inside the marketing
 * fine print. Keep this list at two; a third marker means the email body has
 * become a markup language and belongs in a block kind instead.
 */
function inlineHtml(value: string): string {
  return escapeHtml(value)
    .replace(/\n/g, "<br>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

/**
 * Schemes an inline link may use. Everything else — `javascript:`, `data:`, a
 * bare path — renders as literal text instead of an anchor.
 *
 * This allowlist is the actual guard, not the character class in the pattern
 * below: by the time the marker matches, escaping has already turned any quote
 * into `&quot;`, so excluding a raw `"` would exclude nothing. Without the
 * allowlist, `[x](javascript:…)` produced a working javascript: anchor.
 */
const INLINE_LINK_SAFE_SCHEME = /^(?:https?:\/\/|mailto:)/i;

/** inlineHtml plus link support; separate because links need the theme colour. */
function inlineHtmlWithLinks(value: string, theme: EmailTheme, color: string): string {
  return inlineHtml(value).replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (match, text: string, href: string) =>
      INLINE_LINK_SAFE_SCHEME.test(href)
        ? `<a href="${href}" style="color:${color};text-decoration:underline;">${text}</a>`
        : match,
  );
}

/**
 * The two block kinds that may leave the content card, derived from EmailBlock
 * rather than imported by name. The constraint that forced this - a generated
 * Deno mirror whose fixed import prologue brought in EmailBlock and nothing
 * else, so naming ParagraphBlock/LinkParagraphBlock here compiled under Node
 * and failed under Deno - retired with the hosted-function tree on 2026-09-05.
 * The Extract stays because it is still the narrower, self-maintaining
 * spelling.
 */
type AfterCardBlock = Extract<EmailBlock, { kind: "paragraph" | "linkParagraph" }>;

/**
 * True when a block opts out of the content card. Local (not exported from
 * blocks.ts) because the generated mirror's prologue carried types only, so a
 * runtime import from blocks would not have survived generation; that generator
 * retired with the hosted-function tree on 2026-09-05. It stays local because
 * nothing outside this file needs it.
 */
function isAfterCardBlock(block: EmailBlock): block is AfterCardBlock {
  return (block.kind === "paragraph" || block.kind === "linkParagraph")
    && block.afterCard === true;
}

function renderBlockHtml(block: EmailBlock, theme: EmailTheme): string {
  switch (block.kind) {
    case "heading":
      return `<p style="color:${theme.textHeading};font-size:22px;font-weight:700;margin:0 0 20px 0;line-height:1.3;">${inlineHtml(block.text)}</p>`;
    case "paragraph": {
      const color = block.muted ? theme.textMuted : theme.textBody;
      // Below the card the copy is fine print: smaller and centred, because it
      // sits on the page background rather than inside the content card.
      const size = block.afterCard ? "11px" : block.muted ? "13px" : "15px";
      const box = block.afterCard
        ? "line-height:1.6;text-align:center;margin:0 0 8px 0;"
        : "line-height:1.7;margin:0 0 16px 0;";
      return `<p style="color:${color};font-size:${size};${box}">${inlineHtmlWithLinks(block.text, theme, color)}</p>`;
    }
    case "list": {
      const items = block.items
        .map(
          (item) =>
            `<li style="margin:0 0 6px 0;">${inlineHtml(item)}</li>`,
        )
        .join("");
      return `<ul style="color:${theme.textBody};font-size:15px;line-height:1.7;margin:0 0 16px 0;padding-left:22px;">${items}</ul>`;
    }
    case "accentBox": {
      const label = block.label
        ? `<p style="color:${theme.brand};font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;margin:0 0 8px 0;">${inlineHtml(block.label)}</p>`
        : "";
      const body = block.lines.map((line) => inlineHtml(line)).join("<br>");
      return `<table width="100%" cellpadding="0" cellspacing="0" style="border-radius:12px;border-left:4px solid ${theme.brand};background-color:${theme.accentBg};margin:0 0 20px 0;"><tr><td style="padding:20px 24px;">${label}<p style="color:${theme.textBody};font-size:14px;line-height:1.7;margin:0;">${body}</p></td></tr></table>`;
    }
    case "dataTable": {
      const rows = block.rows
        .map(
          (row) =>
            `${escapeHtml(row.label)}: <strong style="color:${theme.textHeading};">${escapeHtml(row.value)}</strong>`,
        )
        .join("<br>");
      const link = block.link
        ? `<br><a href="${escapeHtml(block.link.href)}" style="color:${theme.brand};text-decoration:underline;font-weight:600;">${escapeHtml(block.link.label)}</a>`
        : "";
      return `<table width="100%" cellpadding="0" cellspacing="0" style="border-radius:12px;border-left:4px solid ${theme.brand};background-color:${theme.accentBg};margin:0 0 20px 0;"><tr><td style="padding:20px 24px;"><p style="color:${theme.textBody};font-size:14px;line-height:1.8;margin:0;">${rows}${link}</p></td></tr></table>`;
    }
    case "featureCard": {
      const accent = theme.featureCardAccent ?? theme.brand;
      const eyebrow = block.eyebrow
        ? `<p style="margin:0 0 6px 0;font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:${accent};font-weight:700;">${inlineHtml(block.eyebrow)}</p>`
        : "";
      // Two inline-blocks that fit side by side at the full card width and wrap
      // to one column when the client is narrower: the image keeps its width,
      // the copy takes the remaining room, and no media query is involved.
      const image = block.image
        ? `<div style="display:inline-block;width:100%;max-width:${block.image.widthPx}px;vertical-align:middle;"><img src="${escapeHtml(block.image.src)}" alt="${escapeHtml(block.image.alt)}" width="${block.image.widthPx}" height="${block.image.heightPx}" style="display:block;width:100%;max-width:${block.image.widthPx}px;height:auto;margin:0 auto;color:${accent};font-size:13px;font-weight:700;font-family:${theme.fontFamily};"></div>`
        : "";
      // Copy column cap: the container width minus the content card's and this
      // card's side paddings (2x36 + 2x20 = 112), the image, and 28px of slack so
      // client rounding never wraps the pair at full width.
      const copyWidth = block.image ? `max-width:${theme.maxWidthPx - 112 - block.image.widthPx - 28}px;` : "";
      const copy = `<div style="display:inline-block;width:100%;${copyWidth}vertical-align:middle;text-align:left;padding:8px 0 0 0;">${eyebrow}<p style="margin:0 0 8px 0;font-size:18px;line-height:1.3;font-weight:700;color:${theme.textHeading};">${inlineHtml(block.title)}</p><p style="margin:0 0 14px 0;font-size:14px;line-height:1.55;color:${theme.textBody};">${inlineHtmlWithLinks(block.text, theme, theme.textBody)}</p><a href="${escapeHtml(block.cta.href)}" style="display:inline-block;background-color:${theme.brand};color:${theme.onBrand};text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:${theme.buttonRadiusPx}px;">${escapeHtml(block.cta.label)}</a></div>`;
      return `<table width="100%" cellpadding="0" cellspacing="0" style="border-radius:${theme.cardRadiusPx}px;background-color:${theme.featureCardBg ?? theme.accentBg};margin:0 0 20px 0;"><tr><td style="padding:18px 20px;text-align:center;font-size:0;">${image}${copy}</td></tr></table>`;
    }
    case "button":
      return `<table cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;"><tr><td style="background-color:${theme.brand};border-radius:${theme.buttonRadiusPx}px;"><a href="${escapeHtml(block.href)}" style="display:inline-block;padding:14px 32px;color:${theme.onBrand};font-size:14px;font-weight:700;text-decoration:none;">${escapeHtml(block.label)}</a></td></tr></table>`;
    case "linkParagraph": {
      const color = block.muted ? theme.textMuted : theme.brand;
      const size = block.afterCard ? "11px" : block.muted ? "13px" : "15px";
      const box = block.afterCard
        ? "line-height:1.6;text-align:center;margin:0 0 8px 0;"
        : "line-height:1.7;margin:0 0 16px 0;";
      return `<p style="color:${color};font-size:${size};${box}"><a href="${escapeHtml(block.href)}" style="color:${color};text-decoration:underline;">${inlineHtml(block.text)}</a></p>`;
    }
    case "divider":
      return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;"><tr><td style="border-top:1px solid ${theme.hairline};font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table>`;
  }
}

function renderBlockText(block: EmailBlock): string {
  switch (block.kind) {
    case "heading":
    case "paragraph":
      return block.text;
    case "list":
      return block.items.map((item) => `- ${item}`).join("\n");
    case "accentBox": {
      const label = block.label ? `${block.label.toUpperCase()}\n` : "";
      return `${label}${block.lines.join("\n")}`;
    }
    case "dataTable": {
      const rows = block.rows.map((row) => `${row.label}: ${row.value}`);
      if (block.link) rows.push(`${block.link.label}: ${block.link.href}`);
      return rows.join("\n");
    }
    case "featureCard": {
      const eyebrow = block.eyebrow ? `${block.eyebrow.toUpperCase()}\n` : "";
      return `${eyebrow}${block.title}\n${block.text}\n${block.cta.label}: ${block.cta.href}`;
    }
    case "button":
      return `${block.label}: ${block.href}`;
    case "linkParagraph":
      return `${block.text}: ${block.href}`;
    case "divider":
      return "—";
  }
}

function renderHtml(input: RenderEmailInput): string {
  const { locale } = input;
  const { theme } = input.brand;
  const chrome = input.brand.chrome[locale];
  const preheader = input.preheader
    ? `<span style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(input.preheader)}</span>`
    : "";
  // Blocks marked afterCard render BELOW the white card, above the footer: the
  // durable-medium legal notices that must be delivered but must not compete
  // with the message itself.
  const cardBlocks = input.blocks.filter((block) => !isAfterCardBlock(block));
  const postCardBlocks = input.blocks.filter((block) => isAfterCardBlock(block));
  const body = cardBlocks.map((block) => renderBlockHtml(block, theme)).join("");
  const postCardRow = postCardBlocks.length
    ? `<tr><td style="padding:18px 14px 0 14px;">${postCardBlocks
        .map((block) => renderBlockHtml({ ...block, muted: true }, theme))
        .join("")}</td></tr>`
    : "";

  // Header: image logo when the theme provides one (text logoText is the alt /
  // blocked-image fallback); otherwise the text wordmark.
  // Wordmark fallback, shared by both branches: this is what the header looks
  // like with no image at all, and — via the text styling copied onto the <img>
  // below — what it degrades to when a client blocks remote images. Gmail,
  // Outlook and Apple Mail all block by default for unknown senders, so the
  // blocked state is the common case, not the edge case.
  const wordmark = `<span style="font-size:32px;font-weight:900;color:${theme.brand};letter-spacing:2px;">${escapeHtml(theme.logoText)}</span>`;
  const header = theme.logoImageUrl
    // The text properties on the <img> are not decoration: mail clients apply
    // them to the alt text, so a blocked image renders "openlup" in the brand
    // colour and weight rather than small grey default text. Outlook desktop
    // ignores styled alt entirely, hence the mso conditional wordmark.
    ? `<!--[if !mso]><!--><img src="${escapeHtml(theme.logoImageUrl)}" alt="${escapeHtml(chrome.logoAlt)}"${theme.logoImageWidthPx ? ` width="${theme.logoImageWidthPx}"` : ""}${theme.logoImageHeightPx ? ` height="${theme.logoImageHeightPx}"` : ""} style="display:inline-block;border:0;${theme.logoImageHeightPx ? `height:${theme.logoImageHeightPx}px;` : ""}${theme.logoImageWidthPx ? `width:${theme.logoImageWidthPx}px;` : ""}color:${theme.brand};font-size:32px;font-weight:900;letter-spacing:2px;font-family:${theme.fontFamily};"><!--<![endif]--><!--[if mso]>${wordmark}<![endif]-->`
    : wordmark;

  // Optional full-width hero banner under the header (per-locale artwork).
  const bannerRow = chrome.bannerImageUrl
    ? `<tr><td style="padding:0 0 24px 0;"><img src="${escapeHtml(chrome.bannerImageUrl)}" alt="${escapeHtml(chrome.bannerImageAlt ?? chrome.logoAlt)}" width="${theme.maxWidthPx}" style="display:block;width:100%;max-width:${theme.maxWidthPx}px;height:auto;border:0;border-radius:12px;"></td></tr>`
    : "";

  // Footer: optional tagline + optional legal fine print. Omitted entirely when
  // the brand supplies neither.
  const footerParts: string[] = [];
  if (chrome.footerTagline) {
    footerParts.push(
      `<p style="color:${theme.textMuted};font-size:12px;margin:0 0 10px 0;">${escapeHtml(chrome.footerTagline)}</p>`,
    );
  }
  if (chrome.footerLegalLines?.length) {
    footerParts.push(
      `<p style="color:${theme.textMuted};font-size:11px;line-height:1.6;margin:0;">${chrome.footerLegalLines.map((line) => escapeHtml(line)).join("<br>")}</p>`,
    );
  }
  const footerRow = footerParts.length
    ? `<tr><td style="padding:24px 0 0 0;text-align:center;">${footerParts.join("")}</td></tr>`
    : "";

  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1"></head>',
    `<body style="margin:0;padding:0;background-color:${theme.bodyBg};font-family:${theme.fontFamily};">`,
    preheader,
    `<table width="100%" cellpadding="0" cellspacing="0" style="background-color:${theme.bodyBg};"><tr><td align="center" style="padding:40px 20px;">`,
    `<table width="${theme.maxWidthPx}" cellpadding="0" cellspacing="0" style="max-width:${theme.maxWidthPx}px;width:100%;">`,
    `<tr><td style="padding:0 0 24px 0;text-align:center;">${header}</td></tr>`,
    bannerRow,
    `<tr><td style="background-color:${theme.cardBg};border-radius:${theme.cardRadiusPx}px;padding:36px 36px 40px 36px;">${body}</td></tr>`,
    postCardRow,
    footerRow,
    "</table></td></tr></table></body></html>",
  ].join("");
}

function renderText(input: RenderEmailInput): string {
  const chrome = input.brand.chrome[input.locale];
  const body = input.blocks
    .map((block) => renderBlockText(block))
    .filter((part) => part.length > 0)
    .join("\n\n");
  const footerLines = [chrome.footerTagline, ...(chrome.footerLegalLines ?? [])].filter(
    (line): line is string => typeof line === "string" && line.length > 0,
  );
  return footerLines.length ? `${body}\n\n${footerLines.join("\n")}` : body;
}

export const renderEmail: EmailRenderer = (input) => ({
  subject: input.subject,
  html: renderHtml(input),
  text: renderText(input),
});
