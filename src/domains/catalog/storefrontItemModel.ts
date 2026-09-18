/**
 * The storefront item contract: the shape a detail page renders, independent of
 * which deployment supplies the rows.
 *
 * Two layers, on purpose (`docs/plan/oss-w3-seams-sizing.md` section 1.5, "the
 * vertical-fields cut"):
 *
 * - `StorefrontItem` — this module. Every field here is subject-neutral: an
 *   adopter selling coffee, supplements or paint fills the same slots.
 * - the deployment's own extension — `src/data/products.ts`, which adds the
 *   fields that only make sense for this deployment's line and keeps supplying
 *   the rows.
 *
 * A component that renders only neutral fields names this module and never the
 * deployment's data module, which is what dissolves its dependency on rows it
 * does not read.
 */
import type { CatalogContentIngredientCard } from "./contentModel.js";

export type StorefrontItemStatus = "available" | "coming_soon";

/** One row of a declared-composition table: label, share, and dry-matter share. */
export interface AnalyticsRow {
  name: string;
  pct: string;
  dm: string | null;
}

/** One row of a serving table: the buyer-side band, the count, and the mass. */
export interface ServingGuideRow {
  weight: string;
  amount: string;
  grams: string;
}

/** One gallery slot: an already-resolved image URL and its i18n label key. */
export interface StorefrontGalleryImage {
  src: string;
  label: string;
}

/** A short labelled aside rendered next to a section body. */
export interface StorefrontCallout {
  label: string;
  title: string;
  body: string;
}

export type IngredientCard = CatalogContentIngredientCard;

export interface StorefrontItem {
  slug: string;
  name: string;
  status?: StorefrontItemStatus;
  lineName: string;
  species: string;
  format: string;
  weight: string;
  color: string;
  colorVar: string;
  heroImage: string;
  heroImageEn?: string;
  heroImageLcp?: string;
  heroImageEnLcp?: string;
  galleryImages: StorefrontGalleryImage[];
  galleryImagesEn?: StorefrontGalleryImage[];
  tagline: string;
  badges: string[];
  claim: string;
  idealFor?: string[];
  ingredients: string;
  ingredientsEn?: string;
  ingredientCards: IngredientCard[];
  supplements: {
    IU_kg: string;
    mg_kg: string;
    ug_kg: string;
    note?: string;
  };
  supplementsList?: { nameKey: string; value: string; roleKey: string }[];
  analytics: AnalyticsRow[];
  energyPer100g: number | null;
  servingGuide: ServingGuideRow[];
  servingNote: string;
  servingExtra?: StorefrontCallout;
  storage: string;
  manufacturer: string;
  approvalNumber: string;
  madeIn: string;
  transitionCallout?: string;
  transitionIntro?: string;
  transitionTips?: { title: string; body: string }[];
  nutritionExtra?: StorefrontCallout;
}
