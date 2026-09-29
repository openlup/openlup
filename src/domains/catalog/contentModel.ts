/**
 * Catalog content shapes that belong to the platform contract rather than to a
 * deployment's rows.
 *
 * The deployment's catalog content module holds its authored content; the
 * *shape* of an ingredient card is the same for every adopter, so it lives here
 * and the content module re-exports it. Seam precedent: the line-gamma
 * declaration move.
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
