import type { StorefrontItem } from "./storefrontItemModel.js";

export const STOREFRONT_SSG_LOCALES = ["pl", "en"] as const;
export type StorefrontSsgLocale = typeof STOREFRONT_SSG_LOCALES[number];
export type StorefrontSsgProductSlug = string;

export interface StorefrontSsgFaq {
  key: string;
  question: string;
  answer: string;
}

/**
 * Small, deployment-supplied visual tokens needed by the shared storefront
 * consumers. They describe presentation, never a deployment route registry.
 */
export interface StorefrontSsgPresentation {
  heroBackground: string;
  cardBackground: string;
}

/**
 * Primary trade identity carried by a deployment-supplied storefront snapshot.
 * This is deliberately product-neutral: callers get facts, not an overlay
 * pricing or inventory projection.
 */
export interface StorefrontSsgPrimarySku {
  code: string;
  primaryUnitGtin: string;
  netContent: {
    unscaled: number;
    scale: number;
    unit: string;
  };
  sellability: {
    oneTime: boolean;
    subscription: boolean;
  };
}

export type StorefrontSsgSummaryItem = Pick<StorefrontItem,
  "slug" | "name" | "status" | "lineName" | "species" | "format" | "weight" |
  "color" | "colorVar" | "heroImage" | "heroImageLcp" | "galleryImages" |
  "tagline" | "badges" | "claim" | "idealFor" | "energyPer100g"
>;

export type StorefrontSsgDetailItem = Pick<StorefrontItem,
  "ingredients" | "ingredientCards" | "supplements" | "supplementsList" |
  "analytics" | "servingGuide" | "servingNote" | "servingExtra" | "storage" |
  "manufacturer" | "approvalNumber" | "madeIn" | "transitionCallout"
>;

export interface StorefrontSsgProductDetails {
  locale: StorefrontSsgLocale;
  productSlug: string;
  item: StorefrontSsgDetailItem;
  faq: readonly StorefrontSsgFaq[];
}

export interface StorefrontSsgProduct {
  item: StorefrontSsgSummaryItem;
  primarySku: StorefrontSsgPrimarySku;
  /** Localized public destination for this item; not an application RouteKey. */
  routePath: string;
  /** Localized compact name for switchers and related-item cards. */
  shortName: string;
  presentation: StorefrontSsgPresentation;
  /** Whole percent derived from composition entries marked `proteinBase`. */
  proteinBasePercent: number;
  subtitle: string;
  description: string;
  faq?: readonly StorefrontSsgFaq[];
}

export interface StorefrontSsgCatalog {
  productSlugs: readonly StorefrontSsgProductSlug[];
  slugMap: Readonly<Record<string, StorefrontSsgProductSlug>>;
  productsByLocale: Readonly<Record<StorefrontSsgLocale, Readonly<Record<StorefrontSsgProductSlug, StorefrontSsgProduct>>>>;
}

export function productFromStorefrontSsgCatalog(
  catalog: StorefrontSsgCatalog,
  slug: string,
  locale: StorefrontSsgLocale,
): StorefrontSsgProduct | undefined {
  const resolved = catalog.slugMap[slug] ?? slug;
  return catalog.productsByLocale[locale][resolved];
}

export function detailsFromStorefrontSsgCatalog(
  details: readonly StorefrontSsgProductDetails[],
  slug: string,
  locale: StorefrontSsgLocale,
): StorefrontSsgProductDetails | undefined {
  return details.find((entry) => entry.locale === locale && entry.productSlug === slug);
}
