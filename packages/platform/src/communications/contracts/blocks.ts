import type { ParagraphBlock, HeadingBlock, ListBlock, AccentBoxBlock, DataRow, DataTableBlock, FeatureCardBlock, ButtonBlock, LinkParagraphBlock, DividerBlock } from "./email.js";
export type { ParagraphBlock, HeadingBlock, ListBlock, AccentBoxBlock, DataRow, DataTableBlock, FeatureCardImage, FeatureCardBlock, ButtonBlock, LinkParagraphBlock, DividerBlock, EmailBlock } from "./email.js";

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
