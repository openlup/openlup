import { COMMERCE_CANON_PREVIEW_RENDERERS } from "./commerceRenderers";
import { SUBSCRIPTION_CANON_PREVIEW_RENDERERS } from "./subscriptionRenderers";
import type { CanonPreviewRenderer } from "./shared";

/**
 * Slug -> preview renderer. Keys are canon slugs (and the dunning pattern's
 * display slug used in the table). Each thunk renders lazily, only when the
 * admin opens a preview.
 */
export const CANON_PREVIEW_RENDERERS: Record<string, CanonPreviewRenderer> = {
  ...COMMERCE_CANON_PREVIEW_RENDERERS,
  ...SUBSCRIPTION_CANON_PREVIEW_RENDERERS,
};
