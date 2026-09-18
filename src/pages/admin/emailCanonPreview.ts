// Browser-side preview facade for code-rendered canonical emails. DB-template
// rows preview from stored HTML; commerce + subscription previews live in the
// split registry below so this public module stays small and stable.

import { CANON_PREVIEW_RENDERERS } from "./email-canon-preview";

/** True when a code-rendered preview exists for this slug. */
export function hasCanonPreview(slug: string): boolean {
  return slug in CANON_PREVIEW_RENDERERS;
}

/**
 * Render the code-based preview for a slug, or null when none exists (DB
 * templates and emails with no code preview renderer). Rendering is lazy and
 * uses sample data.
 */
export function renderCanonPreview(
  slug: string,
): { subject: string; html: string } | null {
  const render = CANON_PREVIEW_RENDERERS[slug];
  if (!render) return null;
  const { subject, html } = render();
  return { subject, html };
}
