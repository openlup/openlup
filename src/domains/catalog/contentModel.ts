/**
 * Catalog content shapes that belong to the platform contract rather than to a
 * deployment's rows.
 *
 * `src/data/catalogContent.ts` holds this deployment's authored content; the
 * *shape* of an ingredient card is the same for every adopter, so it lives here
 * and the content module re-exports it. Seam precedent: the line-gamma
 * declaration move (`docs/plan/oss-line-gamma-checkout-move.md`), sized for this
 * wave in `docs/plan/oss-w3-seams-sizing.md` section 1.3 (a).
 */
import type { CatalogAllergenSlug } from "./types.js";

/** One composition card: a named component of an item with its share and role copy. */
export interface CatalogContentIngredientCard {
  name: string;
  pct: string;
  role: string;
  body: string;
  claimPill?: string;
  nameKey?: string;
  roleKey?: string;
  bodyKey?: string;
  claimPillKey?: string;
  allergenSlugs: CatalogAllergenSlug[];
}
