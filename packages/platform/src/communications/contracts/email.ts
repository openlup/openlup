export type Locale = "pl" | "en";

// Content blocks — the public contract a business domain (commerce,
// subscription, accounting, …) uses to compose an email body. A content module
// returns ordered blocks; the renderer turns them into branded HTML + text.
// Domains import ONLY these builders/types cross-domain (see the architecture
// guardrail whitelist for the `email` segment) — never render.ts internals.
//
// Builders are thin typed constructors: they keep call sites readable and let
// the block shape evolve without touching every content module.

export interface ParagraphBlock {
  kind: "paragraph";
  /**
   * Plain text. A literal "\n" becomes a <br> in HTML and stays a newline in
   * text. Two inline markers are honoured in HTML: `**bold**` and
   * Markdown link syntax — see inlineHtml in render.ts for why only those two.
   */
  text: string;
  /** Render in the muted/secondary colour at a smaller size (fine print). */
  muted?: boolean;
  /**
   * Render BELOW the white content card, above the footer, as centred 11px
   * fine print. For notices that must be delivered on a durable medium but must
   * not compete with the message — the consumer-withdrawal paragraph on the
   * paid-order mail, the marketing unsubscribe line. Ignored in the text part,
   * where ordering already carries the same meaning.
   */
  afterCard?: boolean;
}

export interface HeadingBlock {
  kind: "heading";
  text: string;
}

export interface ListBlock {
  kind: "list";
  items: string[];
}

export interface AccentBoxBlock {
  kind: "accentBox";
  /** Optional uppercase eyebrow label in the brand colour. */
  label?: string;
  /** Body lines, rendered one per line. */
  lines: string[];
}

export interface DataRow {
  label: string;
  value: string;
}

export interface DataTableBlock {
  kind: "dataTable";
  /** Rendered inside an accent box as "label: <strong>value</strong>" lines. */
  rows: DataRow[];
  /** Optional text link rendered as the box's last line (a carrier tracking page next to its number). */
  link?: { label: string; href: string };
}

export interface FeatureCardImage {
  /** Absolute HTTPS URL of the illustration. */
  src: string;
  /** Blocked-image fallback, rendered in the card's accent colour. */
  alt: string;
  widthPx: number;
  heightPx: number;
}

export interface FeatureCardBlock {
  kind: "featureCard";
  /** Optional uppercase eyebrow above the title. */
  eyebrow?: string;
  title: string;
  /** Body copy; the paragraph inline markers apply. */
  text: string;
  cta: { label: string; href: string };
  /**
   * Optional illustration. It sits beside the copy on a wide client and above
   * it on a narrow one - a fluid layout with no media query, so it also holds
   * in clients that drop <style>.
   */
  image?: FeatureCardImage;
}

export interface ButtonBlock {
  kind: "button";
  label: string;
  href: string;
}

export interface LinkParagraphBlock {
  kind: "linkParagraph";
  /** Inline copy rendered as a single clickable <a href> inside a paragraph. */
  text: string;
  href: string;
  /** Render in the muted/secondary colour at fine-print size (footer links). */
  muted?: boolean;
  /** See ParagraphBlock.afterCard. */
  afterCard?: boolean;
}

export interface DividerBlock {
  kind: "divider";
}

export type EmailBlock =
  | ParagraphBlock
  | HeadingBlock
  | ListBlock
  | AccentBoxBlock
  | DataTableBlock
  | FeatureCardBlock
  | ButtonBlock
  | LinkParagraphBlock
  | DividerBlock;


export interface EmailTheme {
  /** Outer page background (warm cream). */
  bodyBg: string;
  /** Content card background. */
  cardBg: string;
  /** Accent-box background (light teal tint). */
  accentBg: string;
  /** Accent-box / divider hairline. */
  hairline: string;
  /** Primary brand colour (teal): logo, links, buttons, accent border. */
  brand: string;
  /** Text colour on top of the brand colour (e.g. button label). */
  onBrand: string;
  /** Heading text. */
  textHeading: string;
  /** Body copy. */
  textBody: string;
  /** Muted/secondary text (footer, fine print). */
  textMuted: string;
  /** Font stack — system fonts only, for broad client support. */
  fontFamily: string;
  /** Text logo rendered in the header, and the alt/fallback shown when an image
   *  logo is set but blocked by the client. */
  logoText: string;
  /** Optional hosted logo image URL (absolute HTTPS). When set, the header
   *  renders an <img> (with logoText as the alt fallback) instead of the text
   *  wordmark. Left undefined by forks that prefer the text logo. */
  logoImageUrl?: string;
  /** Displayed logo height in px (width auto-scales). Used for the width/height
   *  attributes that keep layout stable when the image is blocked. */
  logoImageHeightPx?: number;
  /** Displayed logo width in px (paired with logoImageHeightPx for the attrs). */
  logoImageWidthPx?: number;
  /** Optional feature-card background; falls back to accentBg. Set it when the
   *  card's illustration carries its own background that must match. */
  featureCardBg?: string;
  /** Optional feature-card eyebrow and alt-text colour; falls back to brand. */
  featureCardAccent?: string;
  /** Content card corner radius, px. */
  cardRadiusPx: number;
  /** Button corner radius, px. */
  buttonRadiusPx: number;
  /** Max content width, px. */
  maxWidthPx: number;
}
export interface EmailChromeStrings {
  /** Optional footer tagline under the content card. Left undefined by brands
   *  that show only the legal fine print (see footerLegalLines). */
  footerTagline?: string;
  /** Accessible alt text for the logo (also the fallback when an image logo is
   *  blocked). */
  logoAlt: string;
  /** Optional hosted hero-banner image URL (absolute HTTPS), rendered full-width
   *  under the header. Each locale can carry different artwork. */
  bannerImageUrl?: string;
  /** Alt text for the banner image (shown when the image is blocked). */
  bannerImageAlt?: string;
  /** Optional legal fine-print lines rendered in the footer (company
   *  identification, e.g. art. 206 KSH). Each entry is one line. */
  footerLegalLines?: string[];
}
export interface EmailBrand {
  /** Brand label used in email copy when it intentionally differs from logo rendering. */
  copyBrandName: string;
  /**
   * Softer, mixed-case brand label for in-body copy (e.g. "openlup"). Distinct from
   * the all-caps chrome/sign-off form (copyBrandName, "OPENLUP"). Optional: callers
   * fall back to copyBrandName when a brand does not define a cased variant.
   */
  copyBrandNameCased?: string;
  theme: EmailTheme;
  chrome: Record<Locale, EmailChromeStrings>;
}
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
