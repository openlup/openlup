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
   * `[text](href)` — see inlineHtml in render.ts for why only those two.
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

export const paragraph = (
  text: string,
  opts: { muted?: boolean; afterCard?: boolean } = {},
): ParagraphBlock => ({
  kind: "paragraph",
  text,
  muted: opts.muted ?? false,
  ...(opts.afterCard ? { afterCard: true } : {}),
});

export const heading = (text: string): HeadingBlock => ({ kind: "heading", text });

export const list = (items: string[]): ListBlock => ({ kind: "list", items });

export const accentBox = (
  lines: string[],
  opts: { label?: string } = {},
): AccentBoxBlock => ({ kind: "accentBox", label: opts.label, lines });

export const dataTable = (
  rows: DataRow[],
  opts: { link?: { label: string; href: string } } = {},
): DataTableBlock => ({ kind: "dataTable", rows, ...(opts.link ? { link: opts.link } : {}) });

export const featureCard = (card: Omit<FeatureCardBlock, "kind">): FeatureCardBlock => ({
  kind: "featureCard",
  ...card,
});

export const button = (label: string, href: string): ButtonBlock => ({ kind: "button", label, href });

export const linkParagraph = (
  text: string,
  href: string,
  opts: { muted?: boolean; afterCard?: boolean } = {},
): LinkParagraphBlock => ({
  kind: "linkParagraph",
  text,
  href,
  muted: opts.muted ?? false,
  ...(opts.afterCard ? { afterCard: true } : {}),
});

export const divider = (): DividerBlock => ({ kind: "divider" });
